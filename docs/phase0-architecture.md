# 阶段0 架构与共享契约（架构与协议负责人）

建立时间：2026-10-18。唯一设计基线：`docs/gamecenter-design.zh-CN.md`（已全文读取 484 行）。
本文只记录**已实际执行的检查**与由此得出的契约决策；未执行的一律标注 `未执行`。

> 脱敏约定（2026-10-19）：文中 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>`、`<NODE_BIN>` 为路径占位符，**不是可直接执行的路径**。第 1 节表格中的历史摘要值取自脱敏前的原始样本，未按替换后文本重算。

## 0. 证据分栏

沿用 `docs/phase0-acceptance.md` 的分栏口径：`STATIC` / `UNIT` / `MOCK` / `BUILD` / `DSH-REAL` / `AUTH-PENDING`。
**本文所有结论最高只到 `BUILD` + `UNIT`**。阶段0 的 `DSH-REAL` 证据（弹层、Remote 往返、模型目录与调用）**尚未产出**，不得据此宣称阶段0 通过。

## 1. 实际执行的检查与命令记录

| # | 事项 | 命令 / 方法 | 退出码 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 读取设计基线 | read 全文 484 行 | 0 | 已读；`GameCenterService`、`gamecenter.*` SDK、能力注册表均为**拟新增**协议 |
| 2 | 项目现状 | glob `<REPO>\**` | 0 | 仅 `docs/gamecenter-design.zh-CN.md`；后续出现他人 `docs/phase0-acceptance.md`，未改动 |
| 3 | 是否 git 仓库 | `Test-Path .git` | 0 | `False`，**不是** git 仓库，版本锁定只能靠记录文件与后续初始化 |
| 4 | 工具链 | `node -v; pnpm -v; npm -v; git --version` | 0 | node v24.19.0 / pnpm 11.21.0 / npm 11.17.0 / git 2.55.0.3 |
| 5 | 实装 DSH 版本 | node 直读 `app.asar` 头部 → 解出根 `package.json` | 0 | 见 §2.1 |
| 6 | 基线提交语义 | GitHub API `commits/687f282e…` | HTTP 200 | 该提交 message = `release: next version dsh@0.2.1-rc.2`，日期 2026-10-17T07:22:43Z；**版本号与实装一致** |
| 7 | DSH 包布局 | node 列 asar 内 `dsh/node_modules/@deepseek-ai` | 0 | 306 个包，含 `dsh-api-remotes`、`dsh-client-ui-slots`、`dsh-client-ui-layout`、`dsh-client-ui-primitives`、`dsh-llm` 等（**仅证明包存在，不证明扩展点可用**） |
| 8 | 编译共享契约 | `npx -p typescript@5.7.3 tsc -p packages/protocol/tsconfig.json` | 0 | `BUILD` 分栏通过，产出 `dist/*.js` + `*.d.ts` |
| 9 | 单元测试 | `node --test test/contract.test.mjs` | 0 | `UNIT` 分栏 10/10 通过 |
| 10 | Schema 语法 | node `JSON.parse` 4 个 schema | 0 | 语法合法（**未做**实例校验，因未引入校验库） |

### 1.1 必须记录的会话环境事实

- 会话启动时文件策略为 `workspace-write`，此时 `pwsh -Command` **全部失败**（退出码 `3221225794` = `0xC0000142`，无输出），任何 shell 均不可用。
- 策略切换为 `danger-full-access` 后 shell 恢复（`$PSVersionTable` 返回 5.1.26100.9711），上述命令才得以执行。
- 结论：**阶段0 期间任何“shell 不可用”的报告都必须注明当时文件策略**，否则会误判为项目或 DSH 缺陷。这一条建议同步给测试与发布负责人。

## 2. 版本锁定结论

### 2.1 实装版本（`STATIC`，来自安装包本体）

| 字段 | 值 |
| --- | --- |
| name | `@deepseek-ai/dsh-desktop` |
| version | `0.2.1-rc.2` |
| dshBuildCommit | `332895e0f7c9d4dbfb29729f5eb367fa263ff986` |
| dshBuildDirty | `false` |
| 更新通道 | `nightly`（来自 `resources/app-update.yml`） |
| Electron | `43.3.0`（`<USER_HOME>\.dsh\electron\version`） |
| 运行中进程 | `DeepSeek Harness.exe` pid 23864，窗口「游戏中心｜项目统筹」，Web GUI `http://127.0.0.1:3080` |

### 2.2 与设计基线的差异（重要，需要项目经理处置）

- 基线引用提交 `687f282e…` 的**发布版本号同样是 0.2.1-rc.2**，与本机实装版本号一致；但**提交号不同**（`332895e0…`）。
- 因此不能声称“基线提交 = 实装提交”，也不能反过来说“版本号相同即行为相同”。二者之间的**提交差异清单尚未产出**（需 clone 仓库比对，属未执行项）。
- 通道为 `nightly`：即便同一版本号，后续自动更新也会带来行为漂移。
- 契约口径：**阶段0 全部 `DSH-REAL` 证据只对 `0.2.1-rc.2 / 332895e0… / dirty=false` 有效**，不得外推到 master、其他 rc 或未验证 nightly。
- 已写入代码：`packages/protocol/src/dshVersions.ts` 的 `DSH_VERSION_LOCK`，含 `claimsScope` 与 `notClaimed`，任何报告引用版本承诺时必须取自该常量而不是记忆。

### 2.3 建议动作

1. 项目根 `git init` + 首次提交，作为本项目自身的版本起点（**未执行**，需项目经理确认后由我或指定人执行）。
2. 产出 `687f282e…` 与 `332895e0…` 的差异清单；在清单产出前，所有兼容性讨论围绕**实装提交**展开。
3. 若团队无法锁定同一构建，兼容矩阵按“实装提交”单点声明，不做范围承诺。

## 3. 共享契约（已落地，`packages/protocol/**`）

零运行时依赖，`schemaVersion` 常量集中管理，避免六条线各自复制数值。

| 文件 | 内容 | 对应基线 |
| --- | --- | --- |
| `src/version.ts` | `MANIFEST/CATALOG_ENTRY/SAVE_FORMAT/GAME_STATE/BRIDGE` 版本常量、`sdkRangeAccepts`、大小上限 | §4.1 §5 §6 |
| `src/errors.ts` | 13 个错误码、`ProtocolError`、默认 `retryable` | §6 末尾 |
| `src/capabilities.ts` | 操作 / 模态 / 能力条目 / `satisfies` / `missingCapabilities` | §5.1 |
| `src/manifest.ts` | `GameManifestV1`、slot、`GAME_ID_PATTERN` | §5 |
| `src/catalog.ts` | 机器块条目、来源键、`matchApproval`、摘要与提交格式 | §4 §4.1 |
| `src/save.ts` | `GameSaveV1`、AI 账本状态机、运行租约、`checkSaveCompatibility` | §8.2 §8.3 |
| `src/bridge.ts` | 方法白名单、信封、握手、`utf8ByteLength` | §6 §7 |
| `schemas/*.json` | manifest / catalog-entry / save / bridge-envelope v1 | 同上 |
| `test/contract.test.mjs` | 10 项纯函数契约测试 | — |

### 3.1 关键契约决策（需各组遵守，变更须走协议评审）

1. **版本只认主版本**：未知主版本一律拒绝（`PROTOCOL_INVALID`），不做“尽力解析”。次版本只允许追加可选字段。
2. **SDK 范围语法收窄**：只接受 `^x.y.z`、`~x.y.z`、`x.y.z`、`>=x.y.z <x.y.z`；其他语法（`*`、`1.x`、`latest`）返回 false。理由：不引入 semver 依赖，宁可拒绝不猜测。
3. **能力三态**：元数据缺失 = `unknown`，`unknown` 不参与匹配；`satisfies()` 要求 `status === 'supported'`。DSH 目录的 image 输入记录**不能**推出 image 输出。
4. **信任根**：`matchApproval` 要求 `{gameId, repository, commit, manifestDigest, bundleDigest}` 五元组全等；Issue 标题、描述、ref 不参与安装判定。`repository` 参与比较的修订见 §3.2（2026-10-19，修复首版只比四元组的缺陷）。
5. **身份不可伪造**：Bridge 的 `operationId` 由 Host 以 `{player, gameId, saveId}` 组合成幂等键；游戏自报的 `gameId/gameVersion` 仅作交叉校验，权威值来自已安装版本。
6. **运行代次**：每次运行一个 `generation`，旧代次写入返回 `STALE_RUNTIME`；`PAUSED` 后拒绝新请求。
7. **账本只前向**：`Prepared → Submitted → {Completed, Cancelled, Failed, OutcomeUnknown}`、`Completed → Applied`，任何回退必须开新记录。
8. **存档不丢进度**：`SAVE_INCOMPATIBLE` 必须带 `reason`+`detail`，不得静默重置。
9. **不泄露凭据**：`ProtocolError.details` 与能力条目禁止出现 apiKey / token / baseURL / account；建议测试组用哨兵字符串做负例（见 §7）。

### 3.2 修订：审批五元组补入 `repository`（2026-10-19）

**问题**：首版 `ApprovedRelease` 与 `matchApproval` 只比较 `{gameId, commit, manifestDigest, bundleDigest}`，与设计基线声明的五元组不一致，且 `contract.test.mjs` 的负例只改 `manifestDigest`，漏检来源仓库。后果：Issue 机器块把 `repository` 指向另一仓库、其余四项与已审批版本一致时仍判定通过，安装来源可被静默改写。

**修订**：

| 文件 | 变更 |
| --- | --- |
| `packages/protocol/src/catalog.ts` | `ApprovedRelease` 新增必填 `repository`；`matchApproval` 增加 `approval.repository === entry.source.repository` |
| `packages/protocol/test/contract.test.mjs` | 负例增加两条：仅改 `repository` 必须拒绝；缺 `repository` 的旧审批记录必须拒绝 |
| 本文件 §3.1 第 4 条 | 信任根描述改为五元组 |

**兼容性**：阶段 0 尚无任何已发布审批记录，不存在需要迁移的历史 JSON；缺 `repository` 的旧记录一律不匹配（安全侧失败）。

**证据分栏**：`UNIT`（纯函数契约测试）。不含任何 DSH-REAL。

## 4. 与 DSH 实际 API 的界线（防误用）

| 概念 | 归属 | 说明 |
| --- | --- | --- |
| `ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()` / `stream()` | **DSH 既有**（基线 §1 已核实） | Host 侧 AI Broker 的唯一调用路径；本会话未实际调用（付费，`AUTH-PENDING`） |
| Slots / `shell.overlay` / `Modal` | **DSH 既有**（基线 §1） | 装配方式未在本会话验证 |
| Typert `@Remote` / `/remote` contribution | **DSH 既有机制** | 但“是否自动装配”**未验证**，基线已警告需显式装配 |
| `GameCenterService`、`gamecenter.*` SDK、`BRIDGE_METHODS`、manifest/save/catalog schema | **本项目拟新增** | 全部在 `packages/protocol` 内定义，DSH 中不存在这些名字 |
| `RuntimeLease`、`generation`、`runtimeToken` | **本项目拟新增** | 不是 DSH 登录凭据，关闭后失效 |

> 任何人写“调用 DSH 的 `gamecenter.*`”都是错的：该命名空间属本项目。

## 5. 模块边界与文件所有权（供 Host/前端/模型/目录各线遵守）

| 目录 | 归属 | 约束 |
| --- | --- | --- |
| `/package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore` | 架构与协议（我） | 他人不改；需要依赖请在群里提出 |
| `packages/protocol/**` | 架构与协议（我） | 其他人**只读**；字段变更须先提协议变更单 |
| `packages/dsh-gamecenter/**` | DSH Host 工程师 | 只能通过 `@dsh-gamecenter/protocol` 引用契约 |
| `packages/dsh-gamecenter-client/**` | 界面与运行时工程师 | 同上；Bridge 实现须与 `src/bridge.ts` 一致 |
| `packages/gamecenter-sdk/**` | 界面与运行时工程师 | 游戏侧不得 import 任何 `@deepseek-ai/*` |
| `packages/capability-image/**` | 模型适配器工程师 | 能力条目写入须带 `evidence` 与 `adapterVersion` |
| `packages/publisher/**` | 目录与安装工程师 | 生成 Issue 机器块必须通过 `schemas/catalog-entry.v1.json` |
| `docs/**` | 各自文件各自负责 | 基线只读 |
| 根配置的 `workspace` 条目 | 架构与协议（我） | 新增包由我统一登记 |

## 6. 安全威胁模型（阶段0 必须成立的最小集）

| 威胁 | 控制点 | 阶段0 如何证伪 |
| --- | --- | --- |
| 游戏读取 DSH 凭据 / 主聊天 | iframe 无同源权限；Bridge 白名单；Host 侧不回传凭据 | 在游戏侧断言 `window.parent`/`fetch` 不可用；抓 Bridge 报文断言无敏感字段 |
| 游戏伪造其他存档 | `operationId` 由 Host 组合；自报 gameId 仅交叉校验 | 用别的 `saveId` 构造请求，期望 `STALE_RUNTIME`/`PROTOCOL_INVALID` |
| 沙箱 origin 为 `null` 导致 origin 校验失效 | 握手必须校验 `event.source` + 一次性 nonce + 运行实例 | 用另一 iframe 冒充 source 发起握手，期望失败 |
| Issue 被篡改指向新提交 | 审批元组四项全等 | 改 `manifestDigest` 后安装，期望被拒绝 |
| 迟到写入覆盖已暂停存档 | `generation` + `revision` | 暂停后由旧实例写入，期望拒绝 |
| 关闭后仍在计费生成 | 暂停时封代次 + best-effort 取消 + 账本记 OutcomeUnknown | 关闭后观察是否仍受理新请求 |
| 弹层覆盖他人 overlay | 不替换 `shell.overlay`，用并列容器/子扩展 | 同时装另一个占用 overlay 的插件，双方内容都应可见 |

## 7. 给测试与发布负责人的对齐要点

1. 你们的 `docs/phase0-acceptance.md` §1.1 记录的“pwsh 全挂”是**当时文件策略为 workspace-write** 的产物；`danger-full-access` 下 shell 正常。请更新该节，避免后续把阻塞归因到项目。
2. 同一份文档 §1.3 说 asar 不可读——实情是**路径 `app.asar\dsh\` 不可遍历**，但 `app.asar` 本身可被 node 按头部结构直读；我已在 §1 给出方法。是否需要提取正文由你决定，我只读不改安装目录。
3. 建议 A0-6 的脱敏负例直接用我的能力条目结构断言字段集合白名单（`providerId/modelId/adapterId/operations/...`），凡超出即失败。
4. 建议新增一条 A0-8：`packages/protocol` 的 `BUILD`+`UNIT` 作为**契约回归基线**（非阶段0 通过证据），后续任何协议改动必须保持 10/10。

## 8. 当前状态与阻塞

- 已完成：基线通读、实装版本证据、工具链证据、共享契约骨架 + JSON Schema + 10 项单元测试（`BUILD`/`UNIT` 通过）。
- 未执行：任何 `DSH-REAL` 验证；Host/Client 插件骨架；Remote contribution 装配；`shell.overlay` 占位枚举；模型目录实取；真实模型调用（付费，需授权）。
- 阻塞/待决：
  - 基线提交与实装提交不同（`687f282e…` vs `332895e0…`），需项目经理决定兼容承诺口径；
  - 项目根未 `git init`，无法用提交号锁定本仓库状态；
  - 扩展点是否可用仍无源码级证据（asar 可直读，但需要与 Host/Client 工程师约定取证方式与责任人）。

## 9. 实机阻断根因：`cannot get property "remote.gameCenter" without inject`

时间：2026-10-19。来源：用户在实机点「重新检测」得到的真实错误（不是推演）。
证据分栏：**STATIC（源码）+ UNIT（真实 Cordis 离线复现）**，不是 `DSH-REAL`。

### 9.1 根因

`dsh-api-gateway` 的 Client 把每个 Remote 命名空间注册为**点号服务键** `remote.${namespace}`
（`remoteServiceKey(namespace)`），因此 `gameCenter` 的真实服务键是 `remote.gameCenter`。

Cordis 的 ctx 代理（`@deepseek-ai/cordis/lib/index.js`，`ReflectService.handler.get`）只沿
**fiber 祖先链**的 `fiber.store` 查找；`fiber.store` 只由 `fiber.inject` 里的名字经 `_checkImpl` 填充。
所以任何 **不在 inject 中** 的服务名，用 `ctx.<name>` 点号访问都会抛
`cannot get property "<name>" without inject`。

Client 当前 `src/index.js:77` 写的正是 `ctx.remote?.gameCenter`；
注意 `?.` 只挡住 `remote` 为 undefined，挡不住 `.gameCenter` 这一步的代理抛错。

### 9.2 为什么「把 remote.gameCenter 加进 inject」是错的（自等候死锁）

- `Fiber._refresh()`：只要 `inject` 里**任一**名字没有实现，epoch 就置 `INACTIVE`；
- `_setEpoch()`：只有在 `INACTIVE → 有值` 时才触发 `_reload()`，即 `apply()`；
- 而 `remote.gameCenter` 这个服务恰恰是**本插件 `apply()` 里调 `ctx.remote.$mount()` 才创建**的。

→ 死锁：apply 等 inject，inject 等 apply。已用真实 Cordis 复现（下表 C 组，`applyRan:false`）。

### 9.3 正确写法（官方放行读法，非绕过保护）

| 用途 | 正确写法 | 依据 |
| --- | --- | --- |
| 调挂载 API | `inject` 只需 `"remote"`，然后 `await ctx.remote.$mount(contribution)` | 官方消费者 `dsh-api-remotes/lib/client.js`：`const inject = ["remote"]`（23639 行）+ `await ctx.remote.$mount(contribution)`（23675 行） |
| 读已挂载命名空间 | `ctx.get('remote.gameCenter')` 或 `ctx.reflect.get('remote.gameCenter')` | `ReflectService.get()` 注释原文：**Read a service from the store without the inject requirement**；经 `mixin("reflect", ["get", ...])` 挂到所有 ctx |
| 时序保证 | `$mount` 内部 `await fiber` 后才返回，命名空间服务在其 fiber 内同步 `provide` | `dsh-api-gateway` `createNamespace` |

补充：`ctx.get(name, strict=true)` 默认只返回 **provider fiber 处于 active（state===2）** 的服务，
正好与 `$mount` 完成后状态一致；未挂载时返回 `undefined`，Client 现有「未挂载」分支可直接复用。

### 9.4 可复现证据（仓库内，任何人可跑）

```powershell
node tools/cordis-inject-probe/extract-cordis.mjs          # 从 asar 释放真实 Cordis（只读），exit 0
node tools/cordis-inject-probe/repro-inject-guard.mjs      # 三组对照，exit 0
node tools/cordis-inject-probe/verify-browser-cordis.mjs   # 浏览器侧同语义校验，exit 0
```

实测输出（`@deepseek-ai/dsh-desktop@0.2.1-rc.2` / commit `332895e0…`）：

```
A ctx.remote.gameCenter（inject 只有 remote）: {"ok":false,"message":"cannot get property \"remote.gameCenter\" without inject"}
B ctx.get("remote.gameCenter"): viaGet/viaReflect 均返回 {ok:true,namespace:'gameCenter'}，实例自有 getter 可调用
C inject 含 remote.gameCenter 时 apply 是否执行: {"applyRan":false}
A 复现实机报错 : PASS   B ctx.get 放行 : PASS   C 自等候死锁 : PASS
```

### 9.5 浏览器侧同语义校验（关键，不能省）

真实 GUI 加载的是 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（921071 字符，压缩），
与 Node 侧的 `@deepseek-ai/cordis` 是**两份不同产物**。只在 Node 侧证明 `ctx.get` 可用，
不能推出真实 GUI 里可用。实测四项全部命中：

| 特征 | 压缩产物中的证据 |
| --- | --- |
| `ctx.get` 由 `mixin("reflect",["get",...])` 提供 | 构造函数里原样存在 |
| `get(e,t=!0){return Cr(this.ctx,this._getImpl(e,t)?.value)}` | 直接读服务表，不查 inject |
| `_getImpl(e,t=!0){const r=this.ctx[le.isolate][e],i=r&&this.store[r];if(i&&!(t&&i.fiber.state!==2))return i}` | strict 语义一致 |
| `_refresh(){let e=!1;e="";for(const t of Object.keys(this.inject)){const r=this._store[t];if(!r){e=On;break}}...}` | 死锁机制一致 |

结论：`ctx.get('remote.gameCenter')` 在真实 GUI 中可用；把点号名写进 `inject` 在真实 GUI 中同样会死锁。

**分栏**：9.2/9.3 属 `STATIC`（源码）+ `UNIT`（真实 Cordis 离线运行）；9.5 属 `STATIC`（压缩产物特征匹配）。
都不是 `DSH-REAL`——没有在运行中的 GUI 里观察到行为。


### 9.5 交接

- Client 侧修复（`src/index.js:77`）与不写死点号 inject，由 **界面与运行时工程师** 执行，我不改其文件。
- QA 复现与验收口径由 **测试与发布负责人** 执行，约束：必须用上述真实 Cordis 探针，不能用手写宽松 mock 自证。


## 10. 实机阻断根因：`/api/gameCenter/handshake` 与 `/modelCatalog` 返回 HTTP 404

时间：2026-10-19。来源：用户实机 7 行诊断（`$mount` 正常，两条端点 404）。
证据分栏：**STATIC（源码）+ UNIT（真实 Cordis + 真实协议 + 真实认领算法离线装配）**，不是 `DSH-REAL`。

### 10.1 为什么 `$mount` 成功不能证明 Host 已注册

Client 的 `$mount` 全程在 **Client 侧**完成（校验 contribution、注册 descriptor、创建命名空间服务），
与 Host 是否存在该服务**毫无关系**。「已挂载 (ctx.remote.gameCenter 就绪)」只说明 Client 把壳搭好了。
请求发出去才由 Host 判定：Gateway `claimsEndpoint()` 若不认领该端点 → **404**。

### 10.2 认领规则（`dsh-api-gateway/lib/index.js`）

`claimsEndpoint(endpoint)` 只认三种：`$events/result`；`ctx.typert.local` 有严格定义或 `hasSeen`；
或 `collectSrcClaims()` 包含该端点。`collectSrcClaims()` 逐项要求：
`ctx.reflect.props[key].type === "service"` → receiver 存在 → `original.typertRemote` 是对象且 `namespace` 是 string
→ `remoteMethods(original)` 列出 `@Remote` 标记。任一环节缺失即不被认领，客户端看到 404。

### 10.3 当前 Host 的两个真实缺陷（都已复现）

**缺陷一（今天 404 的直接原因）**：`lib/dsh-adapter/protocol.js` 的 `dynamicProtocolLoader.load()`
是**无条件 `return null`**。后果链：

```
dynamicProtocolLoader.load() === null
  → defineGameCenterService(protocol=null, …) 第一行 return null
  → apply() 里 service === null 且不 throw
  → 从不 new GameCenterService，从不 ctx.provide('gameCenter')
  → collectSrcClaims() 找不到 typertRemote → claimsEndpoint false → HTTP 404
```

实机表现为“插件装好了、没有报错、但端点不存在”。

**缺陷二（修完缺陷一会立刻撞上）**：`applyRemoteMarkers()` 写的是 `const decorator = Remote();`
——`Remote()` **不带参数**直接抛 `typert-protocol: Remote decorator context is missing`。
真实签名是 `Remote(methodExportOrOptions, context)`，必须按 stage-3 装饰器形态调用。

### 10.4 可行修法（已用真实 tsc 标准装饰器验证）

```ts
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class GameCenterService extends TypertRemoteService {
  constructor(ctx) { super(ctx, SERVICE_KEY, { namespace: REMOTE_NAMESPACE }) }
  @Remote handshake(input) { /* … */ }
  @Remote saveAck(input) { /* … */ }
  @Remote pause(input) { /* … */ }
  @Remote leaseStatus(input) { /* … */ }
  @Remote async modelCatalog(signal) { /* … */ }
}
```

- `tsconfig` **不能**开 `experimentalDecorators`（本项目未设，默认 false = 标准装饰器，正确）；
- 删掉 `applyRemoteMarkers` 手搓逻辑；
- 协议模块要真实取得：`apply` 可返回 Promise（Cordis `Fiber._execute` 显式处理 `then`），
  用 `await import('@deepseek-ai/dsh-typert-protocol')`；或用 `createRequire` 同步 `require`（Node 24 支持 `require(esm)`）。
  **不要保留恒返回 null 的占位加载器**；
- 必须用 Host 进程解析到的同一份协议包，不 vendor 第二份，否则与 Gateway 读的标记不一致。

### 10.5 真实装配证据（仓库内可复跑）

```powershell
node tools/cordis-inject-probe/extract-cordis.mjs
node tools/cordis-inject-probe/extract-typert.mjs
node tools/cordis-inject-probe/repro-remote-claims.mjs   # exit 0
```

实测：

```
A-default-loader : {"remoteMounted":false,"failure":null,"claims":[]}
B-real-protocol  : {"failure":"typert-protocol: Remote decorator context is missing","claims":[]}
C-decorated      : {"markers":["handshake","saveAck","pause","leaseStatus","modelCatalog"],
                    "claims":["gameCenter/handshake","gameCenter/leaseStatus","gameCenter/modelCatalog",
                              "gameCenter/pause","gameCenter/saveAck"]}
