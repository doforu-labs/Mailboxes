# Themes（皮肤）

Mailboxes 的外观由 `@cloudflare/kumo` 的**语义令牌**驱动。本目录提供一套**可叠加、可切换**的主题层 —— 不需要改动任何组件代码。

## 用法

`<html>` 上的两个属性决定外观：

| 属性 | 取值 | 说明 |
| --- | --- | --- |
| `data-theme` | `kumo`（原始默认）· `midnight` · `porcelain` · `sakura` | 主题 |
| `data-mode` | `light`（默认）· `dark` | 明暗 |

- 当前默认是 `midnight`，写在 `app/root.tsx` 的 `<html>` 上。
- 运行时可用 URL 参数临时覆盖：`/?theme=sakura&mode=dark`（由 `root.tsx` 内的引导脚本处理，首屏前生效，无闪烁）。

## 如何新增一套主题

1. 在 `app/themes/` 新建 `my-theme.css`，结构照抄 `midnight.css`；
2. 在 `app/themes/index.css` 末尾追加 `@import "./my-theme.css";`；
3. 只覆盖想改的令牌，其余自动继承 `kumo` 基础主题。

## 两条必须遵守的规则（都是实测踩出来的坑）

### 1. 覆盖必须写在 `@layer` 之外（unlayered）

Kumo 的令牌是**无层级**声明的。把覆盖写进 `@layer base { … }` 会因 CSS 层级优先级而**静默失效**（写对了字面值，页面却毫无变化）。

> 注意：Kumo 官方的 `theme-fedramp.css` 用的正是 `@layer base` 写法，它在当前版本下并不生效。

### 2. 主按钮的文字是硬编码白字

Kumo 的 primary Button 类串为：

```
bg-kumo-brand  !text-white  hover:bg-kumo-brand-hover …
```

编译结果是 `color: var(--color-white) !important` —— Kumo 假定 `brand` 一定是「能承载白字」的深色。
当主题把 `brand` 调浅（典型场景：深色模式下的亮色强调），就会出现**白底白字**（porcelain 深色最初实测对比度仅 **1.12:1**）。

修正方式 —— 在 brand 元素上**重定义作用域内的 `--color-white`**：

```css
[data-theme="porcelain"][data-mode="dark"] .bg-kumo-brand {
  --color-white: oklch(0.16 0 0);
}
```

> ⚠️ 直接写 `color: … !important` **不管用**：`!important` 声明的层级顺序是**反转**的，Kumo 的 `@layer utilities` 反而会赢。

## 每套主题覆盖的 23 个令牌

- **表面 / 结构 9**：`--color-kumo-canvas` `-base` `-elevated` `-recessed` `-tint` `-fill` `-fill-hover` `-control` `-overlay`
- **品牌 4**：`--color-kumo-brand` `-brand-hover` `-contrast` `-interact`
- **线条 2**：`--color-kumo-line` `-hairline`
- **文字 8**：`--text-color-kumo-default` `-strong` `-subtle` `-inactive` `-placeholder` `-inverse` `-brand` `-link`

全部写成 `light-dark(浅色值, 深色值)` 形式。

> Kumo 1.19.0 **没有** `--radius-kumo-*` 令牌，圆角来自组件内的 Tailwind 类，无法通过令牌调整。

## 已验证

- 4 主题 × 明暗 = 8 组，主按钮文字对比度**全部 ≥ 4.5:1**（WCAG AA）。
- `npm run build` 通过。
- 回归脚本：`.tmp-verify/contrast.mjs`（对比度）、`.tmp-verify/harness.mjs`（截图）。
