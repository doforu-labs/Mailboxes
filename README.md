<div align="center">
  <h1><img src="./logo-rounded.png" alt="Mailboxes 图标：一只白猫的脸同时构成信封，粉色底" width="48" align="absmiddle">&nbsp;&nbsp;Mailboxes</h1>
  <p><em>用你自己的域名收发邮件 —— 完全免费、跑在 Cloudflare 上的自托管邮件客户端，内置 AI 助手。</em></p>

  <p>
    <a href="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml/badge.svg"></a>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
    <img alt="Runs on free tiers" src="https://img.shields.io/badge/cost-%240%20on%20free%20tiers-brightgreen">
    <a href="https://github.com/doforu-labs/Mailboxes/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  </p>

  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/doforu-labs/Mailboxes"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

  <img src="./demo_app.png" alt="Mailboxes 界面：左侧是邮箱与文件夹列表，中间是收件箱，右侧是打开的邮件正文" width="880">
</div>

---

> **简体中文** · [English](./README.en.md)

**Mailboxes 运行是免费的。** 没有服务器要租，也没有按人头的费用 —— 整个应用跑在你自己的 Cloudflare 账号和 Resend 免费额度里。个人收件箱或小型产品，每月账单就是 **$0**。

## 为什么用 Mailboxes

给你的产品一个真正属于自己的域名邮箱 —— `support@`、`hello@`、`sales@` —— 用来**收发邮件和自动回复**，而不必为每个邮箱按月付费。

为面向全球用户发布产品的开发者打造：