A 无端点认领（=404 根因） → PASS
C 标准装饰器端点被认领（=修法可行） → PASS
```

不是 mock：加载的是安装包内真实的 cordis 与 dsh-typert-protocol；认领集合用与 Gateway 同名同算法的
`collectSrcClaims()` 计算；C 组由真实 tsc 标准装饰器编译。但仍**不是 `DSH-REAL`**。

### 10.6 QA 验收负例（三条都要）

1. 负例：默认加载器下 `claims` 必须为空——证明“装上了但没注册”可被检出；
2. 正例：修复后 `claims` 必须包含 `gameCenter/handshake` 与 `gameCenter/modelCatalog`；
3. 回归：若保留 `applyRemoteMarkers`，必须断言 `Remote()` 空参调用会抛错，防止回退。

### 10.7 协议模块怎么拿：外部插件先例与**版本错配风险**（2026-10-19 补）

Host 工程师问「其他 Host 插件怎么同步拿到 `@deepseek-ai/dsh-typert-protocol`」。实测答案如下。

**先例**：profile 里的外部插件 `dsh-mnemon` 用的是**普通静态 import**
（`dsh-mnemon/lib/index.js:26`：`import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol"`），
没有动态发现、没有 require hack。

**它能解析的原因**：从 **profile 根**出发解析，命中**全局 npm 安装**的 dsh 依赖树：

