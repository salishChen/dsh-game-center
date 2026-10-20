# 阶段1 实机部署 / 回滚 / 配置影响清单（v2，待审批，未执行）

生成：2026-10-20，架构与协议负责人（DSH 本体源码由本人以 DeepSeek 实读核实）。
本文件在候选冻结范围之外（不在 manifest 覆盖路径内），**只做只读准备**，不构成执行授权。
验收基线：`docs/phase1-candidate-manifest.txt`（v2，260 文件）；验前快照 `docs/phase1-candidate-manifest-v2-BEFORE.txt`（QA 已 `--compare` 核对 `IDENTICAL`）。

> 证据分栏：本文哈希为本地实采（MOCK/BUILD）。**DSH-REAL 一律未验**，须部署后按 §7 实测。

---

## 0. 结论与纠错

1. **D1 与 D3 不是二选一，两者皆需**：当前候选在没有任何 `config` 的 profile 下**必然启动失败**（`dataDir`/`playerId` 均必填），所以“只换产物”不可能成功；只改配置不换产物也没有意义。
2. 备份（D4）必须**先于**任何写入；本文 §4 给出代码与数据库两条独立备份。
3. 加载方式（D2）见 §6，已按 DSH 本体源码核实，**不再断言“只能重启”**。
4. 整树值不是完整 SHA256：它是**32 位十六进制截断摘要**，算法见 §3。

## 1. 部署目标（来源 → 目标）

| # | 来源（已验证） | 目标（在线） | 说明 |
| --- | --- | --- | --- |
| D1-H | `packages/dsh-gamecenter/staging/**`（**27 文件整树**） | `packages/dsh-gamecenter/lib/**` | 整树覆盖；只换 `index.js` 会让 `remote/`、`runtime/`、`storage/` 停旧版 |
| D1-C | `packages/dsh-gamecenter-client/staging/client.js` | `packages/dsh-gamecenter-client/dist/client.js` | 单文件 |
| — | `packages/dsh-gamecenter-client/lib/**` | **不覆盖** | Host 半 no-op 声明，未变 |

完整 SHA256（逐文件，可复算）：

| 产物 | SHA256 | 字节 |
| --- | --- | --- |
| Client `staging/client.js` | `D028706B815EB24A212054B606CB0D25F78BE7710B3E0A2F972EFC25B1804558` | 134,048 |
| Host `staging/index.js` | `678015D69FBE6D2AE045FF3732169D433890E77636A73D64E28F5AB61917BD74` | 9,209 |
| Host `staging/remote/game-center-service.js` | `BA8D7DF2318DB9AC1E29526255A66BA7AAF157A9E0007BCD2E450F72CE1164DB` | 40,532 |
| Host `staging/runtime/lease.js` | `15A6780F850F04A3248BC1A71162C9294401AAB4FE2ADBBA83CD883D5693E1FA` | 24,045 |
| Host `staging/storage/sqlite-save-backend.js` | `16885E6AED51792094AD13161D9D4EEDB5FD0D1D68912D58E7F023780573E2FA` | 13,656 |
| 在线 Client `dist/client.js`（当前） | `427F79EA2F7CC06C1ED74BAEA665FA0EC41075746846DF6F8DAE9BCDBDE13110` | 56,263 |

## 2. 实际覆盖数（实采）

- Host：候选 27 文件 vs 在线 27 文件 → **覆盖 15**、不变 12、**新增 0**、**多余需删 0**。
- Client：**覆盖 1**。
- **纠错**：先前“部署时删 6 个 storage 文件”作废。新 Host 依赖 `storage/save-store.js` 与 `storage/sqlite-save-backend.js`，删除即失去存档功能。

## 3. 整树摘要：算法与收录范围（不是完整 SHA256）

