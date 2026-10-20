# 阶段1 生产接线缺口与冻结 API v1

建立时间：2026-10-20。维护：架构与协议负责人（协议/根配置/集成协调）。
基线：`docs/gamecenter-design.zh-CN.md` §4/§5/§6/§7/§8、`docs/phase1-plan.md`。
证据分栏：本文件所有"缺口"均为 `STATIC`（源码实读）；不含任何 `DSH-REAL` 结论。

## 0. 一句话结论

**本地 316 项测试通过，但生产链路是断的。** 运行中的 DSH 里现在只能打开一个"阶段0 探针"弹层：
没有目录列表、没有安装、没有 iframe 游戏、没有桥接、存档默认落在内存。缺少的不是测试，
是四处未接的线。

## 1. 生产接线缺口（每条可直接复核）

| # | 缺口 | 证据（源码实读） | 后果 |
| --- | --- | --- | --- |
| G-1 | Host 生产入口**默认用内存存后端**，SQLite 从未被实例化 | `packages/dsh-gamecenter/src/index.ts:119` `new SaveStore(options.storageBackend ?? new MemorySaveBackend())`；构建产物 `staging/index.js` 同一行 | 真实 DSH 重启后存档全丢，"关闭保存→重开恢复"必失败 |
| G-2 | Client 生产弹层仍是阶段0 探针，无目录/安装/启动/继续游戏入口 | `src/ui/GameCenterOverlay.js:138` 文案"阶段0 探针…"；全文只有诊断区与两个关闭按钮 | 玩家看不到任何游戏 |
| G-3 | 仓库内**没有任何 iframe 创建代码** | 全仓 `*.js/*.mjs` grep `srcdoc` / `allow-scripts` / `contentWindow` 创建点 = 0（唯一 `contentWindow` 命中是 `bridge/host-bridge.js:52` 的类型注释） | 游戏无从运行 |
| G-4 | 生产入口从不创建运行租约、从不接收保存确认 | `src/index.js:187` `beginRuntime` 与 `:198` `onSaveAck` **定义后无任何调用点** | `requestPause` 恒走 `lease === null` 分支，关闭总是回"当前没有运行中的游戏"，不会保存 |
| G-5 | 桥接模块未进生产 bundle | 已构建 `dist/client.js`（56,263 字节）grep `dsh-gamecenter:hello` = 0、`connectSDKToDispatcher` = 0；`dispatcher.js` 只被测试 import | 无握手、无 MessagePort、无 checkpoint 通路 |
| G-6 | Remote 只有 5 个方法，缺"列目录/安装/取产物/读存档" | `src/bridge/remote-mount.js:79-80`（`METHODS_WITH_INPUT` + modelCatalog）；Host `src/remote/game-center-service.ts` 仅 handshake/saveAck/pause/leaseStatus/modelCatalog | Client 拿不到游戏列表与游戏文件 |
| G-7 | 目录/安装包未接任何生产入口 | 全仓 `@dsh-gamecenter/catalog` 只被 `tests/integration` 与根脚本引用；Host/Client 源码 0 引用 | 审批、固定提交安装、路径校验在真实产品里没被执行过 |
| G-8 | 安装根与 SQLite 数据目录没有宿主来源 | `installGamePackage` 需调用方传 `packagesDir`/`stagingDir`（`catalog/src/install/types.ts`）；`SqliteSaveBackend` 默认 `:memory:`（`sqlite-save-backend.ts:41`） | 装到哪里、存档写哪里都未定义 |
| G-9 | 包级 Node 声明未全对齐 | `packages/dsh-gamecenter-catalog/package.json` 曾为 `"node": ">=20"`；目录工程师已对齐 `>=24.0.0 <25`，protocol 本次也对齐 | 已收敛，留档 |
| G-10 | **没有存档写入出口** | `saveAck` 入参只有 `{runtimeToken, revision, generation?}`（`game-center-service.ts:102`），不带 state、不写库；Dispatcher 跑在浏览器里够不到 `SaveStore` | 游戏能"保存"但写不进库，"关闭恢复"必失败 |
| G-11 | **租约里没有 playerId** | `LeaseRecord` 字段见 `src/runtime/lease.ts:45`（runtimeInstanceId/generation/gameId/saveId/expiresAt/state/sealed/lastPersistedRevision/tokenDigest），无 playerId | `saveCheckpoint`/`saveLatest` 没有可信身份来源，存档主键只能靠猜 |