```
createRequire('<PROFILE_DIR>/package.json')
  .resolve('@deepseek-ai/dsh-typert-protocol')
→ <USER_HOME>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-typert-protocol\lib\index.js
```

环境变量 `DSH_PROFILE_DIR`（=`<PROFILE_DIR>`）、`DSH_HOME`、`DSH_PROFILE` 在会话中可用，
可作为解析锚点，不需要硬编码安装路径。

**为什么我们的插件解析失败**：我们的包以 **junction** 挂在 profile 下
（`profiles/desktop/node_modules/@dsh-gamecenter/host → <REPO>\packages\dsh-gamecenter`），
Node 默认按 **realpath** 解析，于是从 `<REPO>\...` 向上找，
永远看不到 profile 树。实测：从我们包目录 `require.resolve('@deepseek-ai/dsh-typert-protocol')` → `MODULE_NOT_FOUND`。
**这就是当初写下恒返回 null 桩的直接原因。**

**⚠ 但暴露出一个必须升级的风险：版本错配**

| 项 | 版本 |
| --- | --- |
| 运行中的桌面应用 | `0.2.1-rc.2` / `dshBuildCommit 332895e0…` |
| 全局 npm 安装的 `@deepseek-ai/dsh` | **`0.1.5-rc.2`** |
| 全局那份 `dsh-typert-protocol` | **`0.1.5-rc.2`**，导出只有 **8 个** |
| asar 内（Gateway 实际使用） | `0.2.1-rc.2`，导出 **15 个** |

