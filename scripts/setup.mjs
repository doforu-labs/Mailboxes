#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// One-command setup for Mailboxes. It is idempotent, so it doubles as a
// redeploy: it creates the R2 bucket and the D1 database when they are
// missing, writes the resulting database_id back into the wrangler config,
// applies the remote migrations, builds, deploys, and prints the URL.
//
//   npm run setup
//   npm run setup -- --dry-run       report only, change nothing
//   npm run setup -- --skip-deploy   everything except the deploy
//   npm run setup -- --config FILE   use FILE instead of wrangler.jsonc

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_MAJOR = 20;

// ── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optionOf = (name) => {
	const at = argv.indexOf(name);
	return at === -1 ? undefined : argv[at + 1];
};

if (hasFlag("--help") || hasFlag("-h")) {
	console.log(`Mailboxes setup — deploy this app to your own Cloudflare account.

  npm run setup                   Create missing resources, migrate, build, deploy
  npm run setup -- --skip-deploy  Everything except the deploy
  npm run setup -- --dry-run      Report what would happen, then exit
  npm run setup -- --config FILE  Read/write FILE instead of wrangler.jsonc

Needs Node.js ${MIN_NODE_MAJOR}+. Cloudflare login is run on demand.`);
	process.exit(0);
}

const DRY_RUN = hasFlag("--dry-run");
const SKIP_DEPLOY = DRY_RUN || hasFlag("--skip-deploy");

// ── output ─────────────────────────────────────────────────────────────────

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const line = (text = "") => console.log(text);
const heading = (text) => line(`\n${paint("36", "▸")} ${paint("1", text)}`);
const done = (text) => line(`  ${paint("32", "✓")} ${text}`);
const note = (text) => line(`  ${paint("33", "•")} ${text}`);

function abort(message, hint) {
	line(`\n${paint("31", "✗")} ${message}`);
	if (hint) line(`  ${hint}`);
	process.exit(1);
}

/** Last few lines of a captured command, indented so it reads as a quote. */
const asBlock = (text) =>
	text
		.trimEnd()
		.split("\n")
		.slice(-20)
		.map((l) => `  │ ${l}`)
		.join("\n");

// ── shell ──────────────────────────────────────────────────────────────────

