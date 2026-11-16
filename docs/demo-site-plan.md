# Mailboxes 公开只读演示站 · 实施方案

状态：方案，未实施。本文只描述要做什么、怎么做、需要谁拍板，不含任何已执行的部署或资源创建。
代码基线：`main` @ `2052421`（工作副本存在未提交改动，见 §0.1）。

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 1. 放哪 | **独立 Worker + 独立 D1 + 独立 R2**，代码不 fork，用新增的 `wrangler.demo.jsonc` 部署第二个实例。只读守卫写成同一个仓库里的一个模块，靠 `DEMO_MODE` 变量激活，生产实例上完全不生效。 |
| 2. 只读 | **方法级默认拒绝**：`DEMO_MODE` 打开时，`/api/v1/*` 只放行 GET + 三个 auth 端点，其余一律 `403 {code:"demo_read_only"}`；再加一份路径黑名单兜住几个"读但要对外发请求"的接口。会话是每个访客一条 D1 session，TTL 1 小时；每 6 小时用 Cron 重置一次数据，登录时做惰性兜底。 |
| 3. 预置数据 | 3 个邮箱 / 2 个域名 / 18 个系统文件夹 + 3 个自定义文件夹 / 128 封邮件（含 8 个会话线程）/ 5 个假附件（合计 <120KB，真文件真字节）/ 8 条只读 AI 对话记录。种子数据是一份 JSON，seed 脚本和运行时重置**共用同一份**。 |
| 4. 安全边界 | 演示库**不含任何 Resend key / CF API token**（`domains.resend_api_key` 全 NULL、`platform_settings` 空表），发信在 `sendEmailFromMailbox` 查 key 阶段就抛错，**结构上到不了 Resend**；HTTP 层再挡一次。演示域名不挂 Email Routing，不收信；admin 已存在，`POST /api/v1/setup/admin` 永远 409，注册机无从下手；`/mcp`、`/tools` 全 403。 |
| 5. 成本 | 免费套餐够用，但**必须把 AI 对话关掉**：Workers AI 每天 10,000 Neurons 是账号级共享额度，一次带工具的对话就可能吃掉几十到几百，是这个方案唯一真实的爆点。其余（10 万请求/天、D1 每天 10 万行写入）余量很大。 |
| 6. 工作量 | **6～7 人日**（1 人约 1.5 周；砍掉 AI 面板展示与邮件数量减半可压到 4 人日）。需要 Doforu 提供：CF 账号写权限、一个演示域名/子域、公开访问授权、虚构品牌名确认。 |

---

## 0.1 三处与任务背景不一致的事实（已核实，按代码为准）

方案按代码写，这三点会直接影响实施，先说明：

1. **邮箱不在 D1，在 R2。** 一个邮箱 = 一个 R2 对象 `mailboxes/<email>.json`（`workers/index.ts:314-327`），里面是 `fromName / forwarding / signature / created_at`，还可能带 `resendApiKey`。`workers/lib/d1-middleware.ts:60` 的 `requireMailbox` 先 `BUCKET.head()` 这个 key，**没有就直接 404**。D1 只放 folders / emails / attachments / domains / admins / sessions / ai_chat_messages / agent_api_keys / platform_settings。所以"造数据"必须同时写 D1 和 R2，只写 D1 会得到一个"哪儿都 404"的空站。
2. **`wrangler.jsonc` 的 D1 id 在当前工作副本里已经是真实 id**，不是全零占位（`git diff wrangler.jsonc` 显示这一行被改过且未提交）。方案里所有涉及 demo 配置的地方都走**新文件** `wrangler.demo.jsonc`，不碰这个文件。
3. **仓库里目前没有 Cron Trigger，也没有 `scheduled` 导出。** `workers/app.ts` 的默认导出只有 `fetch` 和 `email`。加 Cron 属于新增能力，只写在 demo 配置里。

---

## 1. 演示站放哪：独立 Worker + 独立 D1/R2

### 1.1 结论

同一份代码，**两次部署**：

```text
同仓库 Mailboxes
├── wrangler.jsonc                 （现有，生产：mailboxes / DB mailboxes-db / BUCKET mailboxes）
└── wrangler.demo.jsonc            （新增，演示：mailboxes-demo / DB mailboxes-db-demo / BUCKET mailboxes-demo）
                                   vars: { DEMO_MODE: "1" }，triggers.crons: ["0 * * * *"]
                                   routes: demo.<domain>  （或 workers.dev 子域）

生产实例  ── 真实邮箱、真实 Resend key、真实 CF token、收发信全开
演示实例  ── 假数据、无任何凭据、HTTP 层只读、每 6 小时重置
```

`DEMO_MODE` 未设置时，新增的守卫中间件第一行 `if (env.DEMO_MODE !== "1") return next()`，生产实例行为零变化。

### 1.2 为什么不是"同一个 Worker 里加 demo 模式"

- **数据会互相污染。** 演示站要每 6 小时清库重建，同库意味着 `DELETE FROM emails` 会清掉真实邮件。想既不删又隔离就得在每张表上加大面积的 `WHERE mailbox_id LIKE 'demo-%'` 过滤，等于把隔离责任分散到 `workers/db/index.ts` 的几十个查询里——任何一处漏掉，演示访客就能读到真实邮件。这是本方案最不能接受的失败模式。
- **凭据会互相泄漏。** 生产库里 `platform_settings.cf_api_token`、`domains.resend_api_key`、mailbox JSON 里的 `resendApiKey` 都是明文存储。同库 + `DEMO_MODE` 误配一次（漏设、拼错、某次 `wrangler deploy` 忘了带配置），公开演示站就直接握着一个能发信、能改 DNS 的后台。
- **配置无法表达。** 一个 `wrangler.jsonc` 只能有一组 `d1_databases` / `r2_buckets` / `name`。同 Worker 方案下 D1 和 R2 是共用的，上面两条无解。

