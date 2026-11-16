#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// ─────────────────────────────────────────────────────────────────────────────
//  Deploy the PUBLIC READ-ONLY DEMO worker (`mailboxes-demo`)
// ─────────────────────────────────────────────────────────────────────────────
//
//   node scripts/deploy-demo.mjs                # build + migrate + deploy
//   node scripts/deploy-demo.mjs --with-seed    # ... and re-seed the demo data
//   node scripts/deploy-demo.mjs --dry-run      # report the plan, change nothing
//   node scripts/deploy-demo.mjs --d1-id <uuid> # skip the D1 lookup (offline CI)
//   node scripts/deploy-demo.mjs --keep-temp    # keep the build directory
//
// Idempotent: running it twice in a row is safe. Existing D1 / R2 resources are
// reused (never recreated, never deleted), migrations only apply what is pending,
// and the deploy just replaces the version.
//
// ── Why a temp directory, and not `wrangler deploy -c wrangler.demo.jsonc` ──
//
// `npm run build` makes @cloudflare/vite-plugin write `.wrangler/deploy/config.json`
// (`{"configPath":"../../build/server/wrangler.json"}`). Once that file exists,
// ANY `wrangler deploy` run from the repo root redirects its configuration to
// build/server/wrangler.json — which is generated from the repo's *production*
// `wrangler.jsonc`, i.e. `name: mailboxes`. Deploying the demo config from the
// repo root is therefore a coin flip between "uploads a stale production build"
// and "uploads demo bindings under the production name" (docs/demo-site-plan.md
// §1.4, §6 step 3, §8 risk 2).
//
// So this script never deploys from the repo root:
//
//   1. copies the working tree to a fresh `mkdtemp` directory (no .git, no
//      build/, no .wrangler/ — the redirect file simply does not exist there),
//   2. writes the *demo* config in that directory as `wrangler.jsonc`, with the
//      real database id substituted in (the repo's `wrangler.demo.jsonc` keeps
//      its all-zero placeholder — the real id is never written into the repo),
//   3. builds, migrates and deploys from inside that directory,
//   4. asserts the generated build/server/wrangler.json is `mailboxes-demo`
//      bound to the demo database and the demo bucket BEFORE uploading, so a
//      misconfigured run fails loudly instead of touching production.
//
// The last point is the real safety net: `assertDemoBuild()` refuses to deploy
// unless name / D1 id / bucket / DEMO_MODE / cron all match the demo, and the
// worker has no AI binding.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Demo resource names (docs/demo-site-plan.md §1) ────────────────────────
const DEMO_CONFIG_FILE = "wrangler.demo.jsonc";
const WORKER_NAME = "mailboxes-demo";
const D1_NAME = "mailboxes-db-demo";
const BUCKET_NAME = "mailboxes-demo";
const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";
const EXPECTED_CRON = "0 * * * *";

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optionOf = (name) => {
	const at = argv.indexOf(name);
	return at === -1 ? undefined : argv[at + 1];
};

if (hasFlag("--help") || hasFlag("-h")) {
	console.log(`Deploy the read-only Mailboxes demo (worker "${WORKER_NAME}").

  node scripts/deploy-demo.mjs               build in a temp dir, migrate, deploy
  node scripts/deploy-demo.mjs --with-seed   also run scripts/seed-demo.mjs --remote
  node scripts/deploy-demo.mjs --dry-run     print the plan and exit
  node scripts/deploy-demo.mjs --d1-id UUID  use UUID instead of looking it up
  node scripts/deploy-demo.mjs --build-only  build in a temp dir and verify the
                                             demo identity, then stop (no
                                             migrate, no deploy — no credentials
                                             needed beyond the D1/R2 lookup)
  node scripts/deploy-demo.mjs --keep-temp   keep the temp build directory

Creates "${D1_NAME}" (D1) and "${BUCKET_NAME}" (R2) only when missing; never
deletes anything and never touches the production worker or database.
The real database id is injected into a generated config inside the temp
directory — the repo's ${DEMO_CONFIG_FILE} keeps its all-zero placeholder.`);
	process.exit(0);
}

