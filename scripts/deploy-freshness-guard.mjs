#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// Deploy freshness guard.
//
// `npm run build` (via @cloudflare/vite-plugin) rewrites
// .wrangler/deploy/config.json so that wrangler redirects its config to
// build/server/wrangler.json. A bare `wrangler deploy` therefore uploads
// whatever is already sitting in build/ WITHOUT building — it silently ships a
// stale artifact. This guard is injected into that generated config as
// `build.command` (see scripts/inject-deploy-guard.mjs) and refuses to let such
// a deploy through when the build output is older than the sources.
//
// Deliberately an assertion, not a rebuild: it never builds anything, it only
// says "this is stale, here is how to fix it".
//
// Escape hatch: ALLOW_STALE_DEPLOY=1

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, never from cwd: wrangler may run the command with a
// cwd of build/server/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Is this a command that actually uploads the local build output? ──────
//
// wrangler exports WRANGLER_COMMAND into the environment of the custom build
// child process. Measured with wrangler 4.107.0:
//
//   wrangler deploy             → "deploy"
//   wrangler versions upload    → "versions upload"
//   wrangler dev                → "dev"
//   wrangler types              → the command is never run at all
//
// Everything else — and anything we cannot classify with certainty — passes
// through silently. A false positive here would break `wrangler types` (which
// `npm run typecheck` depends on), so the default is always "let it through".
//
// If a future wrangler renames these values the guard simply stops firing; it
// can never fire on the wrong command, which is the failure mode we care about.
const UPLOADING_COMMANDS = new Set(["deploy", "versions upload"]);
const command = process.env.WRANGLER_COMMAND;
if (!UPLOADING_COMMANDS.has(command)) process.exit(0);
if (process.env.ALLOW_STALE_DEPLOY) {
	console.log("[deploy-guard] ALLOW_STALE_DEPLOY is set — skipping the freshness check.");
	process.exit(0);
}

// ── 2. Artifacts must exist at all ─────────────────────────────────────────
//
// Both files below are rewritten by `npm run build` on every single run.
// Note there is deliberately no build/client/index.html here: this app renders
// fully on the server and never prerenders, so that file does not exist (the
// client build only emits assets, see build/client/.assetsignore). Asserting on
// it would fail every healthy deploy.
const ARTIFACTS = ["build/server/index.js", "build/server/wrangler.json"];
const MISSING = ARTIFACTS.filter((p) => !existsSync(join(ROOT, p)));
// build/client/ must exist too, but its contents are hashed per build; check
// the directory rather than a filename so a stale name can never wedge a
// healthy deploy.
if (!existsSync(join(ROOT, "build", "client"))) MISSING.push("build/client/");

if (MISSING.length > 0) {
	console.error(
		[
			"",
			"✗ deploy-guard: no usable build output (missing: " + MISSING.join(", ") + ").",
			"  You are about to deploy a stale or empty build/ — refusing.",
			"",
			"  Fix it with one of:",
			"    npm run deploy        ← recommended (builds first, then deploys)",
			"    npm run build && wrangler deploy",
			"",
			"  Override (you almost certainly do not want this): ALLOW_STALE_DEPLOY=1",
			"",
		].join("\n"),
	);
	process.exit(1);
}

// ── 3. Freshness: newest source mtime vs oldest artifact mtime ─────────────
//
// `public/` is Vite's static asset directory (this project does not override
// publicDir, so the default applies) and everything in it is copied verbatim
// into build/client/ and uploaded as part of `assets.directory`. It is an input
// to the client artifact, so it has to be watched — otherwise editing only a
// static file (e.g. public/favicon.svg) would leave the guard silent and a bare
// `wrangler deploy` would still ship the old asset.
const SOURCE_DIRS = ["workers", "app", "shared", "public"];
const SOURCE_FILES = ["wrangler.jsonc", "package.json", "react-router.config.ts", "vite.config.ts"];

const SKIP_DIRS = new Set(["node_modules", ".git", "build", ".wrangler", ".react-router", "dist"]);

function collectNewest(dir, best, limit = 4000) {
	let seen = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				stack.push(full);
			} else if (entry.isFile()) {
				seen += 1;
				if (seen > limit) return best;
				const mtime = statSync(full).mtimeMs;
				if (mtime > best.mtime) best = { path: full, mtime };
			}
		}
	}
	return best;
}

let newest = { path: "", mtime: 0 };
const newestSources = [];
for (const dir of SOURCE_DIRS) {
	const full = join(ROOT, dir);
	if (existsSync(full)) newest = collectNewest(full, newest);
}
newestSources.push(newest);
for (const file of SOURCE_FILES) {
	const full = join(ROOT, file);
	if (!existsSync(full)) continue;
	const mtime = statSync(full).mtimeMs;
	newestSources.push({ path: full, mtime });
}
const newestSource = newestSources.reduce((a, b) => (b.mtime > a.mtime ? b : a), { path: "", mtime: 0 });
const oldestArtifact = ARTIFACTS.map((p) => ({ path: join(ROOT, p), mtime: statSync(join(ROOT, p)).mtimeMs })).reduce(
	(a, b) => (b.mtime < a.mtime ? b : a),
);

if (newestSource.mtime <= oldestArtifact.mtime) process.exit(0); // fresh → stay quiet

const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
const rel = (p) => p.slice(ROOT.length + 1);

console.error(
	[
		"",
		"✗ deploy-guard: build/ is OLDER than the sources — this deploy would ship a stale artifact.",
		"",
		"  Newest source    " + when(newestSource.mtime) + "  " + rel(newestSource.path),
		"  Oldest artifact  " + when(oldestArtifact.mtime) + "  " + rel(oldestArtifact.path),
		"",
		"  Fix it with one of:",
		"    npm run build && wrangler deploy    ← rebuild, then retry this command",
		"    npm run deploy                      ← recommended (does both)",
		"",
		"  Override (you almost certainly do not want this): ALLOW_STALE_DEPLOY=1",
		"",
	].join("\n"),
);
process.exit(1);