全局副本缺少 `createTypertRemoteInfo`、`isRemoteJsonValue`、`principalOf`、`isRemoteUplinkItem` 等导出。
所以「照抄 dsh-mnemon 的静态 import」拿到的是 **0.1.5-rc.2 的协议**，而 Gateway 用的是 0.2.1-rc.2。

**为什么 dsh-mnemon 还能工作**：标记描述符的键是**普通字符串**
`REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods"`（两份完全一致），
所以跨副本写入的标记，Gateway 用自己那份 `remoteMethods()` 仍能读到。这属于「靠字符串键兼容」，
不是设计保证。

**建议（按风险从低到高）**
1. **首选**：把 `@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2` 作为我们包的依赖装入（registry 上确有该版本），
   与运行版本对齐；跨副本发现依赖同一字符串键，已验证可行。需确认它带的 `@deepseek-ai/cordis` 不会引入第二份
   Cordis 造成 `Service` 基类不一致（cordis 的隔离键用 `Symbol.for`，跨副本大概率兼容，但**要在 staging 实测**）。
2. 次选：按 `dsh-mnemon` 方式静态 import，但**必须**在 staging 验证 0.1.5 协议的 `Remote`/`TypertRemoteService`
   与 0.2.1 Gateway 协同无异常，否则会出现「能注册但调用期报错」。