### 1.3 为什么不 fork 仓库 / 单开一个 demo 分支

演示站展示的必须是"当前产品的样子"。fork 之后每次改主仓都要同步一次，两次之后演示站就开始骗人（截图和实际产品不一致），维护成本远高于独立部署。

### 1.4 独立部署的真实代价（已确认可接受）

- 免费额度是按账号算的，第二套 D1/R2 会**共享**同一个账号的 5M 读/天、10 万写/天，不会翻倍。§5 的估算已把这部分算进去了。
- D1 / R2 本身都允许一个账号下存在多个实例（当前只用了 1 个库、1 个桶），第二套不涉及升级套餐。
- 部署入口要小心：`npm run build` 会写 `.wrangler/deploy/config.json`，其内容是 `{"configPath":"../../build/server/wrangler.json"}`，wrangler 会顺着它重定向到**构建产物里的配置**（`name: mailboxes`）。所以"用 `-c wrangler.demo.jsonc` 直接 deploy"这条路有把配置指向错对象的风险，实施时用临时目录构建（§6 步骤 3），不要在仓库根目录直接 `wrangler deploy`。

### 1.5 新增文件清单（实施时）

```text
wrangler.demo.jsonc                     演示实例的配置（name/db/bucket/vars/crons/routes）
workers/demo/guard.ts                   只读守卫中间件 + X-Robots-Tag
workers/demo/login.ts                   演示登录（无口令发会话）与重置调度
workers/demo/reset.ts                   resetDemoData(env)：清库 + 从种子 JSON 重建
workers/demo/seed-data.json             种子数据（128 封邮件、8 条 AI 记录、R2 对象清单）
scripts/seed-demo.mjs                   本地/远端一次性种数据，与 reset.ts 共用 seed-data.json
scripts/deploy-demo.mjs                 临时目录构建 + 迁移 + 部署（绕开 .wrangler/deploy 重定向）
migrations/0014_demo_meta.sql           演示用元数据表（见 §2.5）；只在 demo 库上执行
```

需要改动的**现有**文件只有 4 处，都很小（本次任务不动它们）：

| 文件 | 改动 | 目的 |
| --- | --- | --- |
| `workers/types.ts` | `Env` 加 `DEMO_MODE?: string` | 类型可见 |
| `workers/index.ts` | 在 `const app = new Hono()` 后挂 `app.use("/api/*", demoGuard)`；在 auth 段挂 `app.post("/api/v1/auth/demo-login", handleDemoLogin)`；`GET /api/v1/config` 响应加 `demo: true` | 守卫生效 + 前端知道自己是演示站 |
| `workers/app.ts` | 默认导出加 `async scheduled(event, env, ctx)` | Cron 重置 |
| `app/services/api.ts` | `request<T>`（`app/services/api.ts:106`）里识别 `403 + code=demo_read_only`，静默不弹错 | 只读站的写操作不炸 UI |

---

## 2. 只读怎么保证

### 2.1 守卫的位置与策略：方法级默认拒绝

已核实：`app/routes/` 下**没有任何 `action` 导出**，前端所有读写都走 `/api/v1/*`（`app/services/api.ts` 单点封装）。所以只要看住 API 层，就守住了整个写面，不需要在 React Router 层再做一遍。

策略：**白名单按 HTTP 方法判定，默认拒绝**，而不是"列出所有写路由再逐个禁"。

```ts
// workers/demo/guard.ts（示意）
import { createMiddleware } from "hono/factory";
import type { D1MailboxContext } from "../lib/d1-middleware";

// 允许的"读"：GET，但排除这些即使 GET 也会对外发请求/吐凭据的路径
const DENY_PREFIXES = [
  "/api/v1/setup/",            // 会拿 DB 里的 CF token 去调 Cloudflare / Resend
  "/api/v1/platform-settings/",// GET 会把 cf_api_token 原样吐回来
  "/api/v1/inbound/",          // Resend 入站 webhook
  "/api/v1/agent-api-keys",    // 外部门户的 key 管理
  "/mcp", "/tools",            // agent 网关（外部 LLM 入口）
];
const ALLOW_POST = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/demo-login",
  "/api/v1/auth/logout",
]);

export const demoGuard = createMiddleware<D1MailboxContext>(async (c, next) => {
  if (c.env.DEMO_MODE !== "1") return next();          // 生产：完全无影响
  c.header("X-Robots-Tag", "noindex, nofollow");        // 防被搜索引擎当真实站点收录

  const path = c.req.path;
  const method = c.req.method;
  if (DENY_PREFIXES.some((p) => path === p || path.startsWith(p))) {
    return c.json({ error: "This demo is read-only.", code: "demo_read_only" }, 403);
  }
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (method === "POST" && ALLOW_POST.has(path)) return next();
  return c.json({ error: "This demo is read-only.", code: "demo_read_only" }, 403);
});
```

这个写法有三个性质，是选它的理由：

