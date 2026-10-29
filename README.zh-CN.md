<div align="center">
  <h1><picture><source media="(prefers-color-scheme: dark)" srcset="./logo-rounded-dark.png"><img src="./logo-rounded.png" alt="Mailboxes 图标：白色字母 M，中间的凹谷同时也是信封的封盖，黑底" width="48" align="absmiddle"></picture>&nbsp;&nbsp;Mailboxes</h1>
  <p>给你的 agent 一个免费邮箱。<br>一个属于它自己的地址，用你自己的域名，每月 $0。</p>

  <p>
    <a href="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml/badge.svg"></a>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
    <img alt="免费" src="https://img.shields.io/badge/cost-%240%20on%20free%20plans-brightgreen">
    <a href="https://github.com/doforu-labs/Mailboxes/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  </p>

  <img src="./demo_app.png" alt="Mailboxes 打开在收件箱，助手写好的草稿在右侧面板等着确认" width="880">
</div>

---

> [English](./README.md) · **简体中文**

你的 agent 会读、会写、会查、会规划。但它没有地址。

让它回一封客户邮件、盯一个 newsletter、或者去注册一个服务，它都需要一个真邮箱 —— 在一个真域名上，陌生人是能真的把信发过来的那种。托管邮箱按人头收费；只给 API 的邮箱，则要你先订阅，才肯发第一封信。

Mailboxes 就是这个邮箱，而且免费。你的 agent 拿到 `hello@你的域名.com`。信来了，它读，它翻以前的历史，它把回信写好。**按发送的，是你。** 整个东西跑在你自己的 Cloudflare 账号里、免费套餐内 —— 没有东西要租，也没有钱要付给我们。

## 你的 agent 得到什么

- **一个能长期用下去的地址。** 域名上的任意地址 —— `hello@`、`support@`、agent@ —— 或者一个 catch-all，把这个域名下所有来信都收进来。多个域名可以并排放。
- **它能读的信。** 每封都带着完整会话和附件落进收件箱，不是需要你再去重塑一遍的 webhook 数据。
- **一段它能翻的记忆。** 「上个月客户怎么说的？」它从你自己的邮件里答，而不是从你粘贴进去的摘要里猜。
- **它能写的东西。** 草稿直接落在它正在处理的那个邮箱里。唯一不能自己走的一步，是发送。
- **一扇给现有 agent 的门。** 你可以用自带的侧边面板跟它说话，也可以把你自己那套接进来：任何 MCP 客户端，或者任何能调 HTTP 工具的宿主，配一个设置页里的密钥就行。
- **一个给你用的界面。** 它同时也是一个你能干活的邮件客户端 —— 文件夹、会话、搜索、富文本写信、附件、主题。agent 是坐在你收件箱旁边，不是取代它。

## 把邮箱跑起来

你需要三样东西：一个 **DNS 托管在 Cloudflare 的域名**、**Node.js 20+**、一个免费的 **Cloudflare 账号**。

```bash
npm install
npm run setup
```

`npm run setup` 会建好存储、建好数据库、构建、部署，然后把你的网址打印出来。重复跑是安全的 —— 已经存在的东西会跳过。

然后打开那个网址：

1. **创建你的账号。** 第一次访问是一个初始化向导。没有默认密码，也不需要事先配置什么。
2. **建一个邮箱。** 在域名上挑个地址，比如 `hello@你的域名.com`。
3. **把收信打开。** 在 **设置** 里存一个 Cloudflare API 令牌，再添加域名：应用会自己打开 Email Routing，并把 catch-all 指到你的邮箱。不存令牌也行，就是在 Cloudflare 后台加一条 catch-all 规则。
4. **把发信打开**（如果你打算让它发信）。添加域名时贴一个免费的 [Resend](https://resend.com) 密钥，应用会自己在那边建好域名、写好 DNS 记录。

## 花钱吗？

不花。我们不收你钱，个人用或者小产品也都在免费额度里：每天 10 万次请求、5 GB 邮件、10 GB 附件、每天 1 万个 AI 神经元，以及 Resend 每天 100 封发信。第十个邮箱和第一个一样贵 —— 没有任何按人头算的东西。

## 接入你自己的 agent

打开 **设置 → Agent API 密钥**，建一个，复制走。它只显示一次，而每一次使用都会被记录。

- **MCP 客户端** → 指向 `https://你的应用.workers.dev/mcp`
- **能调 HTTP 工具的东西** → `GET /tools` 看工具列表，`POST /tools/call` 调一个
- 密钥放在 `Authorization: Bearer mbx_...` 里

你的 agent 拿到的是和内置面板一样的 14 个工具。如果它不该发信，就把密钥设成**只读**；也可以限定它只能碰哪几个邮箱。

## 常见问题

### 真的免费吗？

真的 —— 个人用和小产品都免费。我们不收钱；应用跑在你自己的 Cloudflare 账号里，用的是 Cloudflare 和 Resend 的免费套餐。

### 添加域名时说「已注册到另一个团队」

这句话是 Resend 说的，不是 Mailboxes。一个域名同一时间只能在一个 Resend 团队里生效，所以它多半还挂在某个旧账号上。去那边删掉，或者在 Resend 里用一个 TXT 记录把它认领回来。收信不受影响 —— 收信走的是 Cloudflare Email Routing。

### 能让 agent 不问我就发出去吗？

目前不行。它写草稿，你确认。自动回复是下一步。

### 助手用的是哪个模型？

Cloudflare 自带的 AI，不用配密钥。任何邮箱也可以改成任意 OpenAI 兼容的接口；那个接口不通时会自动回落到默认模型。

## 接下来要做的

- 自动回复 —— 来信之后自己回出去，不用人点
- 团队共享邮箱 —— 一个邮箱几个人用，带权限
- 更多发信服务商，不止 Resend
- 一层联系人 —— 而不是从邮件头里现解析出来的名字

<details>
<summary><strong>给负责部署和维护的人</strong></summary>

日常重新部署用 `npm run deploy`。它会先跑一遍新的数据库迁移，已经跑过的会跳过。

不要单独跑 `wrangler deploy` —— 它会跳过迁移，也跳过构建时加上的部署保护，于是表结构变了、表却没建，就这么上生产了。

想在本机跑，`npm run dev` 用的是本地数据库和本地存储，不需要 Cloudflare 资源。`npm run setup -- --dry-run` 可以先看看首次部署都会做什么。

管理员密码的哈希做法 —— 以及它为什么能塞进免费套餐的 CPU 限制里 —— 写在 [SECURITY.md](SECURITY.md)。其它的都在应用内的 **设置** 里填：没有凭据文件，也没有环境变量要配。代码里该讲清理由的地方都写了注释。

</details>

## 许可证

[AGPL-3.0](LICENSE)。如果你改了它、并且作为服务提供给其他人，你得把源码也给他们。

Mailboxes 建立在 Cloudflare 的 [agentic-inbox](https://github.com/cloudflare/agentic-inbox) 之上，包含它的 Apache-2.0 代码；那部分仍是 Apache-2.0（见 [LICENSE-APACHE](LICENSE-APACHE) 和 [NOTICE](NOTICE)），这里新增和改动的一切是 AGPL-3.0。

跑在 [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)、[D1](https://developers.cloudflare.com/d1/)、[R2](https://developers.cloudflare.com/r2/)、[Workers AI](https://developers.cloudflare.com/workers-ai/) 和 [Resend](https://resend.com) 上。欢迎参与 —— 见 [CONTRIBUTING.md](CONTRIBUTING.md)。