## 2. 冻结 API v1（`gameCenter` 命名空间，12 条）

唯一来源：`packages/protocol/src/wiring.ts` 的 `GAMECENTER_REMOTE_METHODS`。
既有 5 条不变，新增 4 条：

| 方法 | 入参 | 成功出参 | 实现方 |
| --- | --- | --- | --- |
| `catalogList` | `{refresh?: boolean}` | `{ok:true, source:'github'\|'fixture', fetchedAt, entries[]}` | Host |
| `catalogInstall` | `{gameId, commit, manifestDigest, bundleDigest}` | `{ok:true, gameId, commit, installedPath, entryPath, alreadyInstalled}` | Host |
| `gameBundle` | `{gameId, commit}` | `{ok:true, gameId, commit, entryPath, files[{path,content}], totalBytes}` | Host |
| `saveLatest` | `{gameId, saveId}` | `{ok:true, absent:false, revision, installedCommit, state, elapsedGameMs, rngState}` 或 `{ok:true, absent:true}` | Host |
| `saveCheckpoint` | `{runtimeToken, operationId, expectedRevision, state, elapsedGameMs, rngState, generation?, gameId?, saveId?}` | `{ok:true, revision, idempotentReplay}` / `{ok:false, errorCode, message, retryable, currentRevision?}` | Host |
| `previewList` | `{}` | `{ok:true, configured, entries[{previewId, gameId, name, version, source:'fixture', label, installable:false}]}` | Host |
| `previewBundle` | `{previewId}` | `{ok:true, source:'fixture', previewId, gameId, version, entryPath, files[], totalBytes}` | Host |

### 2.0 存档槽位冻结（`SAVE_SLOTS`，2026-10-20 收尾变更）

`handshake` 入参**必填** `saveId`，取值只有两个冻结值（`packages/protocol/src/bridge.ts` 的 `SAVE_SLOTS`）：

| 槽位 | 值 | 用途 |
| --- | --- | --- |
| 正式 | `save-default` | 已安装游戏；"继续游戏"按同一槽位 `saveLatest` 读回上一局 |
| 预览 | `save-preview` | 本地受控预览；与正式存档隔离，不得互相读写 |

规则（Host / Client 双方都必须遵守）：

1. **运行身份 ≠ 存档身份**。`runtimeInstanceId`（每次启动都变）不得再充当 `saveId`。
   旧实现 `saveId = input.saveId ?? input.runtimeInstanceId` 会让续玩永远 `absent`，已删除；
   现在缺失或形状非法（空串 / 超 128 字符 / 含 `/` `\`）一律 `PROTOCOL_INVALID`。
2. Client 的**握手、本地租约（`beginRuntime`）、`saveLatest` 查询、诊断链里的
   `handshake`/`leaseStatus`** 必须使用**同一个** `saveId`。
3. 预览路径整条链使用 `save-preview`：预览握手不再静默省略槽位。
4. 同一 `(gameId, saveId)` 单控制者：槽位已被活跃实例占用时，新握手返回 `STALE_RUNTIME`
   而不是顶替；封存后允许新代次接管，且**旧代次的凭证摘要永久作废**（`token-superseded`）。

### 2.1 检查点写入出口（PM 2026-10-20 指出的硬断点）

`saveAck` **不是**写入通道：它的入参是 `{runtimeToken, revision, generation?}`，只有确认回执，
不带 state，也不写库。生产链路上 Dispatcher 跑在浏览器里，**够不到 Host 的 `SaveStore`**，
所以必须有 `saveCheckpoint` 这条 Remote。链路是：

```
game(iframe) --save.checkpoint--> MessagePort --> Dispatcher(Client)
   --> ctx.remote.gameCenter.saveCheckpoint({runtimeToken, ...}) --> Host 校验租约
   --> SaveStore.writeCheckpoint --> SqliteSaveBackend(BEGIN IMMEDIATE) --> {revision}