function sh(cmd, args, { capture = false } = {}) {
	const res = spawnSync(cmd, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (res.error) abort(`无法执行 ${cmd}`, res.error.message);
	return { status: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const CONFIG_PATH = resolve(
	ROOT,
	optionOf("--config") ??
		["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find((f) => existsSync(resolve(ROOT, f))) ??
		"wrangler.jsonc",
);

// The local binary is faster than npx and works offline; fall back to npx.
const WRANGLER_BIN = resolve(
	ROOT,
	"node_modules",
	".bin",
	process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const wrangler = (args, opts) =>
	existsSync(WRANGLER_BIN)
		? sh(WRANGLER_BIN, [...args, "--config", CONFIG_PATH], opts)
		: sh("npx", ["wrangler", ...args, "--config", CONFIG_PATH], opts);

/** Replace an existing `database_id` value, or insert the key after `database_name`. */
function withDatabaseId(text, databaseId) {
	const keyed = /("database_id"\s*:\s*")[^"]*(")/;
	if (keyed.test(text)) return text.replace(keyed, `$1${databaseId}$2`);

	const lines = text.split("\n");
	const at = lines.findIndex((l) => l.includes('"database_name"'));
	if (at === -1) return text;
	const indent = /^[\t ]*/.exec(lines[at])[0];
	lines.splice(at + 1, 0, `${indent}"database_id": "${databaseId}",`);
	return lines.join("\n");
}

// ── 1. preflight ───────────────────────────────────────────────────────────

heading("环境检查");

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
	abort(`需要 Node.js ${MIN_NODE_MAJOR} 或更高版本（当前 ${process.version}）`, "仓库里有 .nvmrc，执行 nvm use 即可");
}
done(`Node.js ${process.version}`);

if (!existsSync(resolve(ROOT, "package.json"))) abort(`找不到 package.json：${ROOT}`);
if (!existsSync(CONFIG_PATH)) abort(`找不到 wrangler 配置：${CONFIG_PATH}`);

if (!existsSync(resolve(ROOT, "node_modules"))) {
	if (DRY_RUN) {
		note("尚未安装依赖（正式运行时会先执行 npm install）");
	} else {
		line("  尚未安装依赖，先执行 npm install …");
		if (sh("npm", ["install"]).status !== 0) abort("npm install 失败");
		done("依赖已安装");
	}
}

// ── 2. authentication ──────────────────────────────────────────────────────

heading("Cloudflare 登录");

if (wrangler(["whoami"], { capture: true }).status === 0) {
	done("已登录");
} else if (DRY_RUN) {
	note("尚未登录（正式运行时会自动打开浏览器授权）");
} else {
	note("尚未登录，正在打开浏览器授权 …");
	if (wrangler(["login"]).status !== 0) abort("登录失败", "手动执行 npx wrangler login 后重试");
	done("登录成功");
}

// ── 3. read the wrangler config ────────────────────────────────────────────

heading(`读取 ${CONFIG_PATH.replace(`${ROOT}/`, "")}`);

const configText = readFileSync(CONFIG_PATH, "utf8");
const valueOf = (key) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(configText)?.[1];

const workerName = valueOf("name") ?? "mailboxes";
const databaseName = valueOf("database_name") ?? "mailboxes-db";
const currentDatabaseId = valueOf("database_id");
const bucketName = valueOf("bucket_name");

done(`Worker：${workerName}`);
done(`D1：${databaseName}（当前 database_id：${currentDatabaseId ?? "未设置"}）`);
done(bucketName ? `R2：${bucketName}` : "R2：配置里没有固定桶名，wrangler 会自动创建");

// ── 4. R2 bucket ───────────────────────────────────────────────────────────

heading("R2 存储桶");

const bucketExists = () =>
	wrangler(["r2", "bucket", "list"], { capture: true }).out.includes(bucketName ?? " ");

if (!bucketName) {
	note("配置里没有 bucket_name，交给 wrangler 自动创建");
} else if (bucketExists()) {
	done(`${bucketName} 已存在`);
} else if (DRY_RUN) {
	note(`${bucketName} 不存在（正式运行时会创建）`);
} else {
	const res = wrangler(["r2", "bucket", "create", bucketName], { capture: true });
	if (res.status !== 0 && !bucketExists()) abort(`创建 R2 桶 ${bucketName} 失败`, asBlock(res.out));
	done(`${bucketName} 已创建`);
}

// ── 5. D1 database ─────────────────────────────────────────────────────────

heading("D1 数据库");

function listDatabases() {
	const res = wrangler(["d1", "list", "--json"], { capture: true });
	const from = res.out.indexOf("[");
	if (from === -1) return null;
	try {
		const parsed = JSON.parse(res.out.slice(from, res.out.lastIndexOf("]") + 1));
		if (Array.isArray(parsed)) return parsed;
		return Array.isArray(parsed?.result) ? parsed.result : null;
	} catch {
		return null;
	}
}

const findDatabase = (rows) => rows?.find((row) => row && row.name === databaseName);

let record = findDatabase(listDatabases());

if (!record && DRY_RUN) {
	note(`${databaseName} 不存在（正式运行时会创建）`);
} else if (!record) {
	const res = wrangler(["d1", "create", databaseName], { capture: true });
	record = findDatabase(listDatabases());
	if (!record) {
		const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(res.out)?.[0];
		if (uuid) record = { uuid };
	}
	if (!record) abort(`创建 D1 数据库 ${databaseName} 失败`, asBlock(res.out));
	done(`${databaseName} 已创建`);
} else {
	done(`${databaseName} 已存在`);
}

const databaseId = record?.uuid ?? record?.id ?? record?.database_id;

// ── 6. write database_id back ──────────────────────────────────────────────

heading("写入 database_id");

if (!databaseId) {
	note("无法确定 database_id，跳过写回 —— 请手动检查配置");
} else if (databaseId === currentDatabaseId) {
	done("配置已指向该数据库，无需修改");
} else if (DRY_RUN) {
	note(`会把 database_id 从 ${currentDatabaseId ?? "(缺失)"} 改成 ${databaseId}`);
} else {
	const updated = withDatabaseId(configText, databaseId);
	if (updated === configText) abort("无法自动写入 database_id", "请手动把 database_id 填进 wrangler.jsonc");
	writeFileSync(CONFIG_PATH, updated);
	done(`database_id → ${databaseId}`);
}

// ── 7. migrations ──────────────────────────────────────────────────────────

heading("应用数据库迁移");

if (DRY_RUN) {
	note(`会执行：wrangler d1 migrations apply ${databaseName} --remote`);
} else if (wrangler(["d1", "migrations", "apply", databaseName, "--remote"]).status !== 0) {
	abort("应用迁移失败");
} else {
	done("迁移已应用");
}

// ── 8. build ───────────────────────────────────────────────────────────────

heading("构建");

if (DRY_RUN) {
	note("会执行：npm run build");
} else if (sh("npm", ["run", "build"]).status !== 0) {
	abort("构建失败");
} else {
	done("构建完成");
}

// ── 9. deploy ──────────────────────────────────────────────────────────────

heading("部署");

let url;

if (SKIP_DEPLOY) {
	note(`已跳过部署（${DRY_RUN ? "--dry-run" : "--skip-deploy"}）`);
} else {
	const res = wrangler(["deploy"], { capture: true });
	if (res.status !== 0) abort("部署失败", asBlock(res.out));
	url = /https:\/\/[^\s"']+\.workers\.dev[^\s"']*/i.exec(res.out)?.[0];
	done(url ? `已部署：${url}` : "已部署");
}

// ── 10. health check + next steps ──────────────────────────────────────────

if (url) {
	heading("健康检查");
	try {
		const res = await fetch(url, { redirect: "manual" });
		if ([200, 302, 307].includes(res.status)) done(`HTTP ${res.status}`);
		else note(`HTTP ${res.status} —— 部署通常没问题，稍后刷新即可`);
	} catch (error) {
		note(`请求失败：${error.message}`);
	}
}

heading("下一步");
line(`  1. 收信：Cloudflare 面板 → 你的域名 → Email Routing → 建一条 catch-all 规则，转发到 Worker「${workerName}」`);
line(`  2. 打开 ${url ?? "你的 Worker 地址"}，首次会自动进入 /setup 向导创建管理员账号（没有默认密码）`);
line("  3. 发信（可选）：在 resend.com 添加域名并取 API Key，然后在应用的 Add Domain 流程里填入");
line();
line(paint("32", `完成 🎉  ${SKIP_DEPLOY ? "（本次跳过了部署）" : "以后重新部署，再跑一次 npm run setup 即可。"}`));