3. 无论哪条：**协议不可用时必须显式抛错**，不能像现在这样静默返回 null 让 UI 可见、服务不存在。

**决定性验证只能在真实 Host 里做**：离线探针（§10.5）只证明「装饰器 + 认领算法」可行，
不能证明「本机两份协议副本协同可行」。

## 11. 真实 Gateway 分派验证（2026-10-19，`exit 0`）

PM 要求不能以「复制 collectSrcClaims 算法」代替真实 Gateway。本轮已用**实装 Gateway**完成进程内装配。

**脚本**：`tools/cordis-inject-probe/gateway-dispatch.mjs`
**运行**：`node tools/cordis-inject-probe/gateway-dispatch.mjs` → **exit 0**

### 11.1 做法

从 asar 释放**实装**依赖到独立 arena，避免与仓库副本混淆：
`@deepseek-ai/{cordis, cosmokit, dsh-brand, dsh-typert-protocol, dsh-api-gateway, dsh-deque, dsh-timeout, schemastery}`
+ `@standard-schema/spec`、`zod`、`ws`。

然后：
1. 用**实装 Cordis**建 Context；
2. 插件化**实装 `TypertGatewayService`**（不是复制算法，是原版类）；
3. 以 Host `staging/index.js` 的**默认 apply**装配（`inject: ['llm']`，**不传任何 options / fakeProtocol**）；
4. 调 Gateway 自己的 `claimsEndpoint()` 与 `invoke()`。

