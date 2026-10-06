#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// Injects the deploy freshness guard into the *generated* wrangler config.
//
// Why here and not in wrangler.jsonc: under @cloudflare/vite-plugin the plugin
// deletes the `build` key while generating build/server/wrangler.json, so a
// `build.command` in the hand-written config is silently dropped (official
// docs: "Not applicable if you're using the Cloudflare Vite plugin"). The
// generated file is the config wrangler actually redirects to, so the guard has
// to live there — and `npm run build` has to re-inject it every time, because
// the plugin rewrites that file from scratch on each build.
//
// Run it after every build. It is idempotent and never fails a build that has
// no output yet (--skip-build style runs).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "build", "server", "wrangler.json");
const GUARD = "scripts/deploy-freshness-guard.mjs";

if (!existsSync(CONFIG)) {
	// A build that produced no worker output (e.g. `react-router build --help`,
	// or a failure that npm already reported) is not this script's problem.
	console.log(`[deploy-guard] ${CONFIG.slice(ROOT.length + 1)} not found — nothing to patch.`);
	process.exit(0);
}

let config;
try {
	config = JSON.parse(readFileSync(CONFIG, "utf8"));
} catch (error) {
	console.error(`[deploy-guard] ${CONFIG.slice(ROOT.length + 1)} is not valid JSON: ${error.message}`);
	process.exit(1);
}
if (config === null || typeof config !== "object" || Array.isArray(config)) {
	console.error(`[deploy-guard] ${CONFIG.slice(ROOT.length + 1)} is not a JSON object — refusing to patch.`);
	process.exit(1);
}

// Replace only the `build` key; every other key is carried over untouched.
config.build = { command: `node ${GUARD}`, cwd: ROOT };

const next = `${JSON.stringify(config, null, 2)}\n`;
const previous = readFileSync(CONFIG, "utf8");
if (previous !== next) writeFileSync(CONFIG, next);

// Self-check: never let a config we cannot re-read reach a deploy.
try {
	const check = JSON.parse(readFileSync(CONFIG, "utf8"));
	if (typeof check?.build?.command !== "string" || check.build.command.length === 0) {
		throw new Error("build.command is missing after the write");
	}
} catch (error) {
	console.error(`[deploy-guard] failed to inject the guard into ${CONFIG.slice(ROOT.length + 1)}: ${error.message}`);
	process.exit(1);
}

console.log(
	previous === next
		? `[deploy-guard] guard already present in build/server/wrangler.json (${GUARD}).`
		: `[deploy-guard] guard injected into build/server/wrangler.json (${GUARD}).`,
);