- **未来的新写路由自动被挡。** 加一条 `POST /api/v1/mailboxes/:id/tags` 不用记得改守卫。反过来"列写路由"的方案，漏一条就是一个洞，而且漏了没人会发现。
- **挡住注册机，连 409 都不给探测。** `POST /api/v1/setup/admin` 不在白名单里 → 直接 403，攻击者连"这个站有没有初始化"都问不出来（原本它会回 409，暴露出管理员已存在）。
- **CORS 与 i18n 中间件不受影响**：守卫挂在 `/api/*` 上、位于 `requireAuth` 之前，401 挑战与 `WWW-Authenticate` 语义不变。

挂载点在 `workers/index.ts:174`（auth 路由）之前、`workers/index.ts:215`（`app.route("/", setup)`）之前——注意 `setup` 子应用也挂在 `/api/v1/*` 上，所以守卫必须挂在 `app.use("/api/*")` 这一层才能覆盖它。

### 2.2 被禁的具体路由（实施后逐条可测）

写路由（全部 403）：

| 路由 | 位置 | 效果 |
| --- | --- | --- |
| `POST /api/v1/mailboxes` | `workers/index.ts:302` | 不能建邮箱 |
| `PUT`/`DELETE /api/v1/mailboxes/:mailboxId` | `workers/index.ts:661,670` | 不能改设置/删邮箱 |
| `POST /api/v1/mailboxes/:mailboxId/emails` | `workers/index.ts:725` | **不能发信** |
| `POST .../drafts`、`DELETE .../drafts/:emailId` | `workers/index.ts:796,822` | 不能写草稿 |
| `PUT`/`DELETE .../emails/:id`、`POST .../move` | `workers/index.ts:840,846,856` | 不能改已读星标、不能删/移动 |
| `POST .../emails/:id/reply`、`/forward` | `workers/index.ts:875,876` | 不能回/转 |
| `POST .../threads/:threadId/read` | `workers/index.ts:868` | 未读数保持恒定（演示可复现） |
| `POST`/`PUT`/`DELETE .../folders*` | `workers/index.ts:916,924,930` | 不能建/改/删文件夹 |
| `POST .../ai/chat`、`DELETE .../ai/chat` | `workers/index.ts:1098,1313` | **不烧 Neurons、不给提示注入留工具调用面** |
| `POST /api/v1/mailboxes/:mailboxId/verify-resend`、`POST /api/v1/domains/:domainId/verify-resend`、`.../setup-resend-sending` | `workers/index.ts:348,418,498` | 不能触发对外 API |
| `POST /api/v1/domains`、`DELETE /api/v1/domains/:id`、`PUT .../catch-all`、`PUT .../api-key` | `workers/setup.ts:792,1146,1236,1319` | 不能加域/改 DNS/key |
| `PUT /api/v1/platform-settings/:key` | `workers/index.ts:225` | 不能写凭据 |
| `POST /api/v1/agent-api-keys/*` | `workers/routes/agent-api-keys.ts:315` | 不能造外部 key |
| `POST /api/v1/inbound/resend` | `workers/index.ts:906` | 入站 webhook 关闭 |
| `POST /mcp`、`/tools`、`/tools/call` | `workers/routes/agent-api.ts:370` | **agent 网关整体关闭**（13 个工具里有 `send_email`、`delete_email`） |

保留的读路由（GET，正常 200）：`/api/v1/auth/me`、`/api/v1/config`、`/api/v1/mailboxes`、`/api/v1/mailboxes/:id`、`.../emails`、`.../emails/:id`、`.../threads/:threadId`、`.../folders`、`.../search`、`.../attachments/:attachmentId`、`/api/v1/domains`、`/api/v1/domains/:id`、`.../ai/chat`（读历史，只展示种好的对话）。

两处特意排除的 GET：

- `GET /api/v1/platform-settings/:key`（`workers/index.ts:219`）——它会把 `cf_api_token` 明文吐给任何持会话者。演示库虽然是空的，但"把可能吐凭据的接口留在公开站上"这条线不划。
- `GET /api/v1/setup/verify-domain/:domainId`（`workers/setup.ts:1346`）——`status` 为 `pending` 时会拿库里的 CF/Resend 凭据去对外查。演示数据里两个域名的状态直接种成 `verified` / `failed`（这两个分支会短路返回），路径本身仍然禁掉。

### 2.3 演示账号怎么发

**没有可猜的口令。** 不把演示口令写在登录页（那种做法等于把 admin 口令公开，任何人拿到就能在别的站上试同一串，且一旦演示实例配置出错就是完整后台）。改为：

- `admins` 表里种一行，`password` 存一个**随机生成、从未被任何人知道**的 PBKDF2-SHA256 哈希（`workers/lib/password.ts` 的 `toStoredPassword` 生成后丢弃明文）。`POST /api/v1/auth/login` 因此永远 401，常规登录路径在演示站上是死的。
- 新增 `POST /api/v1/auth/demo-login`（`workers/demo/login.ts`，仅 `DEMO_MODE=1` 存在，否则 404）：无请求体，直接 `issueSession()` 发一条会话。这是访客进入演示站的唯一方式，登录页上就是一个"以访客身份进入"的按钮（`app/routes/login.tsx` 加一个分支）。
- 该端点不需要口令，所以"猜密码"这个攻击面不存在；防滥用靠 §5 的 Cloudflare 限速规则与会话 TTL，而不是靠口令强度。