const DRY_RUN = hasFlag("--dry-run");
const BUILD_ONLY = hasFlag("--build-only");
const WITH_SEED = hasFlag("--with-seed");
const KEEP_TEMP = hasFlag("--keep-temp");
const D1_ID_ARG = optionOf("--d1-id");

// ── output helpers ─────────────────────────────────────────────────────────
const step = (n, text) => console.log(`\n\u001b[1m[${n}/7]\u001b[0m ${text}`);
const info = (text) => console.log(`      ${text}`);
const fail = (text, hint) => {
	console.error(`\n\u001b[31m✗ ${text}\u001b[0m`);
	if (hint) console.error(`  ${hint}`);
	process.exit(1);
};
const ok = (text) => console.log(`      \u001b[32m✓\u001b[0m ${text}`);

// ── process helpers ────────────────────────────────────────────────────────
/** Run a command, forward output unless we need to parse it. */
function run(cmd, args, { cwd = ROOT, capture = false, env = {} } = {}) {
	const result = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		env: { ...process.env, ...env },
	});
	if (result.status !== 0) {
		if (capture) {
			const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
			fail(`command failed: ${cmd} ${args.join(" ")}`, detail.split("\n").slice(-12).join("\n  "));
		}
		fail(`command failed: ${cmd} ${args.join(" ")}`);
	}
	return capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

/** `npx wrangler ...` — always the repo-local wrangler. */
function wrangler(args, options = {}) {
	return run("npx", ["wrangler", ...args], options);
}

/** Strip the wrangler banner before JSON (wrangler prints "⛅️ wrangler x.y.z"). */
function parseJson(raw, label) {
	const candidates = [raw.indexOf("["), raw.indexOf("{")].filter((at) => at !== -1);
	const start = candidates.length > 0 ? Math.min(...candidates) : -1;
	if (start === -1) fail(`could not find JSON in the ${label} output`, raw.trim().split("\n").slice(-6).join("\n  "));
	try {
		return JSON.parse(raw.slice(start));
	} catch (error) {
		fail(`could not parse the ${label} output: ${error.message}`, raw.trim().split("\n").slice(-6).join("\n  "));
	}
}

// ── 1. preflight ───────────────────────────────────────────────────────────
step(1, "Preflight — repo state, Node version, demo config");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) fail(`Node ${process.versions.node} is too old`, "This app needs Node 20+ (see .nvmrc).");

const demoConfigPath = join(ROOT, DEMO_CONFIG_FILE);
if (!existsSync(demoConfigPath)) fail(`${DEMO_CONFIG_FILE} not found`, "Expected it in the repo root (docs/demo-site-plan.md §1).");
const demoConfigText = readFileSync(demoConfigPath, "utf8");
for (const needle of [`"name": "${WORKER_NAME}"`, `"bucket_name": "${BUCKET_NAME}"`, `"database_name": "${D1_NAME}"`, PLACEHOLDER_D1_ID]) {
	if (!demoConfigText.includes(needle)) {
		fail(`${DEMO_CONFIG_FILE} does not contain ${needle}`, "The demo config changed shape — review it before deploying.");
	}
}
ok(`${DEMO_CONFIG_FILE} looks like the demo (worker ${WORKER_NAME}, placeholder D1 id still in place)`);

const gitRev = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
const gitDirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" });
info(`commit ${(gitRev.stdout ?? "").trim() || "unknown"}${(gitDirty.stdout ?? "").trim() ? " (working tree has uncommitted changes)" : ""}`);
info(`node ${process.versions.node}`);

// ── 2. D1 database ─────────────────────────────────────────────────────────
step(2, `D1 database "${D1_NAME}"`);

function findD1Id() {
	const raw = wrangler(["d1", "list", "--json"], { capture: true });
	const databases = parseJson(raw, "d1 list");
	const hit = (Array.isArray(databases) ? databases : []).find((db) => db?.name === D1_NAME);
	return hit?.uuid ?? hit?.id ?? null;
}

