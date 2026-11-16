# Mailboxes 后续方案

> 基线：`main@2052421`（2026-11-17）。会话开始时本地只有 `wrangler.jsonc` 一处未提交改动，与本方案无关。
> 本文只做方案，不含任何代码/配置改动、部署或提交。文中所有"工作量"按 1 人熟悉本仓库计（人日）。
> 所有免费额度数字取自 Cloudflare 官方文档（2026-10 版），链接与出处见各节末尾。

---

## 0. 结论摘要

| 事项 | 结论 | 工作量 |
| --- | --- | --- |
| 自动回复（规则 + agent 起草 + 人审后发） | **先做**。只做"起草"档就保留人审约束；顺带把现在"agent 其实能直接发"的漏洞补上 | 4 天 |
| 团队共享邮箱（多用户 + 权限） | **后做**。改动穿过 session、中间件、14 个工具、前端；对当前"单管理员"用户是零收益 | 9 天 |
| 邮件语义检索 | **不要按直觉做**。Vectorize 免费额度按官方计费口径撑不住全量索引，先用 D1 FTS5 + 重排 | 1.5 天（FTS5 版）／3–5 天（向量版且需付费） |
| 线程摘要 | **三件事里最值得先做**。零新基础设施，直接改善 agent 对长线程的理解 | 1 天 |
| 每日来信简报 | 第二次做。需要新增 cron 触发（当前 `wrangler.jsonc` 没有任何 `triggers`） | 1.5 天 |
| 分发 | 五个渠道里**最可能拿到 star 的是 HelloGitHub 与 V2EX**，理由见 §3.1 末尾 | 文案已就绪 |

---

## 一、两个功能缺口

### 1. 自动回复

#### 1.1 先纠正一个前提：「发送必须人确认」目前不是硬约束

这一点决定整个方案怎么写，所以放在最前。

- `send_email` / `send_reply` 是 14 个工具里的两个，定义在 `workers/lib/tool-dispatch.ts:289` 与 `:307`，实现是 `workers/lib/tools.ts:1083`（`toolSendEmail`）与 `:963`（`toolSendReply`）。
- 内建对话面板的链路 `POST /api/v1/mailboxes/:mailboxId/ai/chat`（`workers/index.ts:1098`）调用 `callAi(..., withTools = true)`，塞进去的 `tools` 就是全量 `TOOL_DEFINITIONS`，**没有过滤**。
- 外部 `/tools` 与 MCP（`workers/lib/external-tools.ts`）对 `all` scope 的 key 同样放行这两个工具。

也就是说：「agent 只写草稿、发不发由你」现在靠的是工具描述里的一句提示（`tool-dispatch.ts:185` 的 `"The user must review and confirm before sending."`）和模型自觉。要做自动回复，必须先把这个口子关掉，否则"人审"无从谈起。

**第一步改动（半天）**：给 `executeToolCall`（`workers/lib/tool-dispatch.ts:416`）加一个 `sendPolicy: "allow" | "draft-only"` 参数：

| 调用方 | 传什么 | 效果 |
| --- | --- | --- |
| 内建面板 `/ai/chat` | `draft-only` | 模型调 `send_email`/`send_reply` 时直接返回结构化错误，引导它改调 `draft_email`/`draft_reply` |
| 自动回复 worker | `draft-only` | 同上，规则永远只能产出草稿 |
| 外部 `/tools`、MCP、UI 发送接口 | `allow` | 保持现状（人已持有 key/session，等价于人审） |

错误文案复用 `workers/lib/external-tools.ts:286` 的 `readOnlyKeyError` 写法：点名工具、说明唯一合法的替代工具。这样模型会自我纠正而不是重试。

#### 1.2 规则存哪张表

新增迁移 `migrations/0014_auto_reply.sql`（现有迁移到 `0013_agent_api_keys.sql`）：

```sql
-- 自动回复规则。一条规则 = 一组匹配条件 + 一个动作。
CREATE TABLE IF NOT EXISTS auto_reply_rules (
  id                TEXT PRIMARY KEY,
  mailbox_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 100,   -- 小的先匹配，命中即停
  match_sender      TEXT,      -- 逗号分隔的 glob：*@github.com, boss@acme.com
  match_subject     TEXT,      -- 逗号分隔的子串（不区分大小写）
  match_folder      TEXT,      -- 仅匹配某个文件夹（如 "spam" 反选场景）
  action            TEXT NOT NULL DEFAULT 'draft',  -- draft | draft_notify
  instruction       TEXT,      -- 追加给模型的写作要求："用英文，报价格用去年数据"
  max_per_sender_day INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_reply_rules_mailbox
  ON auto_reply_rules(mailbox_id, enabled, priority);

-- 幂等与审计：一封来信一条规则只处理一次。
CREATE TABLE IF NOT EXISTS auto_reply_log (
  id         TEXT PRIMARY KEY,
  rule_id    TEXT NOT NULL,
  email_id   TEXT NOT NULL,
  draft_id   TEXT,
  status     TEXT NOT NULL,   -- pending | drafted | skipped | failed
  reason     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_reply_log_once
  ON auto_reply_log(rule_id, email_id);
```