### 2.4 会话怎么隔离

- **一个访客一条 session。** 每次 demo-login 生成一个新 token（`createSessionToken()`，32 字节随机）写 `sessions` 表，HttpOnly + SameSite=Lax cookie，`path=/`。访客之间互不共享 cookie，A 的登出不影响 B。
- **数据是共享的，这正是只读的意义。** 因为所有写路径都被挡，共享一份只读数据不会产生"别人改了我的邮件"这种问题；`read` / `starred` / 未读数在整个演示站生命周期内保持不变（重置前恒定），演示截图与文案因此可复现。
- **TTL 缩短。** 生产 `SESSION_TTL_MS = 7 天`（`workers/lib/auth.ts:42`）。演示用 1 小时（demo 登录时单独传 TTL，或 `DEMO_MODE` 下取 1h），过期后访客点一下按钮重新进，无感。
- **重置时清会话。** `resetDemoData()` 里 `DELETE FROM sessions`，把所有访客踢出——避免重置后仍有人持有"重置前那个数据版本"的会话去拼凑请求。

### 2.5 定时重置：Cron 为主，登录时惰性兜底

用 **Cron Trigger**，但重置动作是幂等函数，两条触发路径共用：

```text
wrangler.demo.jsonc → "triggers": { "crons": ["0 * * * *"] }
workers/app.ts     → export default { fetch, email, scheduled }
                     scheduled: 若 now - last_reset_at >= 6h → resetDemoData(env)
demo-login         → 同样检查 last_reset_at；过期就当场重置一次再发会话（兜底：Cron 挂了也不会攒出脏数据）
```

- 重置节奏 **6 小时**（Cron 每小时跑但多数时候直接 return，成本可忽略）。理由：一次重置约 400 行写入（见 §5），6 小时一次是 1.6k 行/天；1 小时一次是 9.6k 行/天，虽然也扛得住，但没必要。
- **并发重置要防。** 两个访客同时触发惰性重置会重复写入。用一行元数据表做原子认领：

```sql
-- migrations/0014_demo_meta.sql（只在 demo 库执行）
CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- value = ISO 时间戳；认领语句：
UPDATE demo_meta SET value = ?1 WHERE key = 'last_reset_at' AND value = ?2;
-- changes() == 0 → 别人已经在重置，本次直接发会话，不重复干
```

- 重置内容固定，顺序固定：先删后插，中途失败（D1 报错）时把 `demo_meta.last_reset_at` 回滚成旧值，让下一次触发重试，避免出现"删了一半"的站。所有插入走 `db.batch()`，每批 40 条语句（D1 单批上限 1000 条 / 1MB，40 条留足余量）。
- **不用 Resend/webhook 之类的外部信号做重置触发**——演示站不该有任何外部入口。

### 2.6 前端配合（否则 UI 会因为 403 弹一堆错）

- `GET /api/v1/config` 在 demo 模式下带 `demo: true`（`workers/index.ts:237`）。前端拿到后：顶部一条固定横幅「这是只读演示站，数据每 6 小时重置」（`app/root.tsx`，与现有 `status` 判定并列）；`ComposePanel` / `ComposeEmail` 的新建、回复、转发按钮隐藏；`EmailPanel` 的删除/移动/星标、`Sidebar` 的文件夹增删、`platform-settings` 与 `mailbox_settings` 表单只读；`AiPanel` 输入框禁用，只展示种好的对话。
- `app/services/api.ts:106` 的 `request<T>` 里：`status === 403 && body.code === "demo_read_only"` → 返回一个安静的 rejected promise，不触发 sonner toast。这是兜底，防某个漏改的按钮点了报红。
- 不在 `public/` 加 `robots.txt`：那个目录同时发布到生产站。noindex 只通过 demo 模式下的 `X-Robots-Tag` 响应头实现。

---

## 3. 预置数据从哪来

### 3.1 一份 JSON，两个消费者

`workers/demo/seed-data.json` 是唯一数据源。`scripts/seed-demo.mjs`（一次性、走 `wrangler d1 execute --remote` + `wrangler r2 object put`）和运行时 `workers/demo/reset.ts`（走绑定，Cron/登录触发）都读它，保证"首次种出来的样子 = 每次重置后的样子"。运行时用 `await import("./seed-data.json")` 动态加载，只在 demo 分支被引用，不进生产包路径。

### 3.2 要写哪些存储（按实际落点）

| 落点 | 内容 | 行/对象数 |
| --- | --- | --- |
| **R2** `mailboxes/<email>.json` | 每个邮箱一个：`{fromName, forwarding:{enabled:false,email:""}, signature:{enabled:true,text:"..."}, created_at}`。**故意不写 `resendApiKey` 字段。** | 3 |
| **R2** `attachments/<email_id>/<attachment_id>/<filename>` | 假附件真字节（见 §3.4） | 5 |
| **D1** `folders` | 每个邮箱 6 个系统文件夹（`inbox/sent/draft/archive/trash/spam`，`is_deletable=0`，名字按 `db.initMailboxFolders` 的写法）+ 1 个自定义 `receipts`（`is_deletable=1`） | 21 |
| **D1** `emails` | 见 §3.3 | 128 |
| **D1** `attachments` | `id / email_id / mailbox_id / filename / mimetype / size / content_id / disposition`，`size` 必须等于 R2 对象真实字节数 | 5 |
| **D1** `domains` | `fernhill.studio`（`status='verified'`）、`lumen-mail.dev`（`status='failed'`）；`resend_domain_id` / `resend_api_key` / `cf_zone_id` / `cf_account_id` **全部 NULL** | 2 |
| **D1** `ai_chat_messages` | 8 条只读记录（1 个连贯会话：问「本周未读里哪几封要今天回」，AI 答；再问「给 Anna 起草回复」，AI 给草稿文本）。只展示，不产生调用 | 8 |
| **D1** `admins` | 1 行，`password` 为丢弃明文的 PBKDF2 哈希 | 1 |
| **D1** `platform_settings` | **空表**（种 0 行，并在验收里断言为 0） | 0 |
| **D1** `agent_api_keys` / `agent_api_key_audit` | **空表** | 0 |
| **D1** `sessions` | 运行期产生 | 运行期 |
| **D1** `demo_meta` | `last_reset_at` | 1 |