- **设计上就免费** —— 运行在 Cloudflare 和 Resend 的免费额度内。没有常驻服务器、没有按用户收费、无需绑卡即可开始。→ [成本明细](#成本明细)
- **域名是你的，数据也是你的** —— 邮件存在你自己的 Cloudflare 账号里：邮件正文存于 [D1](https://developers.cloudflare.com/d1/)（SQLite）数据库，邮箱配置与附件存于 [R2](https://developers.cloudflare.com/r2/)。数据不会离开你的账号。
- **送达率有保障** —— 外发邮件经由 [Resend](https://resend.com)，并正确配置 SPF/DKIM/DMARC，能进 Gmail 和 Outlook 的收件箱，而不是垃圾箱。
- **多域名、多邮箱** —— 在一个界面里管理多个域名，以及任意数量的邮箱（例如用一个 catch-all 全收）。
- **AI 收件箱助手** —— 侧边面板内置 **14 个工具**，可读取来信、检索会话、起草回复；发送前始终需要你明确确认。
- **自带模型** —— 默认走 Cloudflare Workers AI（无需 Key），也可按邮箱切换到任意 OpenAI 兼容接口。
- **全球边缘部署** —— Cloudflare 网络在你用户所在的位置就近响应，不用选区域，也不用半夜担心服务掉线。

## 成本明细

| 组件 | 免费额度 | 用途 |
| --- | --- | --- |
| Cloudflare [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | 每天 100,000 次请求 | Web 应用 + API |
| Cloudflare [D1](https://developers.cloudflare.com/d1/platform/pricing/) | 每天 500 万行读取 · 10 万行写入 · 5 GB 存储 | 邮件、会话、文件夹、会话凭证 |
| Cloudflare [R2](https://developers.cloudflare.com/r2/pricing/) | 10 GB 存储 · 每月 100 万 Class A + 1000 万 Class B 操作 · **出站流量免费** | 邮箱配置 + 附件 |
| Cloudflare [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | 每天 10,000 Neurons | AI 助手（默认模型提供方） |
| Cloudflare [Email Routing](https://developers.cloudflare.com/email-routing/) | 免费包含 | 接收邮件 |
| [Resend](https://resend.com/pricing) | 每天 100 封（每月 3,000 封） | 发送邮件 |
| **合计** | **每月 $0** | 个人使用与小型产品 |

超出免费额度后，你只为 Cloudflare 和 Resend 实际计量的部分付费 —— 与邮箱数量、用户数量都无关。

## 功能

- **登录保护** —— 首次部署后的第一位访客通过设置向导创建管理员账号，密码以加盐 PBKDF2-SHA256 哈希存于 D1，**没有默认密码**。会话通过 HttpOnly Cookie 保持 7 天，会话数据存在 D1。
- **完整的邮件客户端** —— 通过 Cloudflare Email Routing 收发邮件，支持富文本编辑器、回复/转发会话串、文件夹、搜索与附件。
- **可以接多个域名** —— 一次部署能同时管好几个域名：每个域名各有自己的邮箱地址、自己的转发规则、自己的发信密钥，互不影响。想再加一个，在 **Settings** 里点 **Add Domain** 就行。
- **邮箱间相互隔离** —— 每个邮箱的配置是一个 R2 对象，邮件数据按邮箱存于 D1。
- **内置 AI 助手** —— 侧边面板提供 14 个邮件工具，可读取、检索、起草、发送；响应通过 SSE 流式返回，并展示工具调用过程。
- **新邮件自动起草** —— 助手会读取来信并生成草稿，发送前始终需要你明确确认。
- **可配置、可持久化** —— 每个邮箱可自定义系统提示词，聊天记录持久保存，并可单独选择模型提供方。
- **程序化发送** —— 每个邮箱可创建 API Key，让你自己的应用通过 `/api/v1/send` 发信。

<div align="center">
  <img src="./demo_domains.png" alt="Mailboxes 的 Settings 页：Platform Settings 显示已配置，Domains 列表里同时列出了 4 个域名" width="620">
  <p><em>Settings 里的域名列表 —— 这个部署同时接了 4 个域名，每个域名都能单独指定「全收」的邮件投到哪个邮箱。</em></p>
</div>

## 前置条件

- **Node.js ≥ 20** 与 npm（仓库里有 `.nvmrc`，`nvm use` 即可）
- 一个 Cloudflare 账号（`npm run setup` 会在需要时自动拉起 `wrangler login`）
- **一个域名。** 之后随时可以再加更多。在哪家注册商买都行（Namecheap、GoDaddy、阿里云……），但域名的解析要交给 Cloudflare 管：先把域名加到你的 Cloudflare 账号，再按它的提示，去注册商那里把域名的名称服务器换成 Cloudflare 给你的那两个。收信靠的是 Cloudflare 的 Email Routing（邮件路由）；在应用里添加域名时，它会去你的 Cloudflare 账号里找这个域名，找不到就会提示 `Zone for "<domain>" not found in Cloudflare`。
- 启用 [Email Routing](https://developers.cloudflare.com/email-routing/) 用于**收信**
- 一个 [Resend](https://resend.com) 账号用于**发信**（外发邮件不使用 Cloudflare Email Service）
- 启用 [Workers AI](https://developers.cloudflare.com/workers-ai/) 供 AI 助手使用（默认已开启）

## 快速开始

**一条命令搞定部署。** 它会自动创建需要的存储桶和数据库（R2 与 D1）、把数据库 ID 填进配置文件、建好数据表，然后构建并部署，最后打印你的访问地址：

```bash
npm install
npm run setup
```

脚本可以**反复运行**：以后每次重新部署，再跑一遍就行（已经建好的资源会自动跳过；加 `-- --dry-run` 可以先看它打算做什么）。

> 也可以用 README 顶部的 **Deploy to Cloudflare** 按钮，但它只会创建 Worker —— 存储桶、数据库和数据库 ID 都得你自己补，详见本节末尾的说明。

1. **配置收信。** 在 Cloudflare 面板里进入你的域名 → **Email Routing**，创建一条 **catch-all**（也就是「全收」：发给这个域名下任何地址都收下）规则，转发到该 Worker。（如果域名**不在** Cloudflare DNS 上，也可以改用 Resend 的收信 Webhook：`/api/v1/inbound/resend`。）

   想省掉手动步骤：先做完下面的第 3 步（创建管理员账号），然后在 **Settings**（`/settings`）里填好 Cloudflare 凭据（见「配置」），再回首页添加域名 —— 应用会自动开启邮件路由，并帮你把这条转发规则建好。

2. **配置 Resend 以便发信**（可选 —— 只有需要发信时才要）。在 [resend.com](https://resend.com) 注册、添加你的域名、复制 API Key。然后在应用里添加该域名：**Add Domain** 流程会要求填写 Resend API Key，之后也可以在首页的域名菜单里更新。

3. **创建管理员账号。** 首次打开应用会被直接引导到设置向导（`/setup`），填写用户名（默认 `admin`）和密码即可 —— 在此之前应用不会开放其它页面。**没有默认密码，也不需要 token 或任何环境变量。** 这是一个一次性的窗口：账号建好之后，向导与它的建号接口都会关闭，再提交只会得到 409。

4. **创建一个邮箱。** 登录后，为域名下的任意地址创建邮箱（例如 `hello@yourdomain.com`）。

<details>
<summary>想改用 <strong>Deploy to Cloudflare</strong> 按钮？</summary>

按钮只会创建 Worker，而应用还需要 R2 桶和 D1 数据库。本仓库 `wrangler.jsonc` 里固定指向的是作者账号中的资源，所以直接点按钮部署会失败。要用按钮的话：

1. 先 **fork** 本仓库。
2. 在你的 fork 里建好资源，并让配置指向它们：
   - `wrangler r2 bucket create mailboxes`
   - `wrangler d1 create mailboxes-db`，把返回的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases` 块
   - `wrangler d1 migrations apply mailboxes-db --remote`
3. 在**你的 fork** 上点按钮（本 README 里的按钮指向本仓库，点了会用上作者的 `database_id`）。

比这省事得多的是上面的 `npm run setup`。

</details>

## 配置

- **`wrangler.jsonc`** —— 设置你的 D1 `database_id`、R2 桶名以及其它绑定。`npm run setup` 会自动把 `database_id` 填好。
- **域名与 Cloudflare 凭据（Platform Settings）** —— 登录后打开 **Settings**（`/settings`）→ **Platform Settings**，填入 **Cloudflare API Token** 和 **Cloudflare Account ID** 两个值。点 **Verify & Save** 会先验证一遍再保存（成功提示里会带账号名和找到的域名数量），通过后徽章变成 `Configured`；这两个值存在数据库里。
  - 面板里「创建预配置 Token →」这个链接会替你勾好 3 项权限，还差 1 项要自己加上：点 Add more，选「区域 → 电子邮件路由规则 → 编辑」，然后把 Token 粘回输入框。
  - 填好之后，在应用里添加域名时会自动帮你开启 Email Routing、建好转发规则，不用再去 Cloudflare 面板手动点；没填的话，就按「快速开始」第 1 步手动来。
  - 这个域名必须已经加在你的 Cloudflare 账号里（子域名会自动去找上一级主域名）。应用只会查找，不会替你添加。
- **R2 存储桶** —— 应用需要一个名为 `mailboxes` 的桶：
  ```bash
  wrangler r2 bucket create mailboxes
  ```
- **管理员凭证** —— 由首次运行向导（`/setup`）创建一次，存于 D1，无需配置任何凭据变量。向导只在 `admins` 表为空时开放，建号后自动关闭；即使两个请求同时提交，也只有一个能成功，另一个收到 409。想重新开始，删除该行后刷新即可：`wrangler d1 execute mailboxes-db --remote --command "DELETE FROM admins"`。
- **密码存储** —— 管理员密码以加盐 **PBKDF2-SHA256** 哈希存于 D1，迭代 10 万次（workerd 对 PBKDF2 的上限），参数随哈希值一并存储，日后要提高强度无需改表结构。早期版本曾以明文存储，理由是免费版每请求 CPU 上限 10 ms、加上 KDF 会让登录间歇性触发 1102；但在真实免费版部署上实测，CPU 实际上限接近 **2000 ms**，而 KDF 只花 **21–26 ms**，于是改回了哈希。详见 [SECURITY.md](SECURITY.md) 与 [`workers/lib/password.ts`](workers/lib/password.ts)。
- **AI 提供方** —— 助手默认使用 Cloudflare Workers AI，无需 Key。想用自定义模型时，打开某个邮箱的 **Settings → AI Model**，启用开关并填写 Base URL、模型名和 API Key（OpenAI 兼容）。若自定义提供方不可达，会自动回退到 Workers AI。
- **发信** —— Resend API Key 按域名配置。

## 本地开发

> 只打算本地跑？本地用的是 Miniflare 的本地 D1/R2 绑定，**不需要**先在 Cloudflare 上创建资源 —— 第 3–5 步只有准备部署时才需要（那时跑一次 `npm run setup` 就会把 `database_id` 换成你自己的）。

1. 克隆仓库并安装依赖：

   ```bash
   npm install
   ```

2. 配置本地环境变量：

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. 创建 D1 数据库：

   ```bash
   wrangler d1 create mailboxes-db
   ```

4. 把返回的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases` 数组。

5. 创建 R2 存储桶：

   ```bash
   wrangler r2 bucket create mailboxes
   ```

6. 在本地应用数据库迁移：

   ```bash
   npm run db:migrate:local
   ```

7. 启动开发服务器：

   ```bash
   npm run dev
   ```

### 生产部署

首次部署请直接跑 `npm run setup`（见「快速开始」）：它会创建缺失的资源、把 `database_id` 写回配置、应用迁移、构建并部署。资源就绪之后的日常重新部署：

```bash
npm run deploy
```

然后在生产环境应用迁移：

```bash
npm run db:migrate
```

或者用一条命令完成构建、部署和迁移：

```bash
npm run deploy:full
```

`bash deploy.sh` 与 `npm run setup` 完全等价。

## 技术栈

- **前端：** React 19、React Router v7（SSR）、Tailwind CSS v4、Zustand、TipTap、[`@cloudflare/kumo`](https://www.npmjs.com/package/@cloudflare/kumo)、TanStack Query
- **后端：** 运行在 Cloudflare Workers 上的 Hono、[D1](https://developers.cloudflare.com/d1/)（SQLite，经 [Drizzle ORM](https://orm.drizzle.team/)）、[R2](https://developers.cloudflare.com/r2/)、Cloudflare [Email Routing](https://developers.cloudflare.com/email-routing/)
- **AI 助手：** 默认使用 Cloudflare [Workers AI](https://developers.cloudflare.com/workers-ai/)（或任意 OpenAI 兼容接口），支持工具调用与 SSE 流式输出
- **发信：** [Resend](https://resend.com) REST API

## 架构

```text
  Browser —— React 19 + React Router v7（首屏 SSR + 客户端取数）
      │  同源请求：/api/v1/*（Cookie 会话）＋ SSE 流式（AI 助手）
      ▼
  Cloudflare Worker「mailboxes」—— Hono（入口 workers/app.ts）
      ├── /api/v1/*        → API 路由（workers/index.ts）
      ├── 其它所有路径      → React Router SSR
      ├── email()          → 收信入口（receiveEmail）
      └── 静态资源          → Workers Static Assets（构建时注入）
      │
      ├──►  D1（SQLite / Drizzle）—— 邮件、附件、文件夹、域名、API Key、
      │                              登录会话、管理员、平台设置、AI 对话记录
      ├──►  R2「mailboxes」       —— 邮箱配置 mailboxes/<id>.json
      │                              附件 attachments/<邮件>/<附件>/<文件名>
      ├──►  Workers AI            —— 默认 @cf/moonshotai/kimi-k2.6
      │                              回退 llama-3.3-70b，也可改配 OpenAI 兼容接口
      └──►  Resend REST API       —— 外发邮件 POST /emails

  收信有两条路（都写回 D1 与 R2）：
    A. Cloudflare Email Routing（catch-all 规则）→ email() 处理器
    B. Resend 收信 Webhook → POST /api/v1/inbound/resend → 回拉正文
```

除了上面列出的，Worker 没有绑定任何其它 Cloudflare 资源 —— 没有 KV、Queues、Durable Objects、Vectorize，也没有定时任务（Cron）。

## 常见问题

### 真的免费吗？

是的，个人使用和小型产品免费。Mailboxes 本身不收取任何费用。应用跑在**你自己的** Cloudflare 账号里，Cloudflare 与 Resend 的免费额度足以覆盖一个个人收件箱或早期产品 —— 具体额度见[成本明细](#成本明细)。没有按人头或按邮箱的收费，所以加第十个邮箱和加第一个一样：不花钱。

### 添加域名时提示 "the domain is registered to another team"

添加域名时，Resend 可能返回：

> Failed to create domain on Resend: The `yourdomain.com` domain is registered to another team. You can claim it using the Domain Claim API.

这个错误来自 **Resend**，不是 Mailboxes。一个域名同一时间只能属于**一个 Resend 团队**，而 `yourdomain.com` 已经在另一个团队里添加过（多半还完成了验证）—— 通常是旧账号、同事的个人账号，或临时测试账号。

**两种修复方式：**

1. **你能控制那个团队** —— 登录那个 Resend 团队，打开 **Domains**，删除该域名，然后从 Mailboxes 重新添加。注意用左上角的团队切换器确认切到了正确的团队。
2. **你无法访问那个团队** —— 通过证明所有权来「认领」域名：
   - **面板：** Domains → **Add Domain** → 输入域名 → **Start claim** → 把返回的 **TXT** 记录加到你的 DNS（部分注册商提供一键添加）→ 点击 **I've added the records**。
   - **API：** `POST https://api.resend.com/domains/claim`，请求体 `{ "name": "yourdomain.com" }`，加上返回的 TXT 记录，然后验证并轮询直到 `status` 变为 `completed`。
   - 认领成功后，域名会**从原团队释放并转入你的团队**。认领请求 **7 天**后过期。
   - 如果认领状态是 `blocked`，原因类似 `recent_owner_activity` 或 `pending_scheduled_emails`，说明对方团队仍在使用该域名发信 —— 请联系 [Resend 支持](https://resend.com/help)释放它。

域名在 Resend 中释放（或认领）后，再从 Mailboxes 应用里重新添加即可。

> **注意：** 这只影响经由 Resend 的**外发**。收信是走 **Cloudflare Email Routing**（catch-all 规则 → 该 Worker），不在 Cloudflare DNS 上的域名则走 Resend 收信 Webhook。请保持域名 MX 记录指向 Cloudflare Email Routing —— 不要把根域 MX 改成 Resend，否则会收不到信。

参考：[Resend — Claim Domain](https://resend.com/docs/api-reference/domains/claim-domain) · [Domain already registered by another account](https://resend.com/docs/knowledge-base/domain-already-registered)

## 路线图

- [ ] 结构化/基于规则**自动回复**（目前仅生成草稿）
- [ ] 团队共享邮箱
- [ ] 除 Resend 之外支持更多发信服务商
- [ ] 轻量联系人/CRM 层

有想法？欢迎提 Issue。

## 贡献

欢迎提 Issue 和 Pull Request。提交 PR 前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并保持改动聚焦、有测试（`npm test`、`npm run typecheck`）。

## 安全

安全相关问题请勿公开提 Issue —— 请见 [SECURITY.md](SECURITY.md)。

## 许可证

**AGPL-3.0-only** —— 本作品整体（含本仓库的全部新增与修改）以 [GNU Affero General Public License v3.0](LICENSE) 分发。若你把修改后的版本作为网络服务提供给他人使用，你必须向他们提供对应的完整源代码（AGPL 第 13 条）。

本作品是 [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) 的派生作品，因此包含上游的 Apache-2.0 代码：上游部分版权归 Cloudflare, Inc. 所有、仍适用 [Apache License 2.0](LICENSE-APACHE)（许可证全文见该文件）；本仓库新增与修改的部分版权归 © 2026 Doforu 所有、适用 AGPL-3.0。各文件的版权与许可声明保留在文件头部。完整归属说明见 [NOTICE](NOTICE)。

## 致谢

本仓库 fork 自 [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox)。构建于 [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)、[D1](https://developers.cloudflare.com/d1/)、[R2](https://developers.cloudflare.com/r2/)、[Workers AI](https://developers.cloudflare.com/workers-ai/) 与 [Resend](https://resend.com)。想了解这种「收件箱」模式的更多内容，可阅读 Cloudflare 博客 [Email for Agents](https://blog.cloudflare.com/email-for-agents/)。