为什么是两张表、为什么不用 JSON 条件列：匹配要能走索引、要能在一个查询里按 priority 排序；`auto_reply_log` 的唯一索引是整个方案的回滚锚点（见 §1.5），JSON 存不进唯一约束里。

标签（label）维度：本项目的"标签"就是文件夹（`shared/folders.ts:16` 的 `Folders`），所以 `match_folder` 即可覆盖"打标签触发"，不要为它新造一套标签系统。

#### 1.3 在哪触发

唯一触发点放在 `workers/inbound.ts:131` 的 `handleResendInbound` 里，且在 `createEmail` 成功之后（`workers/inbound.ts:330`）：

```ts
await dbService.createEmail(db, mailboxId, Folders.INBOX, {...}, attachmentData);

// 新增：入站落库成功后再评估规则，失败不得影响收信
const emailId = messageId; // inbound.ts:225 生成的 messageId
ctx.waitUntil(
  evaluateAutoReply({ env, mailboxId, emailId, threadId, sender, subject })
    .catch((e) => console.error("[auto-reply] evaluate failed", e)),
);
return { ok: true };
```

三条必须守住的细节：

1. **必须 `waitUntil`，不能在请求里同步跑。** Resend webhook 有超时，起草要调模型（秒级），同步跑会让 Resend 判定失败并重投。
2. **必须 try/catch 到底。** 自动回复是增强，不是收信主链的一环；它炸了邮件也得在 Inbox 里。
3. **必须先查重再起草。** 见 §1.5 的第 1 条。

新文件 `workers/lib/auto-reply.ts`，导出 `evaluateAutoReply()`：

1. 查 `auto_reply_rules where mailbox_id=? and enabled=1 order by priority`；
2. 逐条匹配 sender（glob）/subject（子串）/folder；命中第一条就停（`priority` 语义）；
3. 查 `max_per_sender_day`：统计当日该发件人已 `drafted` 的条数，超了写 `skipped`；
4. `INSERT INTO auto_reply_log (... status='pending')`，靠唯一索引挡并发与重投；冲突则直接返回；
5. 用 `callAi`（复用 `workers/index.ts:1042`，含 OpenAI 兼容 provider 与 CF 回退）生成正文，prompt 里带：原邮件正文（截断 4k 字符）、同线程最近 3 封、`instruction`、以及"这是自动起草，必须留出人工确认"的硬提示；
6. 调 `toolDraftReply`（`workers/lib/tools.ts:401`）落草稿到 Drafts，拿 `draftId`；
7. 更新 log 为 `drafted` + `draft_id`；任何一步抛错 → `failed` + `reason`。

草稿直接进 Drafts 文件夹是刻意的：前端 `app/routes/email-list.tsx` 里已经有了草稿列表和"点发送"的动作，不需要新 UI 就能完成人审闭环。

#### 1.4 怎么和「发送必须人确认」共存

三档，只上第一档，后两档作为可选项写清楚边界：

| 档位 | 行为 | 人审约束 | 建议 |
| --- | --- | --- | --- |
| **A. draft（默认，本次做）** | 规则命中 → 草稿进 Drafts → 人点发送 | 完全保留：`sendPolicy: draft-only` 硬闸，自动回复进程拿不到发送能力 | 做 |
| B. draft + 通知 | 同 A，另在规则上加"给我发一封提醒邮件" | 同 A | 做（前端一个开关，复用 `email-sender.ts`） |
| C. auto-send | 规则命中直接发 | 靠规则本身当预授权 | **不建议现在做**。若要做，前置条件：发件人白名单 + 每发件人每日上限 + 全站 `platform_settings` 总开关 + 设置页二次输入本邮箱地址确认 + `auto_reply_log` 全量留痕。即便做了，agent 自身的工具仍然保持 draft-only——自动发送是"规则"的能力，不是"模型"的能力 |

这一条要写进 README/文档：**发送权属于人持有的 session，或属于人显式开启的规则；永远不属于模型。**

#### 1.5 失败与回滚

| 失败点 | 现象 | 处理 |
| --- | --- | --- |
| Resend 重投同一封信 | 现在会插入重复邮件：`workers/inbound.ts:225` 的 `messageId = crypto.randomUUID()` 每次新生成，`emails.id` 是它，而 `message_id`（原邮件 Message-ID）在 schema 里没有唯一约束（`workers/db/schema.ts:39`）。重投 → 同一封信两条记录 → 自动回复起草两次 | **做自动回复之前先补**：`CREATE UNIQUE INDEX idx_emails_mailbox_message ON emails(mailbox_id, message_id) WHERE message_id IS NOT NULL;`（放在 0014 迁移里），`createEmail` 冲突时改成幂等返回已有行。这是自动回复幂等的地基 |
| 规则匹配崩了 | 收信正常 | try/catch + `console.error`，不影响 webhook 返回 |
| 模型超时/不可用 | 无草稿 | log `failed`，邮件留在 Inbox，人手工回；不做自动重试（重试等于给模型更多机会重复花钱） |
| 草稿建了、人不要 | Drafts 里多一封 | 前端已有 `discard_draft`（`workers/lib/tool-dispatch.ts:278`），零开发 |
| 规则写错，批量乱起草 | 大量草稿 | 禁用规则（`enabled=0`）立即生效；`auto_reply_log` 提供按 rule_id 的清单，一条 SQL 找出所有 `draft_id` 批量丢弃；草稿不会自动外发，最坏结果是脏草稿而非误发信 |
| 起草消耗超预算 | 神经元日额度被打满 | 规则级 `max_per_sender_day` + 全局：单邮箱每日自动起草上限（存在 `platform_settings`，默认 20），命中即 `skipped` |