依赖 stub 仅三个，且**明确不冒充真实服务**：`typert`（`local.get`→undefined、`hasSeen`→false，强制走 SRC 认领路径）、
`remoteAccess`（decide→allow）、`llm`（零 stream，`stream()` 直接抛错防止误调）。

### 11.2 实测结果

```
Host default apply registers service : PASS   （remoteMounted = true）
Real claimsEndpoint claims endpoints : PASS   （gameCenter/handshake、gameCenter/modelCatalog 均 true）
Real invoke dispatches to methods    : PASS
```

`invoke` 真实返回：
```json
handshake    -> {"ok":true,"generation":1,"runtimeToken":"<32B base64url>","tokenDigest":"sha256:…","state":"running"}
modelCatalog -> {"entries":[],"failures":[],"available":true}
```

### 11.3 两份协议副本（跨副本已实证）

| 副本 | 绝对路径 | 版本 | 导出数 |
| --- | --- | --- | --- |
| 宿主（asar） | `<tmp>\gateway-arena\node_modules\@deepseek-ai\dsh-typert-protocol\lib\index.js` | 0.2.1-rc.2 | 16 |
| 仓库（registry） | `<repo>\node_modules\@deepseek-ai\dsh-typert-protocol\lib\index.js` | 0.2.1-rc.2 | 15 |

