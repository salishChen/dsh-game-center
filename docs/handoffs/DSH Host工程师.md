# 交接：DSH Host工程师（阶段1 生产接线收口）

时间：2026-10-20。状态：**阶段1 本地候选就绪、未提交未部署、禁止直接上线**；本文是事实交接快照。

## 1. 职责与所有权边界

- **我拥有**：`packages/dsh-gamecenter/**`（Host 插件入口、Cordis 服务绑定、Typert Remote 服务声明、运行时租约状态机、SQLite 存档/请求账本/原子事务及对应单元测试）。
- **我不改**：`packages/dsh-gamecenter-client/**`（Client 界面与运行时）、`packages/dsh-gamecenter-catalog/**`（目录与安装）、`packages/protocol/**`（协议与根配置）、`tools/**`（架构对账门禁）。跨模块需求通过对账契约与 @ 对齐，严禁跨边界覆盖。
- **工作模式**：向项目经理汇报，与架构与协议负责人对齐协议；严格使用非 GPT 模型，禁止触发真实付费模型调用。

## 2. 本轮实际成果（按证据分栏）

**STATIC（源码实现与审查）**
- **路径强校验**：`src/index.ts:142` `resolveDataDir` 在 `path.resolve` 之前执行 `path.isAbsolute(trimmed)` 强拦截，相对路径一律抛出 `TypeError` 拒绝启动，彻底根除相对路径被静默 resolve 到 `<cwd>/...` 的缺陷，已清理历史残留的根目录泄漏。
- **宿主可信身份**：`src/index.ts:110` `resolvePlayerId` 彻底关闭未经核实的 `ctx.playerId` 与 `ctx.user?.id` 猜测回退，仅接受显式配置的 `options.playerId`；缺失、空串或包含 `..`、`/`、`\` 穿越符一律抛 `TypeError` 阻断，彻底移除 `default-player` 默认身份。
- **13 条 Remote 对齐**：`src/remote/game-center-service.ts` 完整实现与 protocol `GAMECENTER_REMOTE_METHODS` 严格一致的全部 13 条 `@Remote` 方法（既有 5 条 + 目录安装 4 条 + 检查点存读 2 条 + 受控预览 2 条 + 放弃未完成启动 `abandonRuntime`）。
- **握手 saveId 与 launchToken 双必填强校验**：`handshake()` 严格执行 `isSaveIdShapeValid(input.saveId)` 与 `isLaunchTokenShapeValid(input.launchToken)`（32~256 字符无空白可见 ASCII）校验；缺失或非法一律阻断为 `PROTOCOL_INVALID`；命中已放弃实例索引立即拒绝（`runtime-abandoned`）。
- **快路径放弃 abandonRuntime**：实现 `abandonRuntime({ runtimeInstanceId, launchToken })`，通过 `launchToken` 摘要与实例双向交叉校验；若握手未到则提前登记毒丸拦截后续迟到握手，若已在途则立即回收；重复调用幂等返回 `{ ok: true, abandoned: true, reclaimed: false }`，口令不匹配报 `ABANDON_FORBIDDEN`。
- **未确认租约有界回收（T_ack = 3000ms + 定时器扫描 1000ms）**：`handshake` 成功只创建 `pending` 租约，并绑定 `ackDeadline = nowMs + LEASE_ACK_WINDOW_MS`；首次合法确认调用原子转为 `running`；在 `src/index.ts` 的 `apply()` 中通过 `ctx.effect` 接入 `setInterval` 定时扫描器（`SCAN_INTERVAL_MS = 1000`），无人读写时最多 4000ms 内主动触发 `core.sweepUnconfirmed()` 回收，`effect` 卸载与 `api.dispose()` 严格执行 `clearInterval` 停表；利用 `priorSealedSnapshot` 无损还原前序封存态，绝不误杀正常静置的 `running` 玩家。
- **租约安全修复（旧代次凭证作废）**：`src/runtime/lease.ts` 引入 `supersededTokens` 索引。在 `acquire()` 覆盖同一 `saveKey` 前调用 `supersedePriorFor()` 将被顶替旧实例的 tokenDigest 移至已作废集合；`resolveByToken()` 命中后确定性返回 `STALE_RUNTIME`（`reason: token-superseded`），根除已封存旧实例写新代次存档漏洞。
- **统一身份解析入口**：`saveCheckpoint` 统一调用 `this.core.resolveRuntime()`，消除旧代码错误调用不存在成员导致的 TypeError 隐患。
- **真实检查点写入**：`saveCheckpoint` 严格依 `runtimeToken` 从租约权威换出 `gameId`/`saveId`，坚决拦截调用方自报 `playerId`；通过 `decideCheckpointAdmission` 准入；底层经 `SaveStore` 接入 `SqliteSaveBackend`，执行 `BEGIN IMMEDIATE` 原生排他事务与 `operationId` 幂等查重，回带 `revision` 并推进租约已持久版本。
- **pausing 写保护与收尾顺序**：`LeaseRecord` 绑定 `authorizedFinalOperationId`。进入 `pausing` 后仅允许首个授权最终操作及其同 `operationId` 的幂等重试，拒绝额外写入；`lease.confirmPause` 修正为 `<`，允许已持久检查点成功 `saveAck` 封存并转为 `paused`，封存后一切写入拒为 `STALE_RUNTIME`。
- **后端兜底移除**：`src/storage/sqlite-save-backend.ts` 彻底删除 `defaultPlayerId` 配置与 `'default-player'` 字符串兜底，`input.playerId` 缺失时直接 `ROLLBACK` 并返回 `PROTOCOL_INVALID`，后端零写入。

**UNIT / MOCK（自动化回归，双退出码为 0）**
- `pnpm -C packages/dsh-gamecenter test`：**10 个测试文件，110/110 全部通过，退出码 0**（新增无人读写时后台定时扫描器自动回收及 dispose 停表用例）。
- Host 静态类型检查 `pnpm -C packages/dsh-gamecenter run typecheck`：**退出码 0**（tsc 退出码 0），零类型错误。
- 门禁核验 `node tools/audit-wire-consistency.mjs`：**14/14 PASS，退出码 0**（涵盖 13 方法对齐、真实 SQLite、无假保存、sandbox、abandonRuntime、launchToken 绑定、T_ack 有界回收、无玩家静止误杀、Client 接线）。

**BUILD / GATE（门禁工具与探针，非 DSH-REAL）**
- 门禁静态对账工具 `tools/audit-wire-consistency.mjs`：14/14 全绿（退出码 0）。
- 架构探针 `tools/probe-host-entry.mjs`：等待架构与协议负责人补齐 N9..N13 测试套件。

## 3. 关键哈希与在线/离线区分（2026-10-20 12:25 采集）

| 文件 | 状态 | SHA256 完整哈希 |
|---|---|---|
| `packages/dsh-gamecenter/staging/index.js` | 候选构建（**未部署**） | `678015d69fbe6d2ae045ff3732169d433890e77636a73d64e28f5ab61917bd74` |
| `packages/dsh-gamecenter/staging/remote/game-center-service.js` | 候选构建（**未部署**） | `ba8d7df2318db9ac1e29526255a66ba7aaf157a9e0007bcd2e450f72ce1164db` |
| `packages/dsh-gamecenter/staging/runtime/lease.js` | 候选构建（**未部署**） | `15a6780f850f04a3248bc1a71162c9294401aab4fe2adbba83cd883d5693e1fa` |
| `packages/dsh-gamecenter/staging/storage/sqlite-save-backend.js` | 候选构建（**未部署**） | `16885e6aed51792094ad13161d9d4eedb5fd0d1d68912d58e7f023780573e2fa` |
| `packages/dsh-gamecenter/lib/index.js` | **在线基线（运行中，未动）** | `34852ba0e5b8719bc412353a1a1f0a2ca399e525143a57e3f898a3b839b1a0be` |

在线 Host `lib/` 保持 27 个文件整树未触碰。恢复在线 `lib/` 至阶段0纯净基线需等待用户单独授权。

## 4. 真实阻断与遗留风险

1. **已关闭阻断**：
   - 握手 `saveId` 必填与槽位隔离已闭环；
   - 启动令牌 `launchToken` 与快路径 `abandonRuntime` 双向鉴权已闭环；
   - 未确认租约 `T_ack`（3000ms）+ 定时器（1000ms）有界独立回收已闭环；
   - `audit-wire-consistency.mjs` 门禁 14 项全绿。
2. **实机真实性挂账（DSH-REAL）**：当前全部通过均属于 MOCK/BUILD/UNIT，尚未在真实 DSH 桌面端 Electron/Cordis 环境中挂载测试，阶段0 挂账项（真实模型调用 AUTH-PENDING、流式取消等）继续维持挂账。

## 5. 下一步工作建议（最多 3 条）

1. **配合测试负责人复跑跨端联合用例**：协助 QA 执行 `probe-host-entry.mjs` 与 `real-host-staging-joint.test.mjs` 的回归核验。
2. **在线 `lib/` 纯净度恢复准备**：等待 PM 向用户申请在线 profile 与 `lib/` 恢复授权，完成阶段1单次正式提交前置准备。

## 6. 授权边界（新会话必须遵守）

- 在线 `lib/`、`dist/`、用户 `desktop profile`（`C:\Users\salis\.dsh\profiles\desktop`）：**严禁修改、覆盖、重启或刷新**。
- 远程仓库写入（git push）、阶段正式提交（git commit）、真实付费模型调用、删除用户本地存档：**必须获得用户显式授权**。
- 证据纪律：测试通过必须同时给出 `tsc` 与测试两个退出码，严禁将 MOCK/UNIT 本地测试标注为 DSH-REAL。

## 7. 新会话优先读文件（4个）

1. `docs/handoffs/项目经理.md`（项目统筹总交接与阶段节奏）
2. `docs/handoffs/架构与协议负责人.md`（协议契约、门禁判据与最新复验事实）
3. `packages/protocol/src/wiring.ts`（冻结的 12 条 Remote 方法与类型约束）
4. `tools/probe-host-entry.mjs`（Host 生产入口核心动态探针）