整体回滚：`enabled=0` 或删规则即可，无数据迁移、无副作用残留。代码回滚只要摘掉 `workers/inbound.ts` 里那一个 `waitUntil` 块。

#### 1.6 落地步骤

1. 迁移 `0014_auto_reply.sql`：三张表 + `emails` 的 `(mailbox_id, message_id)` 唯一索引；`createEmail`（`workers/db/index.ts:348`）改成冲突幂等，补一个"重投同一封信只落一条"的单测（参考 `workers/db/db.test.ts` 的写法）。
2. `executeToolCall` 加 `sendPolicy` 参数，三个调用点各传一份（`workers/index.ts` 的 `/ai/chat`、`workers/lib/external-tools.ts:493`、自动回复）；补测试：面板路径调 `send_email` 必须返回错误且指名 `draft_email`。
3. 新增 `workers/lib/auto-reply.ts`（匹配 + 起草 + 记账），纯函数部分（匹配、限额计算）单独可测。
4. `workers/inbound.ts` 挂 `waitUntil`；`workers/inbound.test.ts:323` 附近现在断言了 `waitUntil` 调用次数为 0，需要同步改成"仅在命中规则时调用"。**这是唯一会破坏现有测试的地方，先改测试再改代码。**
5. 路由：`GET/POST/PATCH/DELETE /api/v1/mailboxes/:mailboxId/auto-reply-rules`，走 `requireMailbox`（`workers/lib/d1-middleware.ts:53`）；`GET .../auto-reply-log` 供设置页看"哪封信被起草了"。
6. 前端 `app/routes/mailbox_settings.tsx` 加一栏"自动回复"：规则列表 + 开关 + 条件输入 + 试跑按钮（对指定 emailId 跑一次 dry-run，不落草稿）。复用 `app/components/AgentApiKeysSection.tsx` 的列表/弹窗写法。
7. 文案进 `shared/i18n`（三语，现有 i18n 骨架已支持）。
8. 验收：见 §1.7。

#### 1.7 工作量与验收

4 人日：迁移 + 幂等 0.5、`sendPolicy` 0.5、`auto-reply.ts` 1、路由 0.5、前端 1、测试与回归 0.5。

验收（可复跑）：
- 往 catch-all 发一封 `*@github.com` 的信，30 秒内 Drafts 出现草稿，`auto_reply_log` 一行 `drafted`；
- 同一封信重投一次，草稿数仍为 1，`auto_reply_log` 仍 1 行；
- 把模型调用强制失败（临时改 baseURL），邮件仍进 Inbox，log 为 `failed`；
- 面板里让 agent 说"帮我把这封回复发出去"，它必须收到"只允许草稿"的拒绝并改调 `draft_reply`；
- 关掉规则后不再产生新草稿。

---

### 2. 团队共享邮箱

#### 2.1 现状（决定了改动面）

| 位置 | 现状 |
| --- | --- |
| `workers/db/schema.ts:1:99` | 没有 `users` 表，没有成员/权限表；邮件只有 `mailbox_id` 列做隔离 |
| `migrations/0011_admins.sql` | `admins(id, username UNIQUE, password, created_at, updated_at)`，单管理员语义靠"表里只有一行"维持 |
| `migrations/0009_sessions.sql` | `sessions(token, created_at, expires_at)`——**session 不绑定任何用户** |
| `workers/lib/auth.ts:133:152` | `requireAuth` 只校验 cookie 对应 session 未过期 |
| `workers/lib/d1-middleware.ts:53:70` | `requireMailbox` 只做 `BUCKET.head(mailboxes/<id>.json)`，**没有任何归属校验** |
| 邮箱本身 | 不是 D1 表，是 R2 对象 `mailboxes/<email>.json`（`workers/index.ts:302` 创建） |
| `workers/lib/email-helpers.ts:33:41` | `listMailboxes` 直接 `bucket.list({prefix:"mailboxes/"})`——**列出实例上所有邮箱** |

推论：今天"多用户"是被"只有一个人能登录"这个事实挡住的，不是被任何一行鉴权代码挡住的。一旦放开第二个账号，`requireMailbox` 和 `list_mailboxes` 会立刻变成越权入口。

#### 2.2 表结构改动

`migrations/0015_teams.sql`：

```sql
-- 1) admins → users（保留数据，最小改名）
ALTER TABLE admins RENAME TO users;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';   -- owner | admin | member
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN disabled_at TEXT;                       -- NULL = 可登录
UPDATE users SET role = 'owner' WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1);

-- 2) 会话绑定用户
ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- 老 session 的 user_id 为 NULL：登录态一次性失效，需要重新登录（可接受，提前在 CHANGELOG 说明）

-- 3) 邮箱成员关系（邮箱本身仍在 R2，这里只存归属）
CREATE TABLE IF NOT EXISTS mailbox_members (
  mailbox_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',  -- owner | member | reader
  created_at TEXT NOT NULL,
  invited_by TEXT,
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_members_user ON mailbox_members(user_id);

-- 4) 邀请（第二阶段）
CREATE TABLE IF NOT EXISTS mailbox_invites (
  token      TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  email      TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT
);
```

