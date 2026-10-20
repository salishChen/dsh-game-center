# 阶段1 计划：GitHub 目录 → 固定提交安装 → 扫雷 → 存档/关闭恢复

建立时间：2026-10-19。负责人：架构与协议负责人（协议/集成协调）。
唯一设计基线：`docs/gamecenter-design.zh-CN.md`（§4 双仓库与发布流程、§11 实施顺序、§8 关闭即暂停）。
上游基线：`main` = `3b0fb962f24d1e6bc7fa9e8c21b057385070697f`（阶段0 核心闭环基线，**非**完整验收通过）。

## 0. 开工前状态（实测）

| 项 | 值 |
| --- | --- |
| 本地 `HEAD` | `3b0fb962f24d1e6bc7fa9e8c21b057385070697f` |
| `origin/main` | 同上（与 HEAD 同 SHA） |
| 工作树 | CLEAN，1 个提交，无 tag，仅 `origin` 一个远端 |
| 阶段0 完整门禁 | **未闭环**，遗留项见第 6 节，继续挂账 |

## 1. 阶段1 范围（只做这五步）

按设计 §11 阶段1「跑通完整玩法」与用户 2026-10-19 的范围裁决：

1. **GitHub 目录与审批**：从 Issue 机器块解析条目，校验审批五元组 `{gameId, repository, commit, manifestDigest, bundleDigest}`；不匹配不可安装。仅 GitHub，Gitee 不做。
2. **固定提交安全安装**：按完整 commit 取产物，校验 manifest/bundle 摘要、路径逃逸、体积与文件清单；安装到按提交隔离的目录，不覆盖旧版本，不执行仓库脚本。
3. **扫雷首个玩法**：确定性规则引擎负责翻格/标记/相邻雷数/胜负；AI **仅生成对局**（棋盘+雷位），生成结果必须通过格式、雷数、首击保护校验；真实模型调用**不在**本阶段（用 fixture 生成器，`MOCK`）。
4. **checkpoint 持久化**：Host 侧事务写入存档（`GameSaveV1`），revision 单调，旧代次拒绝。
5. **关闭恢复同进度**：关闭弹层 → 保存确认 → 销毁实例；重开后从同一提交 + 检查点恢复，倒计时/棋盘/随机序列不跳变。

**明确不做**：鲸鲸币、麻将/斗地主/对对碰完整玩法、媒体（生图/音视频）、Gitee 适配、真实付费模型调用、在线部署与刷新重启、把游戏代码混入平台仓或目录仓。

## 2. 文件所有权（互不交叉，动手前 owner 先确认）

| 归属 | 目录/文件 | 阶段1 交付 |
| --- | --- | --- |
| 架构与协议负责人 | `packages/protocol/**`、根 `package.json`/`pnpm-workspace.yaml`/`tsconfig.base.json`、`docs/phase1-plan.md`、`docs/phase0-architecture.md` | Issue 机器块解析器、审批记录 schema、安装计划类型、协议版本与兼容说明 |
| 目录与安装工程师 | `packages/dsh-gamecenter-catalog/**`（**新建包**，临时专属） | GitHub Issues 目录同步、条目缓存、审批比对、固定提交下载/校验/隔离安装 |
| DSH Host工程师 | `packages/dsh-gamecenter/src/storage/**`、`src/runtime/**`（新增子目录） | 存档事务与 revision、运行代次/租约接线、checkpoint 读写 |
| 界面与运行时工程师 | `packages/dsh-gamecenter-client/src/sdk/**`、`src/bridge/**`（新增子目录）、`src/ui/**` | 游戏 SDK v1、Bridge 白名单方法（save/checkpoint/lifecycle）、弹层接线 |
| 游戏开发者 | 独立仓 `dsh-game-minesweeping`（**不在本仓库**） | 扫雷玩法、`gamecenter.json`、可运行 `dist/`、pause/serialize/restore |
| 测试与发布负责人 | `docs/phase1-acceptance.md`、`packages/*/test/**`（新增用例文件） | 独立验收矩阵、端到端关闭/恢复实测（`DSH-REAL` 需单独授权部署） |
| 游戏目录维护者 | 目录仓 `dsh-game-center-warehouse`（本阶段**只出结构建议**，不建内容） | Issue 模板与审批记录的字段约定评审 |

规则：**同一文件只允许一个 owner 编辑**；跨包修改必须先在对应用 owner 处确认，不许直接改别人目录。新增包由 owner 自建 `package.json`，根 `pnpm-workspace.yaml` 已是 `packages/*`，无需我改根配置。

## 3. 集成顺序（后一步依赖前一步的产物）