```

身份规则：`playerId` **不在入参里**，出现即 `PROTOCOL_INVALID`（`validateSaveCheckpointRequest`
已把"出现即拒绝"写死，避免有人当它是可忽略的多余字段）；`gameId`/`saveId` 由 `runtimeToken`
换出的租约给出，入参里的同名字段只作交叉核验；`generation` 只用于检测迟到写入。
错误码语义沿用 `checkpoint.ts`：`STALE_RUNTIME` 带 `currentRevision` 且 `retryable:false`；
`RATE_LIMIT` 可重试且**不得**带 `currentRevision`。

### 2.2 本地预览（不伪造审批的独立路径）

预览**不是**一条"未审批也能装"的旁路，而是完全绕开安装库的只读通道：
`previewList` 只列 `<previewGamesDir>` 下的本地目录（`source:'fixture'`、`installable:false`、
标签恒为 `GAME_PREVIEW_LABEL`「本地预览（未上架）」），`previewBundle` 只接受 `previewId`，
**不接受 gameId/commit**——否则又能借预览绕过安装门禁。预览不产生目录条目、不产生 commit/摘要/
审批记录，因此不存在"伪造元组"的可能。

失败统一 `{ok:false, errorCode, message}`（沿用 Host 现有 `errorCode` 风格；不再混用 `accepted:false`）。

硬约束（协议已编码，非口头约定）：

1. `commit` 必须是 **40 位小写十六进制完整 SHA**，短 SHA 拒绝（`validateCatalogInstallRequest`）。
2. `manifestDigest` / `bundleDigest` 必须是规范 `sha256:<64 小写hex>`；大写不归一、缺前缀拒绝。
3. `catalogInstall` **不接受 repository 入参**——仓库由 Host 侧审批记录决定，防止把同一提交改挂到别的仓。
4. `saveLatest` **不接受 playerId**——身份由 Host 从宿主绑定/租约取，调用方传了也忽略。
5. `gameBundle` 只回文本资产：后缀白名单 `.html/.htm/.js/.mjs/.css/.json/.txt/.svg`，
   单文件 ≤ 1 MiB、总数 ≤ 64、合计 ≤ 4 MiB，超限显式失败不截断（`validateGameBundleFiles`）。
   扫雷实测产物 31,593 + 3,740 + 1,597 字节，余量充足。

### 2.3 检查点准入与暂停收尾顺序（冻结）

PM 2026-10-20 明确：暂停期间的**唯一一次最终检查点**必须在 `saveAck` 封存**之前**落盘成功；
写盘失败不得显示"已保存"。为此新增两个共享判定，Host 与测试用同一份实现：

`CHECKPOINT_WRITABLE_LEASE_STATES = ["running", "pausing"]` + `decideCheckpointAdmission(lease, {generation?, nowMs})`：

| 租约情况 | 结果 |
| --- | --- |
| `sealed:true` | `STALE_RUNTIME`（封存优先于状态判断） |
| `state:"pending"` | `PROTOCOL_INVALID`（未握手，没有可信身份） |
| `state:"running"` | 放行 |
| `state:"pausing"` | 放行（**仅此一次**最终检查点） |
| `state:"paused" / "recovery-available" / "stopped"` | `STALE_RUNTIME` |
| 声明 `generation` 与租约不符 | `STALE_RUNTIME`（旧 iframe 迟到写入） |
| 租约过期 | `PAUSED` |

**重要**：这与 Host `LeaseRegistry.checkWritable()` 的现有行为**不同**。后者在 `pausing` 一律拒为 `PAUSED`，
对 AI 请求是对的；但检查点写入必须走独立准入判定。**不要**图省事把 `pausing` 加进 `checkWritable`——
那会顺带放开 AI 请求和其它写入。

`PAUSE_FINALIZATION_ORDER = ["persist-final-checkpoint", "seal-lease", "pause-ack", "destroy-runtime"]`：

1. 先把最终快照写进 SQLite（此时租约 `pausing`）；
2. 写成功才封存该代次（此后同代次任何写入都是 `STALE_RUNTIME`）；
3. 再回 `saveAck`；
4. 最后销毁 iframe / 端口 / 时钟 / 监听。

明确禁止的反例：先 `pause-ack` 再写盘；写盘失败仍回 `saved`；超时回 `saved` 而不是 `recovery-available`。
`isPauseFinalizationOrderValid()` 会把"先确认后写盘"判为无效。


## 3. iframe 安全策略（冻结）

| 项 | 冻结值 | 理由 |
| --- | --- | --- |
| `sandbox` | 只能是 `allow-scripts` | 不含 `allow-same-origin` → opaque origin，游戏碰不到主窗口 DOM/存储；不含 popups/top-navigation/forms/modals |
| CSP | `GAME_DOCUMENT_CSP` | `default-src 'none'`、`connect-src 'none'` 断网；`base-uri 'none'`、`form-action 'none'` |
| 握手认证 | `event.source === iframe.contentWindow` + 一次性 nonce + runtimeInstanceId | 沙箱下 `event.origin` 为 `null`，不可用 |
| 端口投递 | `postMessage(msg, '*', [port])` | opaque origin 只能用 `'*'`；隔离靠 sandbox，不靠 targetOrigin |

**不做的事**：不新开 server；不使用 `allow-same-origin`；不把 Host 的 RPC/ctx/凭据放进 iframe。

### 3.1 内联规则（不完整转换就必须拒绝，不许跑一半）

支持的 HTML 引用范围**仅限**下面三类，且路径必须是包内相对路径：

| 形态 | 处理 |
| --- | --- |
| `<script src="./x.js">` | 读文件 → 替换为内联 `<script>…</script>` |
| `<link rel="stylesheet" href="./x.css">` | 读文件 → 替换为内联 `<style>…</style>` |
| `<img src="./x.svg">` 或 `data:` | 转 `data:` URL；文件清单里没有就拒绝 |

遇到**任何**未覆盖形态一律显式失败（不降级、不跳过、不"先跑起来再说"），包括：
`http(s):`/`//` 绝对外链、`<script src>` 指向清单外文件、CSS 里的 `@import`、`url(...)` 非 `data:`、
内联 `<script type="module">` 的 `import` 语句、`<iframe>`/`<object>`/`<embed>`、`<base>`、
`<form action>`。失败码用 `PROTOCOL_INVALID` 并指出具体行/文件，让作者修包而不是猜。