为什么用 `ALTER TABLE admins RENAME TO users` 而不是新建 `users` 再搬数据：`workers/lib/auth.ts` 与 `workers/db/index.ts:1640` 附近的 `countAdmins`/`getAdminByUsername` 只需改表名与新增列，查询逻辑不动；搬数据的写法会让"未初始化状态"判定（`workers/lib/auth.ts:191` 的 `GET /setup/admin/status`）在迁移期间出现双源，风险更大。

#### 2.3 会话与权限模型

1. `requireAuth`（`workers/lib/auth.ts`）在拿到 session 后追加一次 `users` 查询，把 `c.set("user", {id, username, role})`。session 里存 `user_id`，不再靠"只有一个管理员"隐式推断。
2. 新增 `requireMailboxRole(minRole)` 中间件，挂在现有 `requireMailbox` 之后：

```ts
// workers/lib/d1-middleware.ts
export const requireMailbox = createMiddleware(...)        // 保留：R2 存在性 + 注入 db/mailboxId
export const requireMailboxRole = (min: Role) => createMiddleware(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: t("unauthorized") }, 401);
  if (user.role === "owner") return next();                 // 实例 owner 全场通行
  const row = await getMembership(c.env.DB, c.var.mailboxId, user.id);
  if (!row) return c.json({ error: t("notAMember") }, 404); // 404 而非 403：不暴露邮箱是否存在
  if (rank(row.role) < rank(min)) return c.json({ error: t("insufficientRole") }, 403);
  c.set("mailboxRole", row.role);
  await next();
});
```

3. 三档角色 + 实例角色：

| 角色 | 能做什么 |
| --- | --- |
| 实例 `owner` | 建/删域名、建/删邮箱、改平台设置、任命 `admin` |
| 实例 `admin` | 建/删邮箱（不能动域名与平台令牌） |
| 邮箱 `owner` | 改邮箱设置（签名、转发、Resend key）、加删成员、删邮箱 |
| 邮箱 `member` | 读、写草稿、发送（若实例允许）、移动、删除 |
| 邮箱 `reader` | 只读，等价于 API key 的 `read` scope |

4. **关键复用**：`reader` 的工具白名单不要再手写一份，直接用 `workers/lib/external-tools.ts:252` 的 `isReadOnlyTool()` / `:265` 的 `scopeAllowsTool()`。否则"MCP 说安全的工具"和"reader 能跑的工具"会随时间漂移——这个仓库已经在 `external-tools.ts:200` 的注释里明确反对维护第二份清单。

#### 2.4 对 14 个工具的影响

按 `workers/lib/tool-dispatch.ts:108` 的 `TOOL_DEFINITIONS` 逐个过：

| 工具 | 类型 | 最低角色 | 需要的改动 |
| --- | --- | --- | --- |
| `list_mailboxes` | 读 | 任一成员 | **必须改**：`toolListMailboxes`（`workers/lib/tools.ts:263`）现在 `listMailboxes(env.BUCKET)` 列全实例；改成按 `user_id` 查 `mailbox_members`（`owner` 例外全列）。签名要从 `(env)` 变成 `(env, userId)` |
| `list_emails` | 读 | reader | 无（`mailboxId` 已由中间件收窄） |
| `search_emails` | 读 | reader | 无 |
| `get_email` | 读 | reader | 无 |
| `get_thread` | 读 | reader | 无 |
| `draft_reply` | 写 | member | 工具层加 policy 校验（`draft-only` 场景下这是唯一允许的写动作） |
| `draft_email` | 写 | member | 同上 |
| `update_draft` | 写 | member | 同上 |
| `mark_email_read` | 写 | member | 同上 |
| `move_email` | 写 | member | 同上 |
| `delete_email` | 写（破坏性） | member | 同上；`reader` 明确拒绝 |
| `discard_draft` | 写（破坏性） | member | 同上 |
| `send_reply` | 写（外发） | member + `sendPolicy=allow` | 两重闸：角色 + 策略 |
| `send_email` | 写（外发） | member + `sendPolicy=allow` | 同上 |

实现落点：`executeToolCall` 增加 `auth: { userId, mailboxRole, sendPolicy }`，在 `switch` 前统一拦一次，不要在 14 个 `case` 里各写一遍。

**API key 与成员关系取交集**：`agent_api_keys.allowed_mailboxes`（`migrations/0013_agent_api_keys.sql`）允许的范围不能放大持有者的权限。规则：key 能访问的邮箱 = `allowed_mailboxes` ∩ 该 key 绑定用户所属的邮箱。否则一个 `all` scope、`allowed_mailboxes` 为 NULL 的 key 会在团队版里变成"全实例通行证"。

#### 2.5 怎么平滑上线

