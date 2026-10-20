# 主题接入与 Issue 目录扩展：协议冻结说明 / Theme Bridge & Issue Catalog Extension: Frozen Contract

日期 / Date: 2026-10-20。维护 / Owner: 架构与协议负责人 (Architecture & Protocol)。
证据分栏 / Evidence class: **STATIC + UNIT**（无 DSH-REAL / no DSH-REAL）。

---

## 1. 五元组与展示元数据的关系 / Five-tuple vs. display metadata

| 项目 / Item | 是否属于安装信任根 / In trust root | 何时校验 / When checked |
| --- | --- | --- |
| `gameId, repository, commit, manifestDigest, bundleDigest` | **是 / yes** | 安装时与 `ApprovedRelease` 逐字段比对 |
| `title, summary, descriptionMarkdown, cover, screenshots` | **否 / no** | 每次列表、详情与启动都重新校验 |
| `compatibility.gameCenter / compatibility.dsh` | **否，但为门禁 / no, but a gate** | 安装与启动前**实时重算**，不满足即拒绝 |

中文：**不能**说"编辑 Issue 就一定让审批失效"。五元组不变时安装仍被批准；只有
提交或摘要变化才需要重新审批。展示字段变化只触发一次重新校验。
English: an edit to the Issue does **not** revoke approval by itself; only a change to the
five-tuple does. Display-field edits merely trigger a revalidation.

中文：若将来要主张"元数据也经过审批"，必须引入 `metadataDigest`（`canonicalMetadataJson` 的
SHA-256）并绑定到 Issue 修订号。**本阶段未启用**（`METADATA_APPROVAL_ENABLED = false`）。
English: claiming "metadata is approved" would require a `metadataDigest` bound to the Issue
revision. **Not enabled in this phase.**

## 2. 已冻结的协议常量 / Frozen protocol constants

| 常量 / Constant | 值 / Value | 含义 / Meaning |
| --- | --- | --- |
| `CATALOG_METADATA_SCHEMA_VERSION` | `1` | 元数据结构版本 |
| `DESCRIPTION_MARKDOWN_MAX_CHARS` | `8000` | 简介长度上限 |
| `COVER_MAX_COUNT` | `1` | 封面张数 |
| `SCREENSHOT_MAX_COUNT` | `8` | 截图张数上限 |
| `MEDIA_MAX_BYTES_PER_IMAGE` | `2 MiB` | 单图字节上限 |
| `MEDIA_MAX_EDGE_PX` | `4096` | 单边像素上限 |
| `MEDIA_ALLOWED_MIME` | `png/jpeg/webp/gif` | **不含 SVG**（SVG 可带脚本） |

## 3. Markdown 与图片规则 / Markdown and image rules

中文：
1. 简介中**任何 raw HTML** 一律拒绝，**没有 `<img>` 例外**；
2. Markdown 图片语法 `![]()` 一律拒绝——图片只能走 `display.cover` / `display.screenshots`；
3. `javascript:`、`data:`、`vbscript:` 协议一律拒绝；
4. 渲染端使用白名单渲染器，链接只允许 `https`，且不以 `target=_blank` 携带 opener。

English: no raw HTML (no `<img>` exception), no Markdown image syntax, no unsafe schemes;
the renderer is allowlist-based and links are `https` only.

## 4. 受控图片下载（Host 侧）/ Controlled media fetching (Host side)

中文要求（实现方：DSH Host工程师，安全门禁）：
1. 只接受 `https`；主机必须在**精确白名单**内（建议 `user-images.githubusercontent.com`、
   `raw.githubusercontent.com`）；**不允许 userinfo、不允许自定义端口、不允许 IP 字面量、
   不允许 `localhost`/私网**；
2. **每次 redirect 都要重新校验**目标 URL，且 redirect 次数上限（建议 ≤3）；
3. DNS 解析后的实际 IP 必须再次检查，拒绝回环、私网、链路本地与云元数据地址（SSRF 防护）；
4. 响应体有**字节上限**（≤2 MiB）与**解码后像素上限**（≤4096×4096），边读边计数，超限立即中断；
5. 下载后必须校验 `sha256` 与声明一致；MIME 以**魔数**判定，**SVG 一律拒绝**；
6. 不使用需要鉴权的 `private-user-images` 短期签名链接作为稳定默认值；
7. 图片不得进入游戏 iframe：iframe 的 CSP 保持 `connect-src 'none'`。

English: https-only allowlisted hosts, no userinfo/ports/IP literals/private hosts, redirect
revalidation with a cap, DNS/IP checks against SSRF, byte and decoded-pixel caps, digest and
magic-byte checks, SVG rejected, no signed short-lived image URLs.

## 5. 主题（深色/浅色）接入 / Theme (light/dark) wiring

中文：DSH 本体（`@deepseek-ai/dsh-client-ui-theme@0.2.1-rc.2`，只读实读）：

- 客户端 `apply()` 里 `ctx.provide("theme", theme)`，并 `ctx.on("theme/change", …)` 广播；
- `theme.getTheme()` 返回 `{preference, active:{id, colorScheme, tokens…}, revision}`；
- `preference ∈ {light, dark, system}`；**只有 `system` 时才跟随 `prefers-color-scheme`**
  （`buildSnapshot()` 内 `this.preference === "system" ? media.matches : preference`）；
- 令牌为 `--dsw-alias-*`，要求 light/dark 成对提供。

English: the client theme service is exposed as `theme` with `getTheme()` and the
`theme/change` event; `system` is the only preference that follows the OS scheme.

中文（**必须**）：主题下发走**已配对的 MessagePort**，复用现有握手校验
（`event.source === iframe.contentWindow` + 一次性 `nonce` + `runtimeInstanceId`），
**不得**用裸 `window.postMessage` 向任意源广播主题；端口销毁时必须取消 `theme/change` 订阅。

协议形状（本轮在 `protocol/src/bridge.ts` 冻结的 Bridge 消息）：

```
{ type: 'theme', colorScheme: 'light' | 'dark', revision: number }
```

- 初值：iframe 完成配对后立即推送一次；
- 变更：订阅 `theme/change`，只在 `colorScheme` 变化时推送（避免无谓重排）；
- 销毁：端口关闭或游戏结束即取消订阅，不留监听器。

English: theme is delivered over the paired MessagePort after handshake validation; never a
bare `window.postMessage`. Push the initial value after pairing, push on `colorScheme` change,
and unsubscribe on port teardown.

## 6. 未验证项 / Not verified

- 中文：以上全部为 STATIC/UNIT；真实 DSH 内的主题切换、真实 Gateway 的 13 端点、
  真实 iframe 的 CSP 与图片渲染**均未验证**。
- English: everything above is STATIC/UNIT; real DSH theme switching, the real Gateway's
  endpoints, and iframe CSP/media rendering remain **unverified**.
