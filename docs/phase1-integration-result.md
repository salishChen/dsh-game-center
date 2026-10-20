# 阶段1 集成验收结果与剩余阻断（2026-10-19 收尾轮）

执行人：架构与协议负责人（协议/集成协调）。**本文件是当前真实结论，不是计划。**

## 1. 一句话结论

**阶段1 暂不可提交。** 存储专项（SQLite 原子事务、跨进程、并发、幂等）已取得可复现证据；但 **Host 侧存在编译错误（typecheck 退出码 2）**，且完整链路（SDK→Bridge→Host）传参刚接通、未在真实 DSH 内验证。在线 `lib/` 偏差仍未处置。

## 2. 本轮我做了什么（有 diff 的）

| 项 | 文件 | 内容 |
| --- | --- | --- |
| 恢复强断言 | `tests/integration/test/p6-integration.test.mjs` | P6-10 恢复 `idempotentReplay === true`；新增"首次写入必须为 false" |
| 消除个人路径 | 同上 + `fixtures/checkpoint-child-{writer,reader}.mjs` + `checkpoint-racer.mjs` + 新增 `fixtures/game-repo.mjs` | 改为 `DSH_MINESWEEPING_REPO` 优先、默认 `path.resolve(REPO_ROOT, '../dsh-game-minesweeping')`；**0 处硬编码个人路径** |
| P6-4 改用真实 SQLite | 同上 | 关闭→持久化→重建不再用 `MemorySaveBackend`，改为临时 DB 文件的 `SqliteSaveBackend` |
| SDK 补契约字段 | `packages/dsh-gamecenter-client/src/sdk/index.js` | `checkpoint(gameState, opts)` 现在真正传 `operationId` 与 `expectedRevision`；新增 `lastKnownRevision` 自动推进；缺省时用 `computeAutoOperationId()` 由状态派生稳定 ID（同状态重试复用同一 ID） |
| Bridge 透传 | `packages/dsh-gamecenter-client/src/bridge/dispatcher.js` | `save.checkpoint` 现在把 `operationId`/`expectedRevision` 原样转发，回传 `idempotentReplay`；`playerId` 只取宿主注入的 `options.playerId`，绝不取游戏自报值 |

**修的过程中我自己引入并已修掉的错误**（如实记录）：
1. 先是给 `save.checkpoint` 加了"缺 operationId/expectedRevision 就拒绝"的强校验，结果把既有 A9 用例卡住不返回 → **测试进程挂死**；改为透传不拦截（判定权在宿主）。
2. 编辑时留下重复残块，导致 `dispatcher.js` 语法错误（`Missing catch or finally after try`）→ `node --check` 发现并删除。
3. 只改实现没同步 `@typedef`，typecheck 报 `playerId`/`idempotentReplay` 不存在 → 补 typedef 后 client typecheck 恢复 0。

## 3. 当前实测（逐包，非引用他人汇报）

| 包 | 测试 | typecheck |
| --- | --- | --- |
| protocol | 37/37 | 0 |
| catalog | 35/35 | 0 |
| client | 107/107 | 0（修 typedef 后） |
| host | 107/107 | **退 2（见 §4）** |
| integration | 10/10 | — |

## 4. 剩余阻断清单（提交前必须清零）

| # | 阻断项 | 证据 | 归属 |
| --- | --- | --- | --- |
| B1 | **Host 编译失败** `save-store.ts(187,58)`、`(294,46)` TS2345：`saveKey(playerId,gameId,saveId)` 新签名与旧调用点不匹配，`playerId` 为 `string \| undefined` | `pnpm run typecheck` 退出码 2 | Host，已交回 |
| B2 | **`playerId` 兜底会破坏跨玩家隔离**：`save-store.ts:188` 用 `?? 'default-player'`，宿主未注入时所有玩家合并进同一存档 | 静态审查 | Host，已要求改为缺则拒绝 |
| B3 | **在线 `lib/` 与批准版本不一致**：`lib/index.js` 由 `93F30A7B…` 变为 `FB9EB402…`；相对 Git 基线 **变更 3 个**（`index.{js,d.ts,js.map}`）、**多出 6 个** `storage/*`、缺失 0 | 逐文件核对 | PM 处置，我不动 |
| B4 | ~~批准版本不可从本地重建~~ **已更正**：`git show 3b0fb96:packages/dsh-gamecenter/lib/**` 逐 blob 提取到临时目录后，与批准 manifest 21 条逐文件比对 **21/21 MATCH，DIFFS=0**，入口 `index.js = 93F30A7B…`。**Git 基线可作为字节级恢复来源**（4 份 staging-rollback 备份则不是） | 21 文件实测 | PM 决定是否恢复、何时恢复 |
| B4a | **我此前的测量错误（已更正）**：曾报"git HEAD 的 `lib/index.js` 是 `EB824B19…`"。原因是用了 PowerShell `>` 回显 `git cat-file` 输出，重定向改写了字节（4819→6932）。正确做法是 `git show <sha>:<path> > file`（cmd 重定向，原样字节） | 复现实验 | 我的方法错误，非 git 问题 |
| B5 | **整树摘要算法不可复现**：按 `host-deploy-manifest.md:20-21` 描述的算法复算 4 份备份与当前 `lib/`，均得不到登记值；多变量试算亦不匹配 | 复算记录 | 文档缺陷，改用逐文件清单 |
| B6 | 真实 DSH 内"关闭→恢复"（A6 实机） | 未做，需部署授权 | 待授权 |

## 5. SDK→Bridge→Host 传参现状（PM 特别要求核的）

| 环节 | 现状 |
| --- | --- |
| SDK 生成 `operationId`/`expectedRevision` | **已实现**：显式传入优先；缺省用 `computeAutoOperationId(state, elapsed, rng)` 派生，并缓存 `lastKnownRevision` |
| Bridge 透传 | **已实现**：原样转发，回传 `idempotentReplay` |
| Bridge 注入 `playerId` | **依赖宿主**：`options.playerId`，Client 无身份来源；未注入时目前传 `undefined` |
| Host 接收并使用 | **部分**：`WriteCheckpointInput` 已有 `operationId`/`expectedRevision`/`playerId` 字段，但 B1/B2 未修前不可信 |
| 端到端"SDK 真的调用 Host" | **未验证**：集成测试是直接调 `SaveStore`，没有经过真实 Bridge + SDK 的完整路径 |

## 6. 覆盖不到（明确声明）

- 未打真实 GitHub API；目录/审批是 fixture（MOCK）；
- 未在真实 DSH 内运行（无 DSH-REAL）；
- 未做真实模型调用（`AUTH-PENDING` 未变）；
- 未部署、未刷新、未重启、未 push；在线 `lib` 未回滚、未重建；
- `test:integration` 已改为 `build:staging`（`tsc -p tsconfig.staging.json`），实测**不改变** `lib/index.js` 哈希与 mtime。

## 7. 结论

存储原子事务专项**可以保留为已取得证据**（跨进程、并发、幂等、事务中断、损坏拒读均有实测）。
但阶段1 整体**不可提交**：B1 编译失败是硬阻断，B2 是正确性问题，B3–B5 是在线版本与基线一致性问题且需 PM 裁决。我不把"测试数全绿"当作可提交理由。