let databaseId = D1_ID_ARG ?? null;
if (databaseId) {
	info(`using --d1-id ${databaseId} (skipping the lookup)`);
} else {
	databaseId = findD1Id();
	if (databaseId) {
		ok(`already exists — id ${databaseId} (reused, not recreated)`);
	} else if (DRY_RUN) {
		ok(`missing — a real run would run: npx wrangler d1 create ${D1_NAME}`);
	} else {
		info(`missing — creating it`);
		wrangler(["d1", "create", D1_NAME]);
		databaseId = findD1Id();
		if (!databaseId) fail(`created ${D1_NAME} but it does not show up in \`wrangler d1 list\``, "Re-run the script; if it keeps happening check the account's D1 quota.");
		ok(`created — id ${databaseId}`);
	}
}

// ── 3. R2 bucket ───────────────────────────────────────────────────────────
step(3, `R2 bucket "${BUCKET_NAME}"`);

function hasBucket(name) {
	const raw = wrangler(["r2", "bucket", "list"], { capture: true });
	return new RegExp(`^name:\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(raw);
}

if (hasBucket(BUCKET_NAME)) {
	ok(`already exists — reused`);
} else if (DRY_RUN) {
	ok(`missing — a real run would run: npx wrangler r2 bucket create ${BUCKET_NAME}`);
} else {
	info(`missing — creating it`);
	wrangler(["r2", "bucket", "create", BUCKET_NAME]);
	if (!hasBucket(BUCKET_NAME)) fail(`created ${BUCKET_NAME} but it does not show up in \`wrangler r2 bucket list\``);
	ok(`created`);
}

if (DRY_RUN) {
	console.log("\n\u001b[33m--dry-run: stopping here (no temp dir, no build, no deploy).\u001b[0m");
	console.log(`Would deploy with the demo D1 id ${databaseId ?? "<looked up at run time>"}.`);
	process.exit(0);
}

// ── 4. temp working copy + generated demo config ───────────────────────────
step(4, "Temporary build directory (the repo root is never deployed from)");

const SKIP = new Set(["node_modules", ".git", "build", ".wrangler", ".react-router", "test-results", "playwright-report", "dist", ".agents"]);
const workDir = mkdtempSync(join(tmpdir(), "mailboxes-demo-deploy-"));
info(`copying the working tree to ${workDir}`);
cpSync(ROOT, workDir, {
	recursive: true,
	dereference: false,
	filter: (src) => {
		const rel = src.slice(ROOT.length + 1);
		if (!rel) return true;
		const head = rel.split("/")[0];
		return !SKIP.has(head);
	},
});

// The demo config becomes `wrangler.jsonc` so @cloudflare/vite-plugin picks it
// up automatically; the real id is substituted here and ONLY here.
const generatedConfig = demoConfigText.replace(PLACEHOLDER_D1_ID, databaseId);
if (hasFlag("--verbose")) info("generated config keeps the JSONC comments — wrangler parses .jsonc natively");
writeFileSync(join(workDir, "wrangler.jsonc"), generatedConfig);
if (existsSync(join(workDir, ".wrangler", "deploy", "config.json"))) {
	rmSync(join(workDir, ".wrangler"), { recursive: true, force: true });
	info("removed a copied .wrangler/deploy redirect");
}
ok(`wrote ${WORKER_NAME} config (D1 ${databaseId}) as wrangler.jsonc inside the temp dir`);
ok("repo wrangler.demo.jsonc untouched (placeholder id still in the working tree)");

// ── 5. install + build ─────────────────────────────────────────────────────
step(5, "Install dependencies and build");

info("npm ci (this is the slow step)");
run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: workDir });
info("npm run build");
run("npm", ["run", "build"], { cwd: workDir });

// The build output is what wrangler actually uploads; assert its identity
// before any network round trip.
const builtConfigPath = join(workDir, "build", "server", "wrangler.json");
if (!existsSync(builtConfigPath)) fail("build produced no build/server/wrangler.json", "`npm run build` should write it via @cloudflare/vite-plugin.");
const built = JSON.parse(readFileSync(builtConfigPath, "utf8"));