1. **第 0 步（不改行为）**：先做 §1 的 `sendPolicy` 与 §2.4 的 `list_mailboxes` 收窄。这两处是纯粹的漏洞修补，单人环境下行为等价。
2. **迁移 0015 上线，功能关闭**：`platform_settings` 写 `teams_enforce = "0"`。此时 `requireMailboxRole` 挂上但内部短路（开关关 → 一律视为 instance owner），行为与今天完全一致。
3. **回填成员关系**：`mailboxes/` 是 R2 对象，SQL 迁移读不到 R2，必须由代码回填。给 `workers/lib/auth.ts` 增加一个一次性接口 `POST /api/v1/admin/backfill-members`（要求 session + 一次性 token 存在 `platform_settings`，跑完自删）：遍历 `listMailboxes(BUCKET)`，给首个 `owner` 用户写一行 `mailbox_members(mailbox_id, user_id, 'owner')`。同时 `npm run setup` / `deploy.sh` 里加一条调用提示，避免用户漏跑。
4. **开关打开**：`teams_enforce = "1"`。此时如果有人发现自己的某个邮箱不见了，说明回填漏了——用同一个接口重跑（幂等：`INSERT OR IGNORE`）。
5. **前端**：`GET /api/v1/mailboxes`（`workers/index.ts:273`）改成 join `mailbox_members`；`POST /api/v1/mailboxes` 要求实例 `owner/admin`；`app/routes/mailbox_settings.tsx` 增加成员管理（列表、邀请、改角色、移除）。

回滚：`teams_enforce = "0"` 即退回今天的语义（所有已登录用户能访问所有邮箱）。表只增不改，不需要回滚迁移。

**唯一不可逆的代价**：`sessions.user_id` 为 NULL 的老会话全部失效，所有人需重新登录一次。写进 CHANGELOG 与升级提示即可。

#### 2.6 工作量与验收

9 人日：迁移 + 回填接口 2、auth/session 1.5、`requireMailboxRole` + 工具鉴权 2、`list_mailboxes` 与 API key 交集 1、前端成员管理 2、越权回归测试 0.5。

验收（必须写成可复跑的 e2e，`e2e/` 已有骨架）：
- 用户 B 不是 `hello@` 成员：`GET /api/v1/mailboxes/hello@.../emails` → 404；带 key 调 `/tools` 的 `get_email` → 同样拒绝；
- 用户 B 是 `reader`：5 个读工具全部通过，`draft_reply`/`send_email`/`delete_email` 全部拒绝且错误里点名 `read` 角色；
- `list_mailboxes` 对 B 只返回其加入的邮箱；
- 实例 `owner` 能看到全部邮箱；
- 关闭开关后，上述所有拒绝行为消失（证明回滚路径有效）。

---

### 3. 两块功能的优先级

**先自动回复（4 天），后共享邮箱（9 天）。** 三条理由：

1. **正交性**：自动回复只碰 `inbound.ts` 一个挂点 + 两张新表，可以独立上线、独立回滚；共享邮箱要改 `auth.ts`、`d1-middleware.ts`、`tool-dispatch.ts`、两个路由文件、前端列表与设置页，任何一处漏改就是越权。
2. **受众**：定位是"$0、自己用、给你的 agent 一个地址"。这个人群的第一诉求是"少干活"，不是"多人协作"；共享邮箱的典型用户是"小团队共用 support@"，而这批人更可能直接用付费产品。
3. **顺带收益**：自动回复要先做 `sendPolicy` 硬闸，这恰好补上了「agent 其实能直接发」这个漏洞——它是后续做任何"自动动作"（含共享邮箱里的自动分派）的前置条件。

---

## 二、把 agent 的记忆做深

三件事的前提数字（都是本仓库现实量级）：单邮箱历史 3,000–10,000 封，正文平均 2–4KB，一封约 400–900 tokens。Workers AI 免费额度 10,000 neurons/天（每账号每天，与对话共享）。

### 1. 邮件语义检索

#### 结论：别一上来就上 Vectorize，免费额度按官方口径撑不住

先把数学摆出来，再谈选型。

**Vectorize 免费额度**：存储 5M 维度 / 月，查询 30M 维度 / 月，索引上限 100 个/账号（`developers.cloudflare.com/vectorize/platform/pricing`）。

**bge-m3**（`@cf/baai/bge-m3`，1024 维，支持中文，8k 上下文）：5,000,000 ÷ 1024 ≈ **4,880 条向量**。也就是一封一向量时，一个邮箱最多索引约 4,900 封——刚够一个用了两三年的个人邮箱，团队多人共用一个邮箱就立刻溢出。

**查询侧更麻烦**。官方计费口径（同页"Calculating vector dimensions"示例）是：

```text
queried dimensions = (库内向量数 + 查询次数) × 维度
```

按这个口径，索引里有 1,000 封（=1,000 向量，1024 维）时，一次查询约 `(1000+1)×1024 ≈ 1.02M` 维度，30M/月只够 **约 29 次查询**。这显然不能当产品功能用。

这个口径看起来与 ANN（topK）检索的直觉不符，可能只是官方给"最坏情况"的保守估算；但**在没实测账单之前不能按乐观口径做设计**。所以：

| 方案 | 免费额度是否够 | 结论 |
| --- | --- | --- |
| Vectorize 全量索引 | **不够**（存储 4,900 封封顶，查询按官方公式只够个位数次/月） | 不做主路径 |
| Vectorize 只索引"最近 90 天" | 边界内可行（个人邮箱 90 天 ≈ 200–600 封 → 查询约 0.2–0.6M 维度/次 → 50–150 次/月），仍偏紧 | 可做**可选增强**，默认关闭 |
| D1 FTS5 + bge-reranker 重排 | **够，且无额度概念** | 做这个 |