- **名称**：`TREE32`（32 位十六进制截断摘要），**不得称作完整 SHA256**。
- **算法**：对收录清单中每个文件，取 `相对路径（正斜杠，相对该树根） + ':' + 该文件完整 SHA256（大写）`，按**相对路径的 Unicode 码点升序**排序（等价 JS `localeCompare` 之外的字节序请在复算时固定为 `Array.prototype.sort()` 默认序，本文三个值均以 `sort()` 默认序计算），以 `'\n'` 连接，对结果的 **UTF-8 字节**取 SHA-256，保留前 32 位十六进制（大写）。
- **收录清单**：该树根下**所有普通文件**，递归，不含符号链接、不含目录项；相对路径一律 `/` 分隔；临时文件/`.bak` 不收录（备份必须放在树根之外）。
- 当前三个值：

| 树 | TREE32 | 文件数 |
| --- | --- | --- |
| 批准阶段0 Host `lib/`（依 `docs/host-lib-approved-manifest.txt`） | `6700BE82DB9C5CC0CF46545F1E5950D9` | 21 |
| 当前在线 Host `lib/` | `6381300D1A8CB50DC44C642A3B7D99B8` | 27 |
| 候选 Host `staging/` | `DB75E014DA0BEFFA48CC6E50EE5DB33E` | 27 |

## 4. 备份（必须先于任何写入）

**4.1 代码备份**
1. `lib/` → `lib.bak-deploy-prev-<stamp>/`（27 文件整树，**放在 `packages/dsh-gamecenter/` 之外的备份目录**，避免污染树根与 TREE32）。
2. `dist/client.js` → 同备份目录。
3. `C:\Users\salis\.dsh\profiles\desktop\cordis.yml` → 同备份目录（若 D3 执行）。
4. 备份后立即重算 TREE32，必须等于 `6381300D…`；`dist/client.js` 的 SHA256 必须等于 `427F79EA…`。

**4.2 数据库备份（不能只复制主 db）**
- **首选：全新隔离验收库。** 在**独立的 `dataDir`**（§5）下新建空库，部署后所有写入落在该隔离库，**完全不触碰现有存档**。这是本清单默认方案。
- 若必须使用现有库：SQLite 处于 WAL 模式时，单独复制主 db 文件**不能保证一致快照**（`-wal`/`-shm` 未合并）。必须二选一：
  - 用 `node:sqlite` 的在线备份能力（`DatabaseSync` 的 backup API，若本版本提供）导出快照；**具体 API 名称与可用性待核**，不能凭记忆断言；
  - 或停写后进行完整文件级备份（主库 + `-wal` + `-shm` 一并复制，或先执行 checkpoint 再把 WAL 归零）。
- 无论哪种，校验方式为**打开备份库并执行完整性检查**（而不是只比主文件 hash）。

## 5. 配置（D3，必须执行）

实读 `C:\Users\salis\.dsh\profiles\desktop\cordis.yml:1544-1547`：

```yaml
- id: gamecenter-host
  name: '@dsh-gamecenter/host'
- id: gamecenter-client
  name: '@dsh-gamecenter/client'
```
两条条目**均无 `config`**，而 Host `apply()` 要求 `options.dataDir` 为**绝对路径**、`options.playerId` 为非空且不含 `..`/`/`/`\`，缺任一即抛 `TypeError` 拒绝启动。

**取值口径（PM 2026-10-20 指定的隔离验收方案，本文以此为准）**：
- `playerId`：`acceptance-phase1`（隔离验收命名空间；不使用 `default-player` 的任何变体，不复用他人真实身份）。
- `dataDir`：`C:\Users\salis\.dsh\gamecenter-acceptance\phase1`（**全新隔离目录，绝对路径**；部署前该目录应为空或不存在，由 Host 首次创建）。
- 补充修正（我核对 DSH Host工程师 建议时发现）：他建议的 `C:\Users\salis\.dsh\data\gamecenter` **不在 PM 指定的隔离方案内**，本清单不采用；其“必须显式配置 `cordis.yml`”与“`abandonRuntime`/`scanIntervalMs` 不写 config”的结论与本文一致。
- 审批用配置片段（**待用户批准后才可写入**）：

```yaml
- id: gamecenter-host
  name: '@dsh-gamecenter/host'
  config:
    playerId: acceptance-phase1
    dataDir: C:\Users\salis\.dsh\gamecenter-acceptance\phase1
