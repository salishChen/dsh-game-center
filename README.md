# DSH 游戏中心（dsh-game-center）

DSH（DeepSeek Harness）内的小游戏平台：以 GitHub Issue 为游戏目录、以独立 Git 仓库分发游戏，由游戏中心统一提供模型、存档与生命周期服务。

## 当前状态（务必先读）

**阶段 0：无付费核心 Remote 闭环已通过实机验证；完整门禁尚未收尾，阶段 0 未整体通过，不进入阶段 1 开发。**

| 维度 | 现状 |
| --- | --- |
| Remote 挂载 / 握手 / 租约 / 暂停 / 旧代次拒写 / 保存确认 | `DSH-REAL` 实机通过（7 项诊断，代次 3→4 两次观测） |
| 模型目录枚举（12 个模型） | `DSH-REAL` 通过（只读，零付费） |
| 一次真实模型调用 | **`AUTH-PENDING`**：未获付费授权，从未执行 |
| 流式与在途取消、租约过期清理、关闭触发停收 | `UNIT`/`STATIC` 覆盖，**实机缺口，如实挂账** |
| 多弹层共存、Escape 焦点返回 | `UNIT` 覆盖，**实机未验证** |

证据分栏一律为 `STATIC` / `UNIT` / `MOCK` / `BUILD` / `DSH-REAL`，不得把前者写成后者。详细验收记录见 `docs/phase0-acceptance.md`。

## 平台范围

- **仅 GitHub**：初期目录、游戏下载与发布工具都按 GitHub 实现；Gitee 适配**延后**，不是初期门禁。
- 游戏身份使用稳定 `gameId`；安装判定使用审批五元组 `{gameId, repository, commit, manifestDigest, bundleDigest}`。
- 本仓库是**平台代码仓**；游戏目录与上架审批在独立仓库 `dsh-game-center-warehouse`，不共用本工作树的 remote。

## 环境要求

- Node.js **24.x**（`engines` 写 `>=24.0.0 <25`）
  - 依据：`node:sqlite` 是 Host 存档后端的实际依赖；本项目只在 **Node 24.19.0（开发机）** 与 **Node 24.21.0（DSH 宿主）** 上实测通过。
  - `node:sqlite` 虽在更早版本引入，但未验证那些版本是否需要实验性 flag，因此**不承诺** 24 以下的兼容范围；需支持更低版本时须单独实测并补证据。
- pnpm 11.21.0（`packageManager` 字段已锁定）

## 从干净克隆构建与测试

```bash
# 1) 安装依赖。本项目统一禁用安装脚本，不要省略 --ignore-scripts
pnpm install --ignore-scripts

# 2) 构建：protocol 必须先构建，下游依赖它的 dist
pnpm run build

# 3) 类型检查与单元测试
pnpm run typecheck
pnpm run test
```

要点：

1. **protocol 先行**：`packages/protocol` 产出 `dist/`（ESM + `.d.ts`）。下游 `host`/`client` 的 `exports` 指向该 dist，未构建会直接编译失败。根脚本已按「protocol 先、其余后」串行编排，直接 `pnpm run build` 即可。
2. **平台 `dist/` 不入库**：`packages/protocol/dist/`、`packages/dsh-gamecenter-client/dist/client.js` 均由构建生成，`.gitignore` 忽略。干净克隆后必须构建，不能指望仓库里已有产物。
3. **游戏仓库的 dist 规则不同**：游戏仓库按设计要求**提交可运行的 `dist/`**，玩家安装不执行 `npm install`/postinstall/任意构建脚本。不要把「平台 dist 不入库」这条套到游戏仓库。
4. **Host `lib/` 入库**：`packages/dsh-gamecenter/lib/**` 是 Host 插件的装配入口（`main`/`exports`/DSH `cordis.patch.yml` 都指向它），因此随源码提交。**改动 `src/**` 后必须先 `pnpm -C packages/dsh-gamecenter run build` 再提交**，否则 lib 与 src 漂移。

## staging 与回滚目录

- `packages/dsh-gamecenter/staging/` 与 `packages/dsh-gamecenter-client/staging/` 是**部署候选暂存**，`*-rollback/` 是**回滚取证快照**，全部被 `.gitignore` 忽略，**不提交**。
- 干净克隆后它们不存在，需要时现场生成：

```bash
# Host staging 产物（GameCenterCore 等）
pnpm -C packages/dsh-gamecenter exec tsc -p tsconfig.staging.json

# Client staging 候选（生成 staging/client.js，不触碰 dist/client.js）
pnpm -C packages/dsh-gamecenter-client run build:candidate
```

- `packages/dsh-gamecenter-client/test/real-host-staging-joint.test.mjs` 依赖 Host staging 产物。**干净克隆后若未生成 staging，该测试会因找不到文件而失败**——这是预期，不是回归；先执行上面的 Host staging 命令再跑测试。

## 部署安全（重要）

- 不要把 `build` 直接作用于**已被线上服务链接的目录**：`packages/dsh-gamecenter-client/dist/client.js` 与 `packages/dsh-gamecenter/lib/**` 可能正被运行中的 DSH 装载或由 junction 指向。
- 正确做法：先构建到 `staging/`，核对摘要，再由部署执行人在**用户授权**下覆盖，并保留可回滚快照。
- 本项目不改运行中的 DSH 安装目录、不写玩家 profile、不重启 GUI；`profile` 下的 junction 属部署步骤，须单独授权。

## 目录结构

```
packages/protocol/             协议、JSON Schema、错误码、能力与目录契约（零运行时依赖）
packages/dsh-gamecenter/       Host 插件：Typert Remote 服务、运行代次与租约、模型目录只读投影
packages/dsh-gamecenter-client/Client 插件：入口弹层、诊断、专用 MessagePort Bridge、隔离 iframe 运行时
tools/cordis-inject-probe/     只读探针：用本机 DSH 真实 Cordis 复现注入/Remote 行为
docs/                          设计基线、架构决策、阶段 0 验收与部署清单
```

## 文档入口

- 设计基线：`docs/gamecenter-design.zh-CN.md`
- 架构与协议决策：`docs/phase0-architecture.md`
- 阶段 0 验收：`docs/phase0-acceptance.md`
- 根配置登记：`docs/root-config-registry.md`
- 入库/排除清单：`docs/git-baseline-inventory.md`

## 脱敏约定

文档中的 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>`、`<NODE_BIN>` 是**路径占位符，不是可直接执行的路径**。历史证据中的摘要值取自脱敏前的原始样本，未按替换后的文本重算；比对摘要时请以原始部署材料为准。