**bge-reranker-base** 的价格是关键：$0.003 / M input tokens，283 neurons/M。一次重排 20 条候选 × 300 tokens = 6,000 tokens ≈ 1.7 neurons——比一次对话便宜三个数量级。所以"关键词召回 + 模型重排"在免费额度下完全可持续。

FTS5 在 D1 是支持的（`developers.cloudflare.com/d1/sql-api/sql-statements`：D1 支持 FTS5 模块，含 `fts5vocab`）。中文要注意分词：默认 `unicode61` 对中文几乎不切词，必须用 `tokenize='trigram'`（SQLite 3.34+），代价是索引体积变大、短查询（<3 字）不命中——需要在实现里对中文查询做长度兜底（不足 3 字时退回现有 `LIKE` 路径）。

#### 落点

| 文件 | 改动 |
| --- | --- |
| `migrations/0016_email_fts.sql` | `CREATE VIRTUAL TABLE emails_fts USING fts5(subject, body, content='emails', content_rowid='rowid', tokenize='trigram');` + 三个触发器（`AFTER INSERT/UPDATE/DELETE ON emails`）保持同步 + 一次 `INSERT INTO emails_fts(emails_fts) VALUES('rebuild')` 回填 |
| `workers/db/index.ts`（`searchEmails:1024`、`countSearchResults:1060`） | 增加 `mode: "keyword" | "semantic"`；`semantic` 走 FTS5 + 候选池扩大到 40 |
| 新 `workers/lib/rerank.ts` | 调 `@cf/baai/bge-reranker-base` 对候选重排，取前 8；失败则直接返回关键词顺序（降级不报错） |
| `workers/lib/tool-dispatch.ts:139` | `search_emails` 参数加可选 `semantic: boolean`，**不新增工具**——模型已经会用 `search_emails`，多一个工具只会增加选错概率 |
| 可选：`wrangler.jsonc` 加 `vectorize` 绑定 + `workers/lib/embedding.ts` | 只有决定上"最近 90 天向量"时才加；注意这是配置改动，需要用户单独批准 |

工作量：FTS5 + 重排 1.5 天；再加 Vectorize 可选增强 +3 天（其中 0.5 天用于实测一次真实账单，验证查询计费口径）。

### 2. 线程摘要

#### 结论：三件事里最值得先做（1 天）

理由是它零新基础设施：不需要新绑定、不需要 cron、不需要回填历史，全部落在 D1 + 现成的 `callAi`。

**成本**（按免费账号的实际可用模型算）：`workers/index.ts:1247` 的首选模型 `@cf/moonshotai/kimi-k2.6` 在官方定价页被标注为"需要付费计费方式"，免费账号上它会失败并回退到 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（26,668 neurons/M 输入、204,805/M 输出）。一条 3,000 输入 + 400 输出的摘要 ≈ 80 + 82 ≈ **162 neurons**，10,000/天 ≈ **约 60 条/天**。所以必须缓存，不能每次打开线程都重算。

**落点**

| 文件 | 改动 |
| --- | --- |
| `migrations/0017_thread_summaries.sql` | `thread_summaries(mailbox_id, thread_id, last_email_id, summary TEXT, model TEXT, created_at, PRIMARY KEY(mailbox_id, thread_id))` |
| `workers/lib/summarize.ts`（新） | `summarizeThread(db, ai, bucket, mailboxId, threadId)`：读 `getThreadEmails`，拼成紧凑对话流，调模型出 3–5 条要点 + "谁在等谁回复"；命中缓存（`last_email_id` 未变）直接返回 |
| `workers/lib/tool-dispatch.ts:169` | `get_thread` 加可选 `summarize: boolean`，返回体里带 `summary` 字段（工具数不变） |
| `workers/inbound.ts:330` 之后 | 线程内邮件数 > 5 且缓存过期时，`waitUntil` 预热一次 |
| `app/components/` 线程视图 | 顶部折叠区展示摘要 + "重新生成"（重算要显式点，防止刷额度） |

工作量 1 天。验收：一条 8 封的线程，`get_thread` 带 `summarize: true` 返回摘要；第二次调用不发模型请求（用 `AI` 绑定打桩计数验证）；模型失败时返回原线程，不报错。

### 3. 每日来信简报

**成本**：每天 1 次，6,000 输入 + 1,200 输出 ≈ 160 + 246 ≈ 406 neurons，占日额度 4%，可忽略。

**需要新增的东西中，唯一"重"的是调度**：当前 `wrangler.jsonc` 里没有任何 `triggers`，`workers/app.ts` 也没有 `scheduled` 导出。要做就得加 `"triggers": { "crons": ["0 1 * * *"] }`（= 北京时间 09:00）并导出 `scheduled()`。这是配置改动，需要用户单独批准——这也是它排在摘要之后的第二个原因。

**落点**