### 3.2 文档来源：两种都要实测，不许先假设

`srcdoc` 按规范会**继承父页面 CSP**；`blob:` 是否继承取决于浏览器实现，**不能假设它能绕过**。
两种都必须在真实 DSH 里各试一次并记录哪个可用，且**不得**为此放宽 sandbox 或主站 CSP。
在实测出结论之前，这条保持"未验"，不得写成"已支持"。

**待实测的前提（部署后必须验，不许提前写通过）**：

- `srcdoc` 文档按规范继承父页面 CSP。若 DSH 页面 CSP 不含 `script-src 'unsafe-inline'`，内联脚本会被拦；
  备选是 `blob:` 文档 URL（同样必须带 sandbox）。两者二选一，需在真实 DSH 里各自试一次并记录。
- 相对路径：`srcdoc` 的 base URL 不是安装目录，游戏里的 `<script src="./game.js">`、`<link href="./style.css">`
  会解析到 DSH Web 根。**因此 Client 必须在组装文档时把全部本地引用内联**（`<script>`/`<style>` 替换为内联文本），
  遇到任何 `http(s):` 绝对外链一律拒绝，不允许"回落到父源加载"。

## 4. 游戏侧 SDK 注入契约（与现有扫雷产物对齐）

扫雷 `dist/game.js` 实读（`C:\Users\salis\Desktop\dsh-game-minesweeping`，本地未 push）：

- 优先取 `window.__DSH_GAMECENTER_SDK__`；没有则回落本地 Mock（不报错，静默走 mock）。
- 只用到三个面：`sdk.save.checkpoint(state)`、`sdk.ai.generate(request)`、`sdk.lifecycle.register({pause,restore,resume})`。
- 暂停钩子的快照由 `lifecycleHooks.pause()` 返回，SDK 负责回 `lifecycle.pauseAck`。

因此 Client 的注入契约冻结为：**在 iframe 文档里、游戏脚本之前**执行引导脚本，用该 iframe 的
`MessagePort` 创建 SDK 实例并挂到 `window.__DSH_GAMECENTER_SDK__`。
暂停指令走端口（`{type:'lifecycle:pause', generation}`），**不走** `window.postMessage`。
游戏脚本里那套 `dsh-gamecenter:pause` 的 window 监听是本仓 Mock 路径，不参与真实链路。

## 5. 宿主配置项（必须显式，不许默认到工作目录）

| 键 | 用途 | 要求 |
| --- | --- | --- |
| `gameCenter.gameLibraryDir` | 安装根，布局 `<gameLibraryDir>/<gameId>/<commit>/` | 由 DSH 宿主数据目录派生；不得是 cwd、不得是可被游戏写入的路径 |
| `gameCenter.previewGamesDir` | 本地预览目录（只读） | 缺省时 `previewList` 返回 `configured:false`，界面显示"未配置预览目录"，不得回落到安装库 |
| `gameCenter.saveDbPath` | SQLite 文件 | 同上；启动时建表；失败显式抛错，不静默回落内存 |
| `gameCenter.catalogMode` | `github` \| `fixture` | `fixture` 只用于本地预览，必须如实显示"未上架" |