```

- `scanIntervalMs`：有默认 1000ms，**不写**；`abandonRuntime` 是 Remote 方法，**不是配置项**。
- **只改 `gamecenter-host` 一条**；`gamecenter-client` 保持无 `config`。

**生产多用户身份信任边界（单列）**：本阶段的 `playerId` 是**单机单用户显式配置**，Host 不校验它是否等于“当前登录用户”。因此在多用户共享同一 DSH 安装时，任何能改 profile 的人都能指定任意 `playerId` 读写对应存档。**这是阶段1已知边界，不是缺陷修复项**；多用户隔离需在后续阶段引入身份校验后另行设计。

## 6. 加载方式（D2）：基于 DSH 本体源码的结论

实读 `@deepseek-ai/dsh-hmr@0.2.1-rc.2`（`lib/index.js`）：

- `profileRoots(dir)`（L1449-1453）：把 **profile 目录**与 `profile/node_modules` 下**所有符号链接包的真实路径**都纳入 root；本机 `node_modules/@dsh-gamecenter/{host,client}` 正是指向仓库包的符号链接，因此仓库内 `lib/`、`dist/` 的改动**落在被监视的 root 内**。
- `reconcileProfile()`（L1320-1385）：重新读取 patch、比较已加载模块与磁盘、替换变化的模块、停掉相关 Loader 条目并用磁盘上的新文件重启条目。
- `planReplacement()`（L1214-1249）：只有当变化模块的导入链触及**进程入口静态图**（`host-module`）或插件不受 Loader 管理（`unmanaged-plugin`）时，才标为 `pending`、需要重启；否则走热替换。
- 反证：旧版 Client 产物（56,263 字节）grep `dsh-gamecenter:hello` = 0，说明该产物**确实由外部读取**而非 Node import，其更新应表现为可重新获取的静态资源。

**结论**：Host 能否不重启而热加载新 `lib/`，取决于「变化模块是否属于进程入口的静态 import 图」——`@dsh-gamecenter/host` 由 `cordis.yml` 的 Loader 条目启动，**理论上走 Loader 重启条目而非整体重启**；但 hot reload 还需要该条目的变化被 `reconcileProfile` 观察到（`hmr` 在 profile 中 `disabled: !!js '!ctx.get(''profileContext'')'`，即仅在 profile 上下文启用）。

**因此本清单的加载方式定为（按 PM 2026-10-20 裁定）**：
1. **只依赖 HMR 的 profile 重载**——覆盖产物后观察 HMR 是否重载 `gamecenter-host`/`gamecenter-client` 条目（日志出现 reload 与条目重启），再刷新页面验证 Client bundle 重新拉取；
2. **HMR 未生效即停止并报告，不自动重启整个 DSH**（这是本次授权的硬边界：重启不在授权范围内）；
3. **刷新页面**只能让 Client bundle 重新拉取，**不能**替换 Host 代码，单独刷新不算部署成功；
4. HMR 是否真的重载 `gamecenter-host` **必须现场观测记录**，本文不预先断言；观测不到即按 §8 停止。

## 7. 部署后必须实测（DSH-REAL）

1. 13 个 Remote 端点经真实 Gateway 可达（`handshake/pause/saveAck/leaseStatus/modelCatalog/catalogList/catalogInstall/gameBundle/saveLatest/saveCheckpoint/previewList/previewBundle/abandonRuntime`）；
2. iframe：`srcdoc` 与 `blob:` 两条路径分别实测 CSP 阻断外链、`sandbox="allow-scripts"` 阻止同源访问；
3. 关闭 → 重开：真实关闭弹层与真实重载后，“继续游戏”读回同一局（revision/棋盘/时钟/rng）；
4. 孤儿回收：真实客户端崩溃后按实测记录回收时点（**不推导上界**）；
5. 启动确认失败：构造 confirm 失败，界面不得显示“在跑”、不得留 iframe、必须执行 abandon；
6. **扫雷 `CAF59F8D…`（50,313 字节）走受控本地预览**：通过 `previewList`/`previewBundle` 加载，**不走 `catalogInstall`、不伪造审批**；预览槽位固定 `save-preview`，与正式 `save-default` 隔离。

## 8. 停止条件（任一命中，立即停止并回滚 A）

- 备份 TREE32 ≠ `6381300D…`，或 `dist/client.js` SHA256 ≠ `427F79EA…`；
- 部署后 Host 装载抛 `TypeError`（配置缺失/非法）或 Remote 未挂载；
- 13 端点任一不可达；
- 存档读取出现 revision 回退、跨槽位串档、旧凭证可写入；
- iframe 可访问同源或 CSP 未生效。

## 9. 回滚

**回滚 A：恢复部署前现场（推荐，随 D 一并授权）**
- 还原 `lib/` 27 文件整树与 `dist/client.js`、还原 `cordis.yml`（若改过）；
- 重算 TREE32 应回到 `6381300D1A8CB50DC44C642A3B7D99B8`；
- 隔离验收库保留或按需删除（`dataDir` 是独立的验收目录，删除它不影响现有存档）。

**回滚 B：退回阶段0 批准 21 文件基线（需单独授权，不默认执行）**
- 还原阶段0 核心文件，并**删除 6 个 storage 编译文件**（`storage/save-store.{js,d.ts,js.map}`、`storage/sqlite-save-backend.{js,d.ts,js.map}`）；
- 完成后 TREE32 应为 `6700BE82DB9C5CC0CF46545F1E5950D9`；
- 删除后新 Host 失去存档能力，只能在“明确退阶段0”时执行。

**数据库兼容性：未验证，不承诺无损。** 阶段0 代码不含 SQLite 存档模块，阶段1 引入存档表；阶段1 写入的库在阶段0 代码下能否解析**没有实测证据**，只能列为风险，既不断言损坏，也不承诺无损。

## 10. 授权清单（供用户逐项勾选，不默认执行）

| 项 | 内容 | 需否单独授权 |
| --- | --- | --- |
| D1 | 覆盖在线 Host `lib/**`（15 文件）+ Client `dist/client.js`（1 文件） | 是 |
| D2 | 加载方式：**仅**依赖 HMR 重载条目 + 页面刷新；HMR 失败即停止，**不重启整个 DSH** | 是（本次不含重启授权） |
| D3 | 修改在线 `cordis.yml` 下发 `dataDir`/`playerId`（隔离验收命名空间） | 是（**必须**，否则必启动失败） |
| D4 | 备份代码三件 + 新建隔离验收库 | 否（只读复制/新建空库），但须在 D1 之前完成 |
| R1 | 回滚 A：恢复部署前现场 | 随 D1 一并授权 |
| R2 | 回滚 B：退回阶段0 21 文件（**含删除 6 文件**） | 是，且不默认执行 |
| — | git commit / push；付费模型调用 | 本清单不含，另行授权 |

## 11. 未决项（不关闭不得执行）

1. ~~`dataDir`/`playerId` 取值~~ → **已由 PM 指定**：`acceptance-phase1` / `C:\Users\salis\.dsh\gamecenter-acceptance\phase1`（待用户在授权时确认）；
2. ~~SQLite 在线备份 API 待核~~ → 使用**全新隔离库**后**不再阻塞本次验收**，作为后续生产事项保留（若未来要备份现有库仍需 backup API 或停写一致快照）；
3. ~~DB 跨版本兼容性~~ → 隔离库不涉及旧数据，**本次不阻塞**；仍作为后续生产事项；
4. HMR 是否真的重载 `gamecenter-host`——**实测确认前不写进验收结论**，观测不到即停止；
5. DSH-REAL 全部未验（§7）；
6. 本次授权**不含**：git commit / push、付费模型调用、退回阶段0 的删除 6 文件操作、整体重启 DSH。