两者物理路径不同（脚本断言 `sameInstance === false`），**确为跨副本**。
跨副本可通的根本原因是标记键是普通字符串
`REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods"`，
不是 `Symbol()`；这一点已在真实 invoke 中被证实，不再是推断。

### 11.4 依赖声明缺口（重要）

`packages/dsh-gamecenter/package.json` 的 `dependencies` 已含
`"@deepseek-ai/dsh-typert-protocol": "0.2.1-rc.2"`，`pnpm install` 后
`packages/dsh-gamecenter/node_modules/@deepseek-ai/dsh-typert-protocol` 为真实符号链接，
解析到 `.pnpm` 存储。**因此运行时依赖是包级声明，不是"靠根 node_modules 偶然可用"。**

但仍需注意三条部署条件：
1. 根 `devDependencies` 里那份同名包是给**类型检查探针**用的（`tsc` 与 `@Remote` 类型），
   不能反过来当成运行时依赖的证明；
2. 当前部署方式是 **junction**（profile → 仓库包目录），Node 按 realpath 解析，
   所以走的是仓库 `node_modules`；若改为**复制**进 profile，则需在 profile 侧同样可解析该依赖，
   否则会 `MODULE_NOT_FOUND`；
3. `@deepseek-ai/cordis` 只被 `import type` 使用（编译期擦除），不构成运行时依赖；
   但若将来改成值导入，必须补运行时依赖。

### 11.5 可否进入部署

- 装配层：**可以**。默认入口注册服务、原版 Gateway 认领、原版 Gateway 分派三项均通过。
- 生效方式：Host 产物在**进程启动时**加载，**仅刷新页面不会生效**，必须正常重启 GUI 进程。
- 仍属 `STATIC + UNIT`：这是进程内真实装配，**不是**运行中 GUI 的 `DSH-REAL` 观测。

## 12. Host 部署前核对：候选是**整棵树** 9 文件变更（2026-10-19）

架构侧对 `packages/dsh-gamecenter/staging/` 与在线 `lib/` 做逐文件哈希比对，结果：

| 项 | 值 |
| --- | --- |
| staging 文件数 | 21 |
| lib 文件数 | 21 |
| lib 独有（会残留的孤儿文件） | **0** |
| 变更文件 | **9** |
| staging 整树摘要 | `CB4DDE0DB452C03C666EC1E05F218BA6` |
| 在线 lib 整树摘要 | `EB2D9A2B9CF2611ED5F45C376A836E89` |
| 在线 `lib/index.js` | `8A9138211940E70C…` |
| 候选 `staging/index.js` | `93F30A7B51B8D857…` |

