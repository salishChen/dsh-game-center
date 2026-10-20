# 游戏上架 Issue 模板 / Game Listing Issue Template

> 中文：这是提交到**游戏目录仓**（`salishChen/dsh-game-center-warehouse`）Issues 的上架申请模板。
> 游戏代码本身放在各自独立仓库，本 Issue 只声明"哪个游戏的哪个固定提交可以上架"。
>
> English: This is the listing template for Issues in the **catalog repository**
> (`salishChen/dsh-game-center-warehouse`). Game code lives in its own repository; this Issue only
> declares *which game, at which pinned commit* is offered for listing.

---

## 1. 展示信息 / Display information

- **游戏名（中文）/ Game name (zh)**：扫雷 / Minesweeper
- **游戏名（英文）/ Game name (en)**: Minesweeper
- **一句话简介（中文）/ One-line summary (zh)**：确定性无猜扫雷，AI 只负责生成对局。
- **一句话简介（英文）/ One-line summary (en)**：Deterministic no-guess Minesweeper; the AI only generates boards.

### 简介（Markdown，中文与英文都要写）/ Description (Markdown, both languages required)

> 规则：**禁止 raw HTML、禁止 `<img>`、禁止 Markdown 图片语法（`![]()`）、禁止 `javascript:`/`data:` 链接**。
> 图片只能填到下面第 2 节的受控字段里。
> Rules: **no raw HTML, no `<img>`, no Markdown image syntax, no `javascript:`/`data:` links.**
> Images go only into the controlled fields in section 2.

```markdown
### 玩法 / Gameplay

- 首击必开空旷区；生成后由本地求解器验证**无需猜测**即可通关。
- 计时与棋盘状态在关闭后保存，重开可继续同一局。

### How to play

- The first click always opens an empty area; every generated board is verified by a local
  solver to be solvable **without guessing**.
- Board and timer are saved on close and resume on reopen.
```

## 2. 受控图片 / Controlled images

> 中文：只接受 `https` 且主机在白名单（`user-images.githubusercontent.com`、
> `raw.githubusercontent.com`）上的固定链接；必须填写 `sha256`、尺寸与替代文本。
> **不要使用带鉴权的 `private-user-images` 短期链接**——它会过期。
>
> English: only `https` URLs on allowlisted hosts, with `sha256`, pixel size and alt text.
> **Do not use signed `private-user-images` URLs** — they expire.

| 位置 | URL | sha256 | mime | 宽×高 | alt |
| --- | --- | --- | --- | --- | --- |
| 封面 cover | `https://user-images.githubusercontent.com/…/cover.png` | `sha256:<64hex>` | image/png | 1280×720 | 扫雷封面 / Minesweeper cover |
| 截图 1 screenshot | `https://user-images.githubusercontent.com/…/shot-1.png` | `sha256:<64hex>` | image/png | 1280×720 | 开局棋盘 / Opening board |

## 3. 兼容性 / Compatibility

> 中文：这两项是**真实的安装与启动门禁**，不是展示文字。未知或非法范围一律拒绝。
> 游戏自身版本请写在机器块的 `version` 字段，**不要把平台版本写进游戏版本**。
>
> English: these two are **real install and launch gates**, not labels. Unknown or invalid
> ranges fail closed. The game's own version belongs in the machine block's `version` field.

- 适配游戏中心 / Game center version: `>=1.0.0 <2.0.0`
- 适配 DSH / DSH version: `>=0.2.1-rc.2 <0.3.0`

## 4. 机器可读块 / Machine-readable block

> 中文：**全篇只能有一个** `gamecenter-json` 代码块，内容必须是合法 JSON。
> 安装信任根是五元组 `{gameId, repository, commit, manifestDigest, bundleDigest}`——
> 展示字段（名称/简介/图片/兼容性）**不参与**这个五元组；它们每次展示、安装和启动时**重新校验**。
> 版本范围或元数据被改动，平台会**重新计算门禁结果**，但不会因为改了简介就让安装许可失效。
>
> English: exactly **one** `gamecenter-json` block in the whole Issue, containing valid JSON.
> The install trust root is the five-tuple `{gameId, repository, commit, manifestDigest, bundleDigest}`;
> display fields do **not** belong to it and are **revalidated** on every display, install and launch.
> Editing description or compatibility re-evaluates the gates but does not revoke the install approval.

```gamecenter-json
{
  "schemaVersion": 1,
  "gameId": "example.minesweeping",
  "title": "扫雷 / Minesweeper",
  "summary": "确定性无猜扫雷 / Deterministic no-guess Minesweeper",
  "version": "1.0.0",
  "source": {
    "commit": "0000000000000000000000000000000000000000",
    "ref": "v1.0.0",
    "repository": "https://github.com/salishChen/dsh-game-minesweeping.git",
    "manifestPath": "gamecenter.json",
    "manifestDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "bundleDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "display": {
    "schemaVersion": 1,
    "summary": "确定性无猜扫雷 / Deterministic no-guess Minesweeper",
    "descriptionMarkdown": "### 玩法\n- 首击开空旷区\n\n### How to play\n- First click opens an empty area",
    "cover": {
      "url": "https://user-images.githubusercontent.com/…/cover.png",
      "sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/png",
      "width": 1280,
      "height": 720,
      "alt": "扫雷封面 / Minesweeper cover"
    },
    "screenshots": [],
    "compatibility": {
      "gameCenter": ">=1.0.0 <2.0.0",
      "dsh": ">=0.2.1-rc.2 <0.3.0"
    }
  }
}
```

## 5. 审核说明 / Review notes

- 中文：**Issue 标签、正文自称"已审批"都不构成审批**。安装许可来自受保护分支上的审批记录
  （`ApprovedRelease`），其五元组必须与上面机器块逐字段一致；改提交或改摘要即需要重新审批。
- English: **Labels and self-declared "approved" text in the Issue are not approvals.** Install
  permission comes from the `ApprovedRelease` record on a protected branch whose five-tuple matches
  this block field by field; changing the commit or digests requires a new approval.

- 中文：`manifestDigest` / `bundleDigest` 由发布流程计算，**提交者不得凭空填写**；
  填错只会让安装被拒，不会"靠猜"通过。
- English: `manifestDigest` / `bundleDigest` come from the release pipeline; do not invent them.
  A wrong value can only cause a rejection, never a guessed pass.