| 步 | 内容 | 依赖 | 出口条件 |
| --- | --- | --- | --- |
| P0 | 协议契约：Issue 机器块解析、审批记录 schema、安装计划类型 | 无 | protocol 单测全绿、`tsc` exit 0 |
| P1 | 目录同步 + 审批比对（纯函数先行，网络后置） | P0 | 用固定 JSON fixture 完成条目→审批→可安装判定，`UNIT` |
| P2 | 固定提交下载 + 摘要/路径校验 + 隔离安装 | P0、P1 | 恶意样本（错摘要、路径逃逸、超限）全部拒绝，`UNIT`/`MOCK` |
| P3 | Host 存档事务 + runtime 接线 | P0 | 写入/回滚/旧代次拒绝，`UNIT`，DSH 内 `DSH-REAL` 另授权 |
| P4 | Client SDK v1 + Bridge 方法 | P0、P3 | 白名单方法往返、暂停后拒写，`UNIT`/`MOCK` |
| P5 | 扫雷玩法（独立仓）| P4 | 棋盘校验 + 规则引擎胜负判定，`UNIT`；AI 生成用 fixture，`MOCK` |
| P6 | 端到端：安装→开局→关闭→恢复同进度 | P1–P5 | QA 独立执行；实机部分需部署授权，未授权前只到 `MOCK`/`UNIT` |

并行约束：P1 与 P3 可在 P0 后并行；P4 必须等 P3 的存档字段冻结；P5 必须等 P4 的 SDK 表面冻结。

## 4. 契约要点（阶段1 冻结）

1. **解析**：只读一个 `gamecenter-json` 机器块；重复块、重复 key、超限正文、未知主版本一律拒绝（`PROTOCOL_INVALID`）。
2. **信任根**：审批五元组逐字段相等才可安装；Issue 标题/描述/ref 不参与判定。
3. **安装路径**：`<游戏库>/<gameId>/<commit>/`，路径段白名单，拒绝 `..`、绝对路径、盘符、符号链接逃逸。
4. **不执行仓库脚本**：不跑 `npm install`/postinstall/构建；只取签名清单内的文件。
5. **存档**：`GameSaveV1` 的 `revision` 单调，`installedCommit` 固定；恢复只认同一 `installedCommit`，否则显式迁移或拒绝（`SAVE_INCOMPATIBLE`）。
6. **关闭**：单一 `requestPause()` 收敛，暂停后 Bridge 返回 `PAUSED`，旧代次 `STALE_RUNTIME`。
7. **SDK 边界**：游戏只拿白名单能力，无凭据、无通用 RPC、无 DSH 主工具权限。

## 5. 验收（分栏，逐项可执行）

| # | 验收项 | 分栏 | 判据 |
| --- | --- | --- | --- |
| A1 | Issue 机器块解析（单块/重复块/超限/未知版本） | `UNIT` | 每类样本有断言，失败码明确 |
| A2 | 审批五元组比对（改 repository/commit/摘要均拒绝） | `UNIT` | 负例覆盖五个字段 |
| A3 | 固定提交安装（摘要、路径逃逸、超限、清单外文件） | `UNIT`/`MOCK` | 恶意样本全部拒绝 |
| A4 | 隔离安装不覆盖旧版本 | `UNIT` | 同 gameId 两个 commit 并存 |
| A5 | 存档事务与旧代次拒写 | `UNIT` | 并发写与迟到写被拒 |
| A6 | 关闭→保存→销毁→重开恢复 | `MOCK`（未授权部署前）/`DSH-REAL`（授权后） | 倒计时与棋盘一致 |
| A7 | 扫雷规则引擎（首击保护、胜负、雷数） | `UNIT` | 固定种子可复现 |
| A8 | AI 生成棋盘校验（格式/雷数/首击） | `MOCK`（fixture） | 非法棋盘被拒 |
| A9 | 游戏越权（跨存档/无凭据/通用 RPC） | `UNIT` | Bridge 拒绝并记错误码 |

## 6. 阶段0 遗留（**待验，不涂绿**）

| 项 | 现状 | 阶段1 处理 |
| --- | --- | --- |
| 一次真实模型调用 | `AUTH-PENDING` | 仍需用户单独付费授权；本阶段用 fixture |
| 流式与在途取消 | `UNIT`/`STATIC` | 不因阶段1 推进而记通过 |
| 租约过期清理 | `UNIT` | P3 接线后再评估 |
| 关闭触发停收 | 缺真实探针 | A6 实机项，需部署授权 |
| 多弹层共存、Escape 焦点 | `UNIT` | 实机未验证 |

## 7. 纪律

- 不 push、不打 tag、不使用已泄露的 Git 凭据（该 token 需用户吊销）；
- 不改在线 `lib/`/`dist/`、不改 profile 与 junction、不部署/刷新/重启 DSH；
- 产物只落 `staging/`，`staging*` 与提取物已被 `.gitignore` 排除；
- 本阶段不零碎 commit；完成独立验收后**一次**阶段1 提交；
- 证据分栏 `STATIC`/`UNIT`/`MOCK`/`BUILD`/`DSH-REAL`，计划不等于实机通过。