| 文件 | 改动 |
| --- | --- |
| `wrangler.jsonc` | 加 `triggers.crons`（**配置改动，需批准**） |
| `workers/app.ts` | `export default { fetch, scheduled }`，`scheduled` 里遍历 `listMailboxes(BUCKET)` |
| `workers/lib/digest.ts`（新） | 取过去 24h 邮件（`date` 索引已有），分四组：需回复的、新发件人、账单/通知类、其余；调 `callAi` 生成中文简报（3–6 条，含"今天必须先回的一封"）；写 `digests(mailbox_id, day, markdown, created_at)` |
| `migrations/0018_digests.sql` | 上表，`PRIMARY KEY(mailbox_id, day)` 保证重跑幂等 |
| `workers/lib/tools.ts` | 新工具 `get_digest(date?)`——这是唯一**值得新增**的工具（简报本身是新的数据源，不是检索的另一种写法） |
| `app/components/` 首页 | 今日简报卡片 |

工作量 1.5 天。注意免费计划 cron 可能延迟数分钟，不要在摘要里承诺"准点"。

### 4. 三件事的先后

```text
第 1 步  线程摘要        1 天   零新基础设施，直接提升回答质量
第 2 步  每日简报        1.5 天  需要 cron（配置改动，需批准）
第 3 步  FTS5 + 重排     1.5 天  检索质量的地基，顺带把中文搜索从 LIKE 换掉
第 4 步  向量检索（可选） 3 天    先花半天实测 Vectorize 计费口径，再决定做不做
```

---

## 三、对外分发清单与三语文案初稿

### 3.1 渠道

| 渠道 | 提交入口 | 格式要求 / 禁忌 | 需要谁的账号 | 判断 |
| --- | --- | --- | --- | --- |
| **HelloGitHub** | `hellogithub.com` 站内「推荐 / Submit」（注意：直接开 `hellogithub.com/submit` 是 404，必须从首页导航进）；或在其 GitHub 仓库 `521xueweihan/HelloGitHub` 提 issue 自荐 | 月刊每月 28 日发布；自荐项目同样要求：项目介绍 / 特性 / 快速开始 / 开源协议（`README.md` 与 `README.zh-CN.md` 已齐）；Insights 活跃度是必看项，star 对自荐项目为参考项（审核标准见该仓库 issue #271）。忌：无文档、长期不更新、纯营销口吻 | 仓库维护者自己的 GitHub 账号（已有） | **最可能拿到 star** |
| **V2EX** | `v2ex.com/go/create`（分享创造节点） | 站内帖证实：新账号在「分享创造」发帖有约 30 天的注册时长门槛；营销内容按站规应发「推广」节点。忌：标题党、结尾引流、同一项目反复刷 | 注册满 30 天、有正常发言记录的账号 | **次可能拿到 star** |
| **Hacker News（Show HN）** | `news.ycombinator.com/submit`，标题必须以 `Show HN: ` 开头 | 官方页明确：必须是"别人能立刻上手玩"的东西，**不要登录墙/注册墙**；不许是 landing page；不许请朋友点赞或评论；忌营销腔、忌形容词堆砌。新功能小版本不算 Show HN | 个人 HN 账号，且要能在评论区全程答疑 | 爆发力最大但概率最低：本项目必须先有 Cloudflare 账号 + 一个域名才能跑起来，正好撞上"无门槛试用"这条 |
| **Reddit r/selfhosted** | `reddit.com/r/selfhosted/` 发帖，按侧栏要求加 flair | 社区惯例：必须可自托管、说明开源、给部署步骤、给截图、说明有无付费档；该社区默认期待 Docker Compose，**本项目是 wrangler 部署，必须在正文第一段就说清**，否则会被当成"不是 self-hosted"；忌纯商业推广 | Reddit 账号（建议有正常发帖史，新号易被自动删） | 中：受众精准但预期错配，需要额外解释成本 |
| **X** | 直接发推 | 免费账号 280 字符上限；配 1 张真实截图比配文案重要；忌纯链接贴、忌串推刷屏 | 项目自己的 X 账号 | 长尾：用于承接其他渠道的流量，不指望单独起量 |

**为什么是 HelloGitHub 和 V2EX 最可能拿到 star**：这两个渠道的读者是中文开发者，接受"自己动手部署"，且不需要 Demo 站——本项目目前没有线上演示环境（仓库公开、无托管实例），放到需要"点开就能用"的 HN 会直接失分；放到需要 Docker Compose 的 r/selfhosted 会被追问部署方式。而 HelloGitHub 是月刊收录制，一次入选带来数月的持续长尾流量，这正好补偿本项目"没有 demo、只能看仓库"的短板。

（仓库里另有一份 `docs/demo-site-plan.md` 讲了公开只读演示站怎么做，状态是"方案、未实施"。演示站真的上线之后，HN 与 Reddit 的"试用门槛"问题会大幅缓解，那时再发这两个渠道；但文案里的链接必须等实测返回 200 之后再换。）

**链接纪律**：以下文案里出现的产品链接只有 `https://github.com/doforu-labs/Mailboxes` 这一条，已实测 HTTP 200、仓库公开（AGPL-3.0，当前 3 stars）。**没有演示站，所以任何文案都不放 demo 地址**；将来部署后要加，必须先实测 200 再替换。

### 3.2 文案初稿

统一卖点：**一个域名，给你的 AI 一个真邮箱，$0；agent 只写草稿，发不发由你。**

字数口径（下同）：中/日文按字符数（含标点、不含链接）计；英文按单词数计。下面每条都实测过。