function assertDemoBuild(config) {
	const problems = [];
	if (config.name !== WORKER_NAME) problems.push(`name is "${config.name}", expected "${WORKER_NAME}"`);
	const db = (config.d1_databases ?? [])[0];
	if (!db) problems.push("no d1_databases binding");
	else {
		if (db.binding !== "DB") problems.push(`d1 binding is "${db.binding}", expected "DB"`);
		if (db.database_id !== databaseId) problems.push(`d1 id is "${db.database_id}", expected the demo id "${databaseId}"`);
	}
	const bucket = (config.r2_buckets ?? [])[0];
	if (!bucket || bucket.bucket_name !== BUCKET_NAME) problems.push(`r2 bucket is "${bucket?.bucket_name ?? "<none>"}", expected "${BUCKET_NAME}"`);
	if (config.vars?.DEMO_MODE !== "1") problems.push(`vars.DEMO_MODE is "${config.vars?.DEMO_MODE ?? "<unset>"}", expected "1"`);
	if (!(config.triggers?.crons ?? []).includes(EXPECTED_CRON)) problems.push(`crons ${JSON.stringify(config.triggers?.crons ?? [])} do not include "${EXPECTED_CRON}"`);
	if (config.ai) problems.push("an `ai` binding is present — the demo must not have one (it would share production's Neurons)");
	const varKeys = Object.keys(config.vars ?? {}).sort();
	if (varKeys.join(",") !== "DEMO_MODE") problems.push(`vars are ${varKeys.join(",") || "<none>"}, expected only DEMO_MODE`);
	if (problems.length > 0) {
		fail(`refusing to deploy: the generated build is not the demo worker`, `${problems.join("\n  ")}\n  This is the check that keeps a misconfigured run off production.`);
	}
	return { varKeys, migrations: (config.d1_databases ?? [])[0]?.migrations_dir };
}

const identity = assertDemoBuild(built);
ok(`build identity verified: name ${WORKER_NAME}, DB ${databaseId}, bucket ${BUCKET_NAME}, vars ${identity.varKeys.join(",")}, cron ${EXPECTED_CRON}, no ai binding`);

if (BUILD_ONLY) {
	console.log("\n\u001b[33m--build-only: stopping before migrations and deploy.\u001b[0m");
	console.log(`Temp dir: ${workDir}`);
	process.exit(0);
}

// ── 6. migrations ──────────────────────────────────────────────────────────
step(6, `Apply pending migrations to ${D1_NAME} (remote)`);

wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", "wrangler.jsonc"], { cwd: workDir });
ok("migrations applied (only pending ones — re-running applies none)");
info("note: a schema built purely from migrations lacks domains.resend_api_key;");
info("      scripts/seed-demo.mjs adds it to the demo database behind a PRAGMA guard.");

if (WITH_SEED) {	info("--with-seed: seeding the demo database and bucket");
	run("node", ["scripts/seed-demo.mjs", "--remote", "--config", join(workDir, "wrangler.jsonc"), "--bucket", BUCKET_NAME], { cwd: workDir });
	ok("seed ran (its own self-checks must all pass — see the output above)");
}

// ── 7. deploy ──────────────────────────────────────────────────────────────
step(7, `Deploy ${WORKER_NAME}`);

const deployOut = wrangler(["deploy", "-c", "build/server/wrangler.json"], { cwd: workDir, capture: true });
process.stdout.write(deployOut
	.split("\n")
	.filter((line) => line.trim().length > 0)
	.map((line) => `      ${line}`)
	.join("\n") + "\n");

const versionId = deployOut.match(/(?:Current\s+)?Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
	?? deployOut.match(/version[_\s-]?id["'\s:=]+([0-9a-f-]{36})/i)?.[1]
	?? "<not printed by wrangler>";
const url = deployOut.match(new RegExp(`https://${WORKER_NAME}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0] ?? "<not printed by wrangler>";

if (!KEEP_TEMP) rmSync(workDir, { recursive: true, force: true });

console.log(`
\u001b[1mDemo deployed\u001b[0m
  address      ${url}
  version id   ${versionId}
  worker       ${WORKER_NAME}
  database     ${D1_NAME} (${databaseId})
  bucket       ${BUCKET_NAME}
  commit       ${(gitRev.stdout ?? "").trim() || "unknown"}${(gitDirty.stdout ?? "").trim() ? " + uncommitted changes" : ""}
${KEEP_TEMP ? `  temp dir     ${workDir}\n` : ""}
Next: verify it for real — \`node scripts/demo-e2e.mjs\` covers the local build,
the live URL needs the curl pass in docs/demo-site-plan.md §9.
`);