### 3.3 造多少、造什么

3 个邮箱、128 封邮件：

| 邮箱 | inbox | sent | draft | archive | trash | spam | 小计 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hello@fernhill.studio`（主展示） | 52（其中 8 个线程共 26 封） | 24 | 4 | 10 | 5 | 3 | 98 |
| `billing@fernhill.studio` | 12 | 6 | 0 | 0 | 2 | 0 | 20 |
| `ops@lumen-mail.dev` | 8 | 0 | 2 | 0 | 0 | 0 | 10 |

内容规则（写数据时严格遵守，这几条直接决定演示可信度）：

- **全部虚构**：品牌 Fernhill Studio（设计工作室）、Lumen Labs（供应商），人名用虚构名，域名用不存在的 `fernhill.studio` / `lumen-mail.dev`。不出现任何真实客户、真实邮箱地址、真实订单号。
- **不热链任何外部图片**：邮件正文 HTML 里不放 `<img src="https://...">`（会向第三方泄漏演示访客的 IP，也会让页面变慢、图挂掉）。需要图就用内联 data URI 或直接不放图。
- **线程要真的连起来**：一个线程内 `thread_id` 相同，回复的 `in_reply_to` 指向上一条的 `message_id`，`email_references` 是 `JSON.stringify([...])` 形式（与 `workers/index.ts:759` 的写法一致）。UI 的会话视图依赖这个关系，随便填会显示成散邮件。
- **`date` 用 ISO 字符串**，首封到末封跨最近 21 天；`raw_headers` 是 `[{key,value}]` 数组，key 小写（`from/to/subject/date/message-id`）。
- **已发送的邮件 `send_status='sent'`**（`NULL` 表示"不是发出去的"，`sending` 会转圈），草稿放 `folder_id='draft'` 且 `send_status` 为 `NULL`。
- 未读分布刻意做成已知数：`hello@` inbox 7 封未读、`billing@` 2 封、`ops@` 1 封，3 封星标。重置后这些数字必须精确复现（验收项，§9）。

### 3.4 假附件：要，5 个，真字节

附件是"这个产品能收附件"的直接证据，纯 D1 行而 R2 没对象的话点下载会 404，反而露馅。做法：脚本生成确定性小文件，真实 `put` 进 R2。

| 文件名 | 类型 | 大小 | 内容 |
| --- | --- | --- | --- |
| `fernhill-invoice-2418.pdf` | application/pdf | ~14KB | 单页虚构发票（脚本生成的最小 PDF） |
| `brand-guidelines-v3.pdf` | application/pdf | ~38KB | 几页纯文字 PDF |
| `homepage-mockup.png` | image/png | ~22KB | 纯色带文字的 PNG（脚本用 canvas-free 方式生成或用固定 base64） |
| `q3-metrics.csv` | text/csv | ~2KB | 20 行虚构指标 |
| `contract-draft.docx` | application/vnd.openxmlformats-officedocument.wordprocessingml.document | ~9KB | 最小 docx |

合计 < 90KB。文件名必须过一遍 `workers/lib/attachments.ts:44` 的同款净化正则（`[\/\\:*?"<>|\x00-\x1f]` → `_`），否则 R2 key 与 D1 里的 `filename` 对不上，下载必 404。`attachments.size` 必须写 `bytes.byteLength` 的真实值。

### 3.5 脚本形态

```text
scripts/seed-demo.mjs
  --local      → wrangler dev --local 的本地 D1/R2（实施阶段先在这里验）
  --remote     → demo 库；生成 .tmp/seed.sql（分批，每批 <=40 语句）后
                 npx wrangler d1 execute mailboxes-db-demo --remote --file .tmp/seed.sql -c wrangler.demo.jsonc
                 npx wrangler r2 object put mailboxes-demo/mailboxes/<email>.json --file ... -c wrangler.demo.jsonc
  末尾自检：SELECT COUNT(*) 各表、R2 HEAD 每个对象、断言 platform_settings / agent_api_keys 为空
```

`seed-data.json` 体积预估：128 封 × 平均 1.5KB HTML ≈ 200KB，压缩后约 70KB。Worker 免费版压缩后上限 3MB，且这是只在 reset 路径动态加载的独立 chunk，不影响首页包体。

---

## 4. 安全边界

### 4.1 五条硬边界

1. **演示实例不含任何真实凭据。** 不是"配了但不给用"，是库里根本没有：`domains.resend_api_key` 全 NULL、mailbox JSON 无 `resendApiKey`、`platform_settings` 空表、`wrangler.demo.jsonc` 里没有任何 `vars` / secret 指向真实 key。部署后用一条 SQL 断言（§9）。
2. **访客发不出邮件，有两层保证。** 第一层是 HTTP：`POST .../emails`、`/reply`、`/forward` 全 403。第二层是结构：即便第一层被绕过，`sendEmailFromMailbox`（`workers/email-sender.ts:131-180`）先查 mailbox 设置、再查 `domains.resend_api_key`，两处都没有就 `throw resendApiKeyNotConfigured`——**在任何 fetch 之前**退出，请求到不了 `api.resend.com`。
3. **agent 网关整体关闭。** `/mcp`、`/tools`、`/tools/call` 是外部 LLM 的入口，13 个工具里有 `send_email`、`send_reply`、`delete_email`、`move_email`。演示站即使有人用某种方式拿到 key 也用不了，因为根本没有 key（`agent_api_keys` 空表），且路径本身 403。
4. **AI 对话关闭。** `POST .../ai/chat` 403。这不只是省钱（§5）：AI 面板会执行工具调用，一个精心构造的提示词就能让它尝试 `send_email`。即便最终因无 key 失败，也会写 `emails` 行（`send_status='sending'→'failed'`）、污染演示数据、并在响应里回显内部错误结构。演示版本用 §3.2 那 8 条种好的对话展示 AI 能力，代价是零。
5. **不会被当成注册机 / 发信池。** 应用本身没有多用户注册（`POST /api/v1/setup/admin` 由 `WHERE NOT EXISTS` 保证只能建一次，第二次 409），演示库已预置 admin，且该路径被守卫 403 挡住；演示域名**不挂 Email Routing**（没有 catch-all、没有 MX 规则指向 Worker），所以没人能给演示站投递邮件；演示域名**不是 Resend 已验证发信域**，所以也不存在借用它发 SPF/DKIM 对齐邮件的可能。

### 4.2 额外加固（便宜，都做）

- 响应头 `X-Robots-Tag: noindex, nofollow`（demo 模式下所有响应）。
- `X-Frame-Options` / CSP `frame-ancestors 'self'`：防别人把演示站套进 iframe 当钓鱼页面（邮件正文渲染在 `EmailIframe` 里，需要确认 CSP 不误伤，实施时单独验）。
- Cloudflare 侧：给 demo 主机名配一条 Rate limiting 规则（例如同 IP 60 秒 120 次请求 → block 60 秒），成本零。这是"AI 关了、写也关了"之后唯一还需要兜的滥用面（刷请求把账号 100k/天耗光，会连带影响生产站）。
- 强制 HTTPS（CF 默认）、关闭开发模式；demo 主机名不加入任何 Cloudflare Access / 认证策略（公开站）。
- 日志：`observability.enabled` 保留，但注意 Worker 日志里不要出现种子数据之外的东西（演示库本来就只有假数据）。

### 4.3 明确不做的

- 不做多租户/每个访客独立数据沙箱（需要重构整个数据模型，与"演示"目的不匹配）。
- 不做演示站的可写"沙盒模式"（允许写但隔离）。收益是能体验发信，代价是整套数据分区逻辑 + 一个必定存在的漏配风险，不值。
- 不把 `demo` 标志做成可以被 cookie/query 覆盖（`?demo=1` 之类），那等于给生产站开一个后门。

---

## 5. 成本与额度

免费套餐（Workers Free + D1 Free + R2 Free + Workers AI 免费额度）。数字来源：Cloudflare Workers/D1/R2/Workers AI 官方定价页。

| 资源 | 免费额度 | 演示站估算 | 余量 |
| --- | --- | --- | --- |
| Workers 请求 | 100,000 / 天（账号级，午夜 UTC 重置） | 一次页面访问约 8–14 次 API 调用，按 12 算 → **约 8,000 次页面访问/天**打满 | 静态资源请求不计量，只算 API 与 SSR |
| D1 行读取 | 5,000,000 / 天 | 一次邮件列表约 50 行、一封邮件约 5 行 → 8,000 访客 × 约 300 行 ≈ 2.4M | 中等，见风险 2 |
| D1 行写入 | 100,000 / 天 | 重置约 400 行（删 134 + 插 166）× 4 次/天 = 1.6k；会话 1 行/访客 | 很大 |
| D1 存储 | 5 GB | < 20 MB | 极大 |
| R2 存储 / 操作 | 10 GB / 1M Class A、10M Class B 每月 | < 1 MB；Class A 仅重置时 8 次 | 极大 |
| Workers CPU | 免费版 10ms/请求 | 邮件列表查询与 JSON 序列化均在预算内，但要实测最重的 `/search` | 需实测 |
| Workers AI | **10,000 Neurons / 天（账号级）** | 关闭 → 0 | — |
| Cron Trigger | 免费版可用，每次触发计 1 次请求 | 24 次/天 | 可忽略 |

### 成本风险排序（按"多大概率打爆"）

1. **Workers AI Neurons —— 唯一的真风险，所以直接关掉。** 10,000 Neurons 是**整个 CF 账号共享**的，不是演示站专属。`ai/chat` 每轮会把最近 30 条历史 + 邮件正文塞进 prompt，还带工具调用（最多两轮模型调用），单次对话的 Neuron 消耗是几十到几百量级（**未实测，属估算**）。也就是说**几十次对话就能把当天额度吃光**，之后生产站自己的 AI 也跟着一起瘸。这一条足以否掉"演示站开放 AI"的想法，不需要再比成本。
2. **请求数 100k/天也是账号级共享。** 演示站被人轮询（哪怕只是被某个监控或爬虫每分钟来一遍）会直接吃掉生产的请求额度，表现为生产站当天 429。缓解：限速规则 + `noindex` + 不公开 robots，加上总量监控（见 §6 步骤 7）。
3. **D1 读**在"列表页 + 搜索"上最费（`/search` 走 LIKE 全表扫，`workers/index.ts:937`）。如果单次搜索扫 128 行，这个量级没问题；真正要防的是同一 IP 高频搜索，同样由限速规则处理。
4. **构建产物体积**：种子 JSON 给 demo 专属 chunk，生产包里没有它（动态 import + 只在 demo 分支引用）。若 bundler 没摇掉，会多约 70KB 压缩体积，仍在 3MB 免费上限内，不影响。

结论：**免费套餐够用**，前提是三条一起做到——AI 关闭、6 小时重置、CF 限速规则。任何一条缺失，风险都从"可控"跳到"能拖垮生产"。

---

## 6. 上线步骤

前置：§7 的凭据与授权到手。全程不改生产实例的 `wrangler.jsonc`，不碰生产库。

1. **建分支** `feat/demo-site`，按 §1.5 落地新增文件 + 4 处现有文件改动。`npm test`、`npm run typecheck` 必须绿（现有测试一条不改）。
2. **本地跑通**：`npx wrangler dev --config wrangler.demo.jsonc --local` → 跑 `scripts/seed-demo.mjs --local` → 浏览器点进演示站，确认侧栏、邮件列表、会话视图、附件下载、AI 只读面板都正常。再验守卫：对 §2.2 的写路由逐条 `curl -X POST`，全部 403 且 `code=demo_read_only`。
3. **准备部署脚本** `scripts/deploy-demo.mjs`：把仓库复制到 `mkdtemp` 临时目录（等同 `scripts/setup.mjs` 的做法），在临时目录里把 `wrangler.jsonc` 换成 demo 配置、`npm ci`、`npm run build`、`d1 migrations apply`、`wrangler deploy`。**必须在临时目录做**，原因见 §1.4：仓库根的 `.wrangler/deploy/config.json` 会把任何 `wrangler deploy` 重定向到 `build/server/wrangler.json`（`name: mailboxes`），在主目录部署极容易把 demo 配置或产物对到生产 Worker 上。
4. **创建演示资源**（需授权，本次不做）：`mailboxes-db-demo`（D1）、`mailboxes-demo`（R2）、Worker `mailboxes-demo`。迁移全部 14 个（含 `0014_demo_meta.sql`）。
5. **首次种数据**：`node scripts/seed-demo.mjs --remote`，脚本末尾自检必须全绿。
6. **绑域名与 CF 侧配置**：`demo.<域名>` 自定义域 / Route；限速规则；确认该主机名**不**在 Email Routing 里，**不**在 Resend 域名列表里。
7. **冒烟 + 观察**：跑 §9 的断言清单；上线首 24 小时看 Workers 请求数、D1 读写、Cron 是否按点触发（`observability` 日志里 `scheduled` 一条一行，重置成功/失败都要打点）。

---

## 7. 需要 Doforu 提供什么

必给：

1. **Cloudflare 账号写权限**，用于创建第二个 Worker + D1 + R2：`wrangler login` 交互登录，或一枚 API Token（权限：Account · Workers Scripts:Edit、D1:Edit、R2:Edit；Zone · DNS:Edit / Workers Routes:Edit）。这一项本身就是"申请新 Cloudflare 资源"，需要明确批准。
2. **演示域名或子域**：建议 `demo.<某个已有域>`。同时确认该 zone **没有**指向 Worker 的 Email Routing catch-all，**不是** Resend 已验证发信域（否则演示站会顺带拥有收信/发信身份）。
3. **公开访问授权**：明确"允许任意人无门槛访问"。若要求人机校验，另需 Turnstile 的 site key / secret（会产生一个前端组件与一次服务端校验的额外工作，约 +0.5 人日）。
4. **文案与品牌确认**：虚构品牌名（本方案用 Fernhill Studio / Lumen Labs）、是否可用 Doforu logo、页脚声明用哪种语言、重置周期是否就定 6 小时。

明确**不要**给：Resend API key、真实 CF API token、任何真实邮箱内容或客户数据。演示站不需要，也不应该持有。

不需要新建的东西也别顺手建：自定义 SMTP、额外 Resend 域名、Email Routing 规则——一个都不要。

---

## 8. 工作量估计

| 工作项 | 人日 |
| --- | --- |
| 守卫中间件 + demo-login + reset + demo 配置（含 `0014` 迁移、`scheduled` 导出） | 1.5 |
| 前端适配（横幅、隐藏写操作、403 静默、登录页入口、AI 面板只读） | 1.0 |
| 种子内容撰写（128 封邮件 + 8 个线程 + 8 条 AI 记录 + 附件生成） | 2.0 |
| `seed-demo.mjs` + 本地端到端验证 | 1.0 |
| `deploy-demo.mjs`（临时目录构建，绕开重定向）+ CF 侧配置 | 0.5 |
| 守卫反向用例与验收（每条写路由一条 403 断言，写进 `workers/demo/*.test.ts`） | 1.0 |
| 文档（README 一节 + 运维说明） | 0.5 |
| **合计** | **7.5 → 实际按 6～7 人日排**（内容撰写与前端适配有重叠） |

可压缩路径：邮件数从 128 减到 60、AI 面板整块不展示 → **约 4 人日**。不建议砍的是守卫测试（§9 那批用例），它是整个方案唯一的"只读"证据。

---

## 9. 验收（每条都可执行、可复跑）

```bash
DEMO=https://demo.<domain>
# 1) 能进
curl -s -X POST $DEMO/api/v1/auth/demo-login -c c.txt -o /dev/null -w '%{http_code}\n'   # 200
# 2) 能读
curl -s -b c.txt "$DEMO/api/v1/mailboxes" | head -c 200                                   # 3 个邮箱
curl -s -b c.txt "$DEMO/api/v1/mailboxes/hello%40fernhill.studio/emails?folder=inbox&limit=5" | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' -b c.txt "$DEMO/api/v1/mailboxes/hello%40fernhill.studio/emails/<id>/attachments/<aid>"  # 200
# 3) 一个字都写不进去（下面每条都必须 403，body 带 demo_read_only）
for path in "/api/v1/mailboxes" "/api/v1/mailboxes/hello%40fernhill.studio" \
            "/api/v1/mailboxes/hello%40fernhill.studio/emails" \
            "/api/v1/mailboxes/hello%40fernhill.studio/drafts" \
            "/api/v1/mailboxes/hello%40fernhill.studio/ai/chat" \
            "/api/v1/domains" "/api/v1/platform-settings/cf_api_token" "/mcp" "/tools/call"; do
  printf '%s -> ' "$path"; curl -s -o /dev/null -w '%{http_code}\n' -X POST -b c.txt "$DEMO$path"
done
# 4) 没有可用的发信/登录凭据
npx wrangler d1 execute mailboxes-db-demo --remote -c wrangler.demo.jsonc \
  --command "SELECT (SELECT COUNT(*) FROM domains WHERE resend_api_key IS NOT NULL)  AS resend_keys,
                    (SELECT COUNT(*) FROM platform_settings)                       AS settings,
                    (SELECT COUNT(*) FROM agent_api_keys)                          AS agent_keys,
                    (SELECT COUNT(*) FROM admins)                                  AS admins"
# 期望：0 / 0 / 0 / 1
# 5) 常规登录必失败（演示口令不存在）
curl -s -X POST $DEMO/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' -o /dev/null -w '%{http_code}\n'   # 401
# 6) 注册不可用
curl -s -o /dev/null -w '%{http_code}\n' -X POST $DEMO/api/v1/setup/admin -d '{}' # 403
# 7) 重置可复现：等到下一个重置点后统计必须精确回到基线
npx wrangler d1 execute mailboxes-db-demo --remote -c wrangler.demo.jsonc \
  --command "SELECT mailbox_id, COUNT(*) FROM emails WHERE folder_id='inbox' AND read=0 GROUP BY 1"
# 期望：hello@=7, billing@=2, ops@=1
# 8) 不应被搜索引擎/第三方嵌套
curl -sI $DEMO/ | grep -i 'x-robots-tag'    # noindex, nofollow
```

另需自动化断言（`workers/demo/guard.test.ts`）：以 `workers/lib/auth-401-challenge.test.ts` 的写法搭一个最小 Hono 上下文，对 §2.2 表格里**每一条**路由发请求并断言 403 + code，同时断言 `DEMO_MODE` 未设时同一路由不被守卫拦截（反向对照——否则测试会在生产配置下也变绿，等于没测）。

---

## 10. 实施时最可能踩的三个坑（按概率排序）

1. **只种了 D1，忘了 R2 的 `mailboxes/<email>.json`。** `requireMailbox` 先 HEAD R2（`workers/lib/d1-middleware.ts:60`），缺对象直接 404 —— 界面上表现为"点进邮箱什么邮件都没有"，而 `SELECT COUNT(*) FROM emails` 明明有 128 行，排查方向会被带偏。重置函数必须同时重建 R2 对象，而不只是清 D1。
2. **`.wrangler/deploy/config.json` 的重定向。** 它指向 `build/server/wrangler.json`，在那份产物里 `name` 是 `mailboxes`。在仓库根目录跑 `wrangler deploy -c wrangler.demo.jsonc`，有把 demo 配置/产物打到生产 Worker 上的实际风险（或者反过来，把生产的旧产物发布到 demo）。只走 `deploy-demo.mjs` 的临时目录路径。
3. **附件 D1 行与 R2 key 不一致。** key 是 `attachments/<email_id>/<attachment_id>/<净化后的 filename>`，`filename` 里只要有一个 `:` 或 `/` 没净化，DB 里存的名字与 R2 的 key 就对不上，点下载 404 —— 而 D1 里那行看起来完全正常。

---

## 11. 本方案的边界

本文只到"方案"。没有创建任何 Cloudflare 资源，没有部署，没有改动任何现有代码或配置，也没有提交。§6 的步骤 1 之后的一切都依赖 §7 的授权。

工作副本里 `wrangler.jsonc`（D1 id）与 `README.md` / `README.zh-CN.md` 的未提交改动不属于本次任务，本任务只新增了 `docs/demo-site-plan.md` 这一个文件。