#### ① HelloGitHub（中文，自荐表单 / issue 正文，149 字符）

> 一个域名，给你的 AI 一个真邮箱，$0。
> Mailboxes 装在你自己的 Cloudflare 账号里：域名上的 hello@ 就是 agent 的收件箱，读全文、搜历史、写回信草稿。
> agent 只写草稿，发不发由你。
> 装完三步：npm install、npm run setup、打开网址。
> github.com/doforu-labs/Mailboxes

#### ② V2EX（中文，标题 + 正文，正文 149 字符）

标题：`把自家域名邮箱接给 AI agent 的开源小项目（Cloudflare 全免费）`

> 一个域名，给你的 AI 一个真邮箱，$0。
> agent 能读能写，但没有地址：收不到客户来信，也订阅不了服务。Mailboxes 跑在自己的 Cloudflare 账号里，把域名上的 hello@ 做成 agent 的收件箱。
> agent 只写草稿，发不发由你——发送权在你手里，不在模型。
> 仓库：github.com/doforu-labs/Mailboxes

#### ③ Show HN（英文，标题 + 正文，正文 135 words）

标题：`Show HN: Mailboxes – a free email address for your AI agent, on your own domain`

> My agent could read, write and plan, but it had no address: nobody could email it, and it could not subscribe to anything.
>
> Mailboxes gives it one: hello@yourdomain.com, running entirely inside your own Cloudflare account on the free plans (Workers, D1, R2, Workers AI, plus Resend for outbound). Mail arrives with its full thread and attachments; the agent reads, searches and writes the reply. It cannot send - you press send.
>
> Honest requirement: a Cloudflare account and a domain whose DNS is there. npm install && npm run setup creates the storage and database and prints your URL.
>
> The same 14 tools are also exposed over MCP and a plain HTTP /tools endpoint, so you can point your existing agent at it.
>
> Source (AGPL): github.com/doforu-labs/Mailboxes - happy to answer anything about the D1 schema or the tool auth model.

#### ④ Reddit r/selfhosted（英文，标题 + 正文，正文 110 words）

标题：`[Show] Mailboxes – self-hosted email for your AI agent, on your own Cloudflare account (not Docker)`

> Not a Docker image, so saying it up front: this deploys with wrangler into your own Cloudflare account, on the free tiers of Workers, D1, R2 and Workers AI, plus Resend for outbound.
>
> It gives an agent a real address on a domain you own - hello@yourdomain.com - with full threads and attachments in R2 and a searchable index in D1. The agent reads, searches and drafts; sending stays behind a human click.
>
> The same tools are exposed over MCP and plain HTTP for other clients. No telemetry, no phone-home, no paid tier: AGPL-3.0, nothing to buy from me.
>
> Setup: npm install && npm run setup, then open the URL it prints. Source: github.com/doforu-labs/Mailboxes

#### ⑤ X（中文，单条，114 字符；含链接 152 字符，在 280 上限内）

> 一个域名，给你的 AI 一个真邮箱，$0。
> 跑在自己的 Cloudflare 账号里：域名上的 hello@ 直接变成 agent 的收件箱，能读、能搜、能写草稿。agent 只写草稿，发不发由你。
> 自建、开源，全在免费额度内。
> github.com/doforu-labs/Mailboxes

#### ⑥ 日文（备用，127 字符）

> ひとつのドメインで、あなたの AI に本物のメールアドレスを。$0 です。
> Mailboxes は自分の Cloudflare 上で動きます。hello@ がそのままエージェントの受信箱になり、読み、検索し、返信の下書きを書きます。送信は人間が押すだけ。
> github.com/doforu-labs/Mailboxes

### 3.3 发布顺序与自检

1. **先 HelloGitHub**（月刊 28 日截稿，提前 1–2 周提交）；等收录比等 star 更有价值。
2. **V2EX 放第二**，且用有发言历史的账号；发「分享创造」，若被判定为推广则改发「推广」节点，不要删帖重发。
3. **Show HN 放在产品能"零门槛试用"之后**——在此之前发，要么被质疑，要么被无视。若要发，考虑做一个 `npx` 一行体验（本地 wrangler dev + SQLite 模拟）再说，这属于另开一项工作。
4. **Reddit 放在有截图和一段真实使用记录之后**，正文第一段就交代"不是 Docker"。
5. **X 跟着上述每一条走**，做承接，不做首发。

发布前硬自检：
- [ ] 五个渠道的文案里只出现一条产品链接，且实测 200；
- [ ] 仓库 README 顶部有截图（`demo_app.png` 已存在）、有 `npm install && npm run setup` 三步；
- [ ] CHANGELOG 最近一次更新在两周内（HelloGitHub 看 Insights 活跃度）；
- [ ] 不在任何渠道请求点赞/评论（HN 明令禁止，Reddit 也会被删）；
- [ ] 不要在文案里写"支持团队共享/自动回复"——这两项还没做。

---

## 附：本次未做的事

- 没有改任何代码、`wrangler.jsonc`、迁移或配置；
- 没有部署、没有提交、没有推送；
- 没有注册任何账号、没有在任何渠道发帖或提 issue；
- 文档里的文件路径与行号均按 `main@2052421` 校对，后续重构后行号会漂移，路径与函数名仍可用。