变更的 9 个文件：

```
index.d.ts
index.js
index.js.map
dsh-adapter/protocol.d.ts
dsh-adapter/protocol.js
dsh-adapter/protocol.js.map
remote/game-center-service.d.ts
remote/game-center-service.js
remote/game-center-service.js.map
```

**风险（必须写进部署单）**：如果只替换 `staging/index.js`，`lib/remote/game-center-service.js` 仍是旧版
（仍含恒返回 null 的协议加载器与 `Remote()` 空参缺陷），**修复不会生效，404 会原样复现**，
而所有人会以为"已部署"。**必须整树替换或至少替换上述 9 个文件。**

建议部署步骤（本次不做，等授权）：
1. 新建不覆盖备份目录，整份复制当前 `lib/`，记录整树摘要 `EB2D9A2B…`；
2. 用 `staging/` **整树**覆盖 `lib/`（21 文件），随后校验整树摘要 = `CB4DDE0DB4…`；
3. 校验无孤儿文件（当前已确认 0 个）；
4. **正常重启 DSH 桌面进程**（Host 插件在进程启动时装载，页面刷新无效）；
5. 重启后打开游戏中心重跑诊断，观察 7 项指标；
6. 失败回滚：用备份整份覆盖 `lib/`，再重启。

## 13. 重启后「握手假阳性」根因：Client 未解包 `value`（2026-10-19）

实机现象（用户实测、已部署 Host `CB4DDE0D…` + Client `1BE7FDA8…`、404 已消失）：
```
$mount          正常  已挂载
handshake       正常  已连接 (代次 generation=0, 状态=running)   ← 无 runtimeToken
modelCatalog    告警  不可用 (failures=0: 服务未就绪)
leaseStatus/pause/saveAck  跳过 (未收到有效 runtimeToken)
```

### 13.1 线上真实信封形状（用实装 handler 实测）

`tools/cordis-inject-probe/gateway-dispatch.mjs` 直接调用实装 `/api` 拦截器 `dispatchRpc()`，实测：

```json
{ "envelopeKeys": ["ok","value"], "ok": true, "hasValueKey": true,
  "valueKeys": ["entries","failures","available"] }        // modelCatalog
{ "envelopeKeys": ["ok","value"], "ok": true, "hasValueKey": true,
  "valueKeys": ["ok","errorCode","message"] }              // handshake
```

即：**`{ ok: true, value: <业务结果> }`**。`dispatchRpc` 是 `/api` 的拦截器
（`connection.rpc.intercept("/api", claimsEndpoint, dispatchRpc)`），业务字段一律在 `value` 内。

### 13.2 Client 缺陷（单点，Host/Gateway 无问题）

`packages/dsh-gamecenter-client/src/bridge/remote-mount.js` `createGameCenterClient().call()`：

```js
const result = await fn.call(remoteService, ...args)
const failure = remoteFailureOf(result)   // 能识别 result.ok === false
if (failure !== null) throw ...
return result                              // ← 直接返回**信封**，未取 result.value
```

`remoteFailureOf` 只处理了失败分支（`result.ok === false`），**成功分支没有解包 `result.value`**。

于是 `diagnostics.js` 拿到的是信封：

- handshake：`hs.generation` → `undefined` → `?? 0` → **generation=0**；
  `hs.runtimeToken` → `undefined` → 判定无凭证 → **后续全部 skip**；
  `hs.state` → `undefined` → `|| 'running'` → **running**；而 `status` 在 try 成功后恒为 `'ok'` → **假阳性"正常"**。
- modelCatalog：`cat.available` → `undefined` → 走 else 分支；
  `Array.isArray(cat.failures)` → false → `failCount=0` → 默认文案 **"服务未就绪"**。

**用户的 7 行输出与上述推导逐字吻合**，无需假设 Host 有问题。

### 13.3 修法（Client 侧，最小改动）

在 `call()` 的成功返回处解包，并保持失败语义：

```js
const result = await fn.call(remoteService, ...args)
const failure = remoteFailureOf(result)
if (failure !== null) throw ...
// 线上信封为 { ok: true, value: <业务结果> }；业务结果自身也可能带 ok 字段（handshake），
// 因此用「有 value 键」而不是「有 ok 键」判定信封，避免误伤业务形状。
if (result !== null && typeof result === 'object' && result.ok === true && Object.hasOwn(result, 'value')) {
  return result.value
}
return result
```

配套（PM 已要求）：成功判定必须 `ok === true && Number.isInteger(generation) && generation > 0 && typeof runtimeToken === 'string' && runtimeToken.length > 0`；
任一不满足即显示"契约异常"，**不得默认 0/running**。`modelCatalog` 同理必须读 `available`，缺失即判异常而非"服务未就绪"。

### 13.4 分栏

本节证据为 `STATIC（源码）+ UNIT（实装 handler 实测信封）`。
**不是 `DSH-REAL`**：尚未在重启后的 GUI 中用修复版观测。阶段0 维持未通过。