### 5.1 数据目录解析依据（实测证据，不是"规范"）

实测（2026-10-20，当前运行的 DSH 进程环境）：

```
DSH_PROFILE_DIR = C:\Users\salis\.dsh\profiles\desktop
DSH_HOME        = C:\Users\salis\.dsh
DSH_DATA_DIR    = （空）
```

这两个变量**确实存在于进程环境里**，可作存在性证据；但未见源码把它们声明为稳定契约，
所以 `DSH_PROFILE_DIR` **不能**当数据根的依据。

### 5.1.1 可靠来源（已核实到具体包与源码行）

DSH 自带路径解析库 `@deepseek-ai/dsh-home-paths` **就在当前 profile 的 node_modules 里**：
`C:\Users\salis\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-home-paths\`
（version `0.2.0-rc.2`，`lib/index.js` 107 行；README 写明 "Use it as a direct library dependency,
not through cordis.yml"）。API 与优先级来自源码 `lib/index.js:62-84`：

| 导出 | 行为 |
| --- | --- |
| `resolveDshHome(configured?)` | 优先级 **显式配置 > `$DSH_HOME` > `~/.dsh`**；空/全空白 `$DSH_HOME` 视为未设置，**绝不回落到 cwd** |
| `dshHomePath(...segments)` | 在解析出的 home 下拼子路径，返回绝对路径 |
| `dshCachePath(...)` | 派生到 `<home>/cache/...` |

所以 Host 的正确做法是：**依赖 `@deepseek-ai/dsh-home-paths`**，数据根用 `dshHomePath('data','gamecenter')`，
库路径用 `dshHomePath('data','gamecenter','gamecenter.sqlite')`。
显式配置（`gameCenter.saveDbPath` / `gameLibraryDir`）仍然最高优先；两者都拿不到时**显式报错**。

**明确禁止**：`os.homedir()/.dsh/profiles/desktop` 这种猜法（不同 profile / 便携版 / 多用户会落错目录）；
把 `DSH_PROFILE_DIR` 当数据根（它不是 home-paths 的契约）；落到 cwd；
只是 import 模块或跑单测就创建真实 profile 数据（测试一律临时目录）。

### 5.2 playerId 来源（必须先定，不得回落 default-player）

`LeaseRecord` 的字段是 `runtimeInstanceId / generation / gameId / saveId / expiresAt / state / sealed /
lastPersistedRevision / tokenDigest`（`src/runtime/lease.ts:45`）——**里面没有 playerId**。

宿主侧确实存在绑定身份文件 `<home>/.anonymous-user-id`（实测存在，内容是 UUID）。
`dsh-home-paths` 的 README 也把 `identity/anonymous-user-id` 列为 "a stored identity file under the
resolved home"，说明这是 DSH 既有身份概念；但**该包的导出 API 我未核实到**（位于 app.asar 归档内，
无法遍历确认精确导出名），因此不能凭文档描述直接调它。

Host 落地规则：

1. 能在运行时解析到 DSH 身份服务/包时用它取身份，并把**实际导出名与源码出处**写进交付说明；
2. 否则要求显式配置 `gameCenter.playerId`（宿主侧配置，不是 wire 入参）；
3. 两者都没有 → **显式报错**，不得回落 `default-player`、不得从 `runtimeToken` 反推。

实机验收时必须能回答"这次写入属于哪个 playerId"，否则跨玩家隔离与重开恢复都无法验证。

`fixture` 模式的硬规则：**不得伪造 commit/摘要/审批**。条目以 `approvalState:'unknown'` 出现，
安装按钮禁用，界面明示"本地预览，非 GitHub 上架"。任何把 fixture 假装成已上架的行为都算造假。

## 6. 主人分工（每项只改自己目录）

| 缺口 | owner | 最小交付 | 验收 |
| --- | --- | --- | --- |
| G-1 G-8 | DSH Host工程师 | `apply()` 默认用 `SqliteSaveBackend`；数据目录从宿主配置解析；启动失败显式抛错 | Host 单测 + 重启后 `saveLatest` 仍能读到 |
| G-6 G-10 G-11 | DSH Host工程师 | 新增 7 条 `@Remote`（含 `saveCheckpoint`/`previewList`/`previewBundle`）；`saveCheckpoint` 串 `SaveStore.writeCheckpoint`；定 `resolvePlayerId(ctx)` 来源 | 与 `GAMECENTER_REMOTE_METHODS` 对齐的单测 + 写入后回读 revision |
| G-7 G-8 G-9 | 目录与安装工程师 | 把 catalog 接进 Host（目录同步、审批比对、固定提交安装、安装根）；`engines.node` 对齐 | 安装后 `gameBundle` 能读到入口 |
| G-2 G-3 G-4 G-5 | 界面与运行时工程师 | 列表/安装/启动/继续游戏 UI；iframe 组装与内联（§3.1 白名单外一律拒绝）；SDK 注入；`beginRuntime`/`onSaveAck` 接线；统一 `requestPause`；Dispatcher 改调 `saveCheckpoint` | 关闭→保存→重开恢复（本地预览先跑通） |
| 协议/根配置/集成 | 架构与协议负责人（本文件 + `protocol/wiring.ts`） | 冻结契约、跨包一致性断言、整体部署 manifest 与失败回滚预案 | 见 §7 |

## 7. 集成对账（我这侧已落地的部分）

- `packages/protocol/src/wiring.ts`：方法表（12 条）、七组 wire 形状、路径/摘要/体积/身份校验、
  iframe 策略常量与 `validateFramePolicy`、`validateSaveCheckpointRequest`（playerId 出现即拒绝）、
  `validatePreviewBundleRequest` 与 `GAME_PREVIEW_LABEL`、`decideCheckpointAdmission()` 与
  `PAUSE_FINALIZATION_ORDER`（见 §2.3）。
- `packages/protocol/test/wiring.test.mjs`：W-01..W-28，28 条 `UNIT`，含五条反向断言：
  sandbox 带回 `allow-same-origin` 必须失败、CSP 放开网络必须失败、显式传 `playerId` 必须被拒、
  `sealed` 即使 state=running 也必须失败、先确认后写盘的顺序必须判无效；
  W-25..W-28 固定 §2.0 的存档槽位（两值互异、形状非法一律拒绝、运行身份不得冒充存档身份、
  `HandshakeRequest.saveId` 不得改回可选）。
- protocol 包 `engines.node` 对齐 `>=24.0.0 <25`。
- `pnpm -C packages/protocol run test` → **69/69 通过，退出码 0**（原 41 + W-01..W-24 + W-25..W-28）。

下一步一致性断言（等三边落地后我加）：Host `@Remote` 方法集 == Client contribution 方法集 == `GAMECENTER_REMOTE_METHODS`。

### 7.1 存档身份闭环（2026-10-20 收尾，本地证据 MOCK/BUILD）

| 判据 | 结果 |
| --- | --- |
| `tools/audit-wire-consistency.mjs` | 9/9 PASS，退出码 0 |
| `tools/probe-host-entry.mjs`（含新增 N5..N8） | 24/24 PASS，退出码 0 |
| `tools/audit-assembler-policy.mjs`（Client 侧） | 18/18 PASS，退出码 0 |
| 全工程测试（protocol 69 + catalog 42 + client 121 + host 105 + integration 19） | 356/356，退出码 0 |
| 全工程 `typecheck` | 退出码 0 |

探针 N5..N8 固化的契约：握手缺 `saveId` → `PROTOCOL_INVALID`；非法槽位形状 → `PROTOCOL_INVALID`；
实例B 以同一槽位握手 → 代次自增；同槽位已有活跃实例时再握手 → `STALE_RUNTIME`；
实例B 经 Remote `saveLatest` 读回上一局 revision 并继续写入 → revision 自增；
已封存旧实例凭证写入 → `STALE_RUNTIME / token-superseded`；预览槽位与正式槽位隔离；
**新进程**（进程级跨实例）实例B 经 Remote 读回并继续写入。

已知未覆盖（不得据此宣布验收通过）：**真实 DSH 内**关闭弹层 → 真实 Gateway → 重开继续；
`srcdoc`/`blob:` 两种 iframe 文档的真实 CSP 继承与脚本执行。上述两条仍属 `DSH-REAL`，需部署授权后实机验证。

## 8. 未验证（继续挂账）

- 真实 DSH 内安装→游玩→关闭保存→重开恢复：`DSH-REAL` **未验**。
- 真实 GitHub 目录与审批记录：仓库尚无发布 Issue/审批文件，本阶段只能 `fixture`。
- 付费模型调用：`AUTH-PENDING`。
- 在线 `lib/` 27 文件偏差：恢复需用户单独授权，未执行。
