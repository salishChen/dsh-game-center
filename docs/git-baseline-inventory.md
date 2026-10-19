# 本地 Git 基线与会话清单（架构与协议负责人维护）

更新时间：2026-10-19 17:45（Asia/Shanghai）。本文件是首次提交前的候选入库/排除清单，供 QA 只读审查。**尚未执行首次提交，也未推送。**

## 1. 结论速览

- 本地仓库已在原位初始化：`<REPO>`（本文件中的 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>` 均为路径占位符，不是可直接执行的路径），分支 `main`，仅一个远端 `origin = https://github.com/salishChen/dsh-game-center.git`（平台仓）。
- **未**把 warehouse 加为任何 remote；未移动/重命名目录；未改 junction；未改在线产物与玩家 profile。
- 当前候选入库 **157 个文件 / ≈1.13 MiB**（含 `.gitattributes`、根 `README.md`、脱敏台账与本清单）；排除集见第 4 节。
- 协议缺陷**已修复**（审批五元组补 `repository`，见第 6 节）：protocol 10/10、client 91/91、host 94/94 全绿，三包 typecheck 退出码 0。
- 行尾已统一：新增 `.gitattributes`（`* text=auto eol=lf`），见第 5.2 节。
- 文档路径脱敏**已完成**：用户目录与安装路径在文档中零残留，台账见 `docs/sanitization-ledger.md`。

## 2. 远端实测（只读）

| 仓库 | 可见性 | 默认分支 | 提交数 | 证据 |
| --- | --- | --- | --- | --- |
| `salishChen/dsh-game-center` | public | `main` | 0（`branches: []`，`size: 0`） | GitHub API + `git ls-remote` 退出码 0、零 ref |
| `salishChen/dsh-game-center-warehouse` | public | `main` | 0（同上） | 同上 |

连通性：`git ls-remote` 经全局 `http.proxy=127.0.0.1:7080` 成功；本机无 `~/.ssh`，全局无 github HTTPS credential helper。当前不做远程写入，凭据不构成本地准备阻塞。

## 3. 本地初始化实测

| 项 | 结果 |
| --- | --- |
| `git init -b main` | 成功，`.git/` 已创建 |
| `git branch --show-current` | `main` |
| `git remote -v` | 仅 `origin`（fetch/push 均指向平台仓），无 warehouse |
| 本地身份 | 未设置任何仓库级 `user.name`/`user.email`；沿用既有全局值（非本项目设置） |
| 暂存区 | 空（`git diff --cached` 零文件），tracked 为 0 |
| 首次提交 | **未执行** |
| 推送 | **未执行** |

## 4. 排除清单与理由

`.gitignore` 已补充以下规则（保留原有 `node_modules/`、`dist/`、`*.tsbuildinfo`、`.DS_Store`）：

| 排除项 | 实际命中 | 体量 | 理由 |
| --- | --- | --- | --- |
| `staging/` | `packages/dsh-gamecenter/staging/**`、`packages/dsh-gamecenter-client/staging/**` | 22 文件 / 184,602 B | 部署候选暂存，非源码；与线上产物一一对应关系不稳定 |
| `staging-rollback/` | Host `lib` 快照 4 组（`lib.bak-host-*`、`lib-*`）+ Client 旧 bundle 5 个 | 89 文件 / 684,970 B | 本机回滚取证材料，含旧版本产物，入库会造成"多份真源" |
| `node_modules/` | pnpm 工作区依赖 | 1,097 文件 / 41,278,395 B | 依赖产物，`pnpm-lock.yaml` 已锁定 |
| `dist/` | `packages/protocol/dist/**`、`packages/dsh-gamecenter-client/dist/client.js` | 31 文件 / 106,681 B | 构建产物；PM 裁定平台 dist 暂不入库，clean clone 后 `pnpm run build` |
| `packages/protocol/src/**/*.js`、`*.js.map`、`*.d.ts` | `packages/protocol/src/` 内 tsc 历史残留 30 个文件 | 50,348 B | 生成物误落在源码目录，与 `dist/` 重复；真实产物在 `packages/protocol/dist/` |
| `*.tsbuildinfo`、`.cache/`、`coverage/`、`tmp/`、`.tmp/`、`*.tmp`、`*.log` | 当前无命中 | 0 | 构建缓存、临时目录、执行日志 |

**明确不排除**（PM 要求审阅后确认，QA 已审）：

| 保留项 | 理由 |
| --- | --- |
| `packages/dsh-gamecenter-client/test/real-host-staging-joint.test.mjs` | 文件名含 staging，但是真实联调测试源码，删除会丢验收覆盖 |
| `packages/dsh-gamecenter/tsconfig.staging.json` | 文件名含 staging，但是构建配置 |
| `tools/cordis-inject-probe/**`（9 文件） | 可复用探针源脚本（DSH 注入/Remote 取证），非输出 |
| 各包 `tools/*.mjs`/`*.ts`（29 文件） | 校验与探针源脚本，可复现 |
| `packages/dsh-gamecenter/lib/**`（21 文件） | 见第 5.1 节判定 |
| `packages/dsh-gamecenter-client/lib/**`（3 文件） | `index.js`/`index.d.ts` 是 Host 半入口；`client.js` 是过渡壳但被 2 个测试显式引用并断言其形态，删了干净克隆会挂测 |
| `packages/dsh-gamecenter-client/src/types/**/*.d.ts`（8 文件） | 手写类型声明，`exports["./client"].types` 指向其中 |

忽略规则复核（`git status --porcelain --ignored -uall` 实测，非 node_modules 部分共 **179 条**，全部落在上表三个目录组）：`packages/dsh-gamecenter` 108、`packages/dsh-gamecenter-client` 11、`packages/protocol` 60。未出现规则之外的意外忽略（例如未被误伤的源码或测试）。

## 5. 关键产物判定

### 5.1 `packages/dsh-gamecenter/lib/**`：**入库**（QA 已接受）

- 时间戳：`lib` 最新 10-19 14:18:56，`src` 最新 10-19 14:18:40 → 与源码同一构建批次，**不陈旧**；
- `package.json` 的 `main`/`exports["."]` 与 `files` 都指向 `lib`，DSH 经 `cordis.patch.yml` 装载时读的就是它；
- `test/build-artifact.test.mjs` 断言 `lib/index.js` 存在并直接 `import()` 它跑服务测试 → 不入库则干净克隆首跑必失败；
- 线上 Host 产物即 `lib/index.js`（`93F30A7B…`），发布形态要求可运行产物随提交。

约束：改动 `src/**` 后必须 `pnpm -C packages/dsh-gamecenter run build` 再提交；建议后续加"lib 与 src 同批"校验（现测试只查存在与无 `.ts` 导入）。

### 5.2 行尾：**已加 `.gitattributes`**

全局 `core.autocrlf=true`，此前 8 个文件含 CRLF。已新增 `.gitattributes`：

```
* text=auto eol=lf
*.png binary … *.zip binary
```

`git check-attr` 实测：`docs/phase0-host.md`、`src/runtime/lease.ts`、`src/index.js`、`.gitattributes` 均为 `text: auto` / `eol: lf`。效果：工作树与仓库统一 LF，避免跨平台检出引发的摘要漂移。

### 5.3 Client `dist/` 维持忽略

`packages/dsh-gamecenter-client/dist/client.js`（56,263 B，线上 427 版本）不入库；由 `pnpm -C packages/dsh-gamecenter-client run build` 生成。

## 6. 协议缺陷：已修复并有测试闭环

**问题（实查，非文档 grep）**：`ApprovedRelease` 与 `matchApproval` 原本只比对 `{gameId, commit, manifestDigest, bundleDigest}` 四项，与基线声明的五元组不符；`contract.test.mjs` 负例只改 `manifestDigest`，漏检 `repository`。

**修复（2026-10-19 17:10 前后）**：

| 文件 | 变更 |
| --- | --- |
| `packages/protocol/src/catalog.ts` | `ApprovedRelease` 新增必填 `repository`；`matchApproval` 增加 `approval.repository === entry.source.repository`；注释明确五元组 |
| `packages/protocol/test/contract.test.mjs` | 正例补 `repository`；负例新增"仅改 repository 必须拒绝"与"审批记录缺 repository 必须拒绝" |
| `docs/phase0-architecture.md` | §3.1 第 4 条改五元组；新增 §3.2 记录修订、兼容性与证据分栏 |

**实测证据（UNIT，非 DSH-REAL）**：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm -C packages/protocol run typecheck` | 0 | tsc 通过 |
| `pnpm -C packages/protocol test` | 0 | 10/10 通过（含新增负例） |
| `pnpm -r --filter=!@dsh-gamecenter/protocol run typecheck` | 0 | client Done、host Done |
| `pnpm -r --filter=!@dsh-gamecenter/protocol run test` | 0 | client 91/91、host 94/94 |

**兼容性**：阶段 0 无任何已发布审批记录，无迁移负担；缺 `repository` 的旧记录一律不匹配（安全侧失败）。

## 7. 待授权 / 待裁定动作

| # | 动作 | 状态 |
| --- | --- | --- |
| 1 | 首次提交（显式清单，`git add -- 路径…`，不用 `git add .`） | 等 QA 复核本轮差异后由 PM 放行 |
| 2 | `.gitattributes`（`* text=auto eol=lf`） | **已完成** |
| 3 | 修复 `matchApproval` 缺 `repository` | **已完成**，UNIT 10/10 |
| 4 | 推送公开仓 | 未授权；需凭据 + 对外发布授权 |
| 5 | docs 本机绝对路径脱敏 | **已完成**（零残留；台账 `docs/sanitization-ledger.md`，含"无脱敏前快照"缺口说明） |
| 6 | clean-clone 构建 README | **已完成**：根 `README.md`（含协议先行、平台 dist 不入库、游戏 dist 规则不同、staging 生成与不作用于已部署链接） |
| 7 | warehouse 仓内容形态 | 见第 8 节，仅建议，不创建 |

## 8. warehouse 仓建议（不创建任何目录/文件）

- **发现层**：GitHub Issues 作为目录条目来源，沿用既有 `gamecenter-json` 机器块契约，不引入第二真源；
- **信任根**：`approvals/<gameId>/<version>.json`，记录五元组 + `approvedBy`/`approvedAt`/`approvalRecordPath`；
- **契约**：`schemas/` 放版本化 JSON Schema（catalog-entry、approval、manifest 引用），与 `packages/protocol/schemas` 同源同步；
- **模板**：`.github/ISSUE_TEMPLATE/` 发布 Issue 模板、`.github/PULL_REQUEST_TEMPLATE.md` 审批 PR 模板（受保护分支 + 人工 review）；
- 明确**不要** `entries/` 目录：Issue 是唯一发现索引，重复一份等于制造第二真源。

## 附录 A：候选入库清单（157 项，首次提交前基线）

见下方逐条列表（路径相对仓库根，按路径排序；文件大小为本清单生成时的快照）。

- `.gitattributes` (271 B)
- `.gitignore` (667 B)
- `docs/gamecenter-design.zh-CN.md` (42702 B)
- `docs/git-baseline-inventory.md`（本清单自身，大小随追加变化）
- `docs/host-deploy-manifest.md` (5213 B)
- `docs/phase0-acceptance.md` (181897 B)
- `docs/phase0-architecture.md` (35729 B)
- `docs/phase0-build-facts.md` (8239 B)
- `docs/phase0-client.md` (56718 B)
- `docs/phase0-execution-log.md` (33621 B)
- `docs/phase0-host.md` (80481 B)
- `docs/root-config-registry.md` (11277 B)
- `docs/sanitization-ledger.md` (4880 B)
- `package.json` (948 B)
- `packages/dsh-gamecenter/cordis.patch.yml` (3032 B)
- `packages/dsh-gamecenter/lib/ai/model-catalog.d.ts` (2843 B)
- `packages/dsh-gamecenter/lib/ai/model-catalog.js` (6254 B)
- `packages/dsh-gamecenter/lib/ai/model-catalog.js.map` (4862 B)
- `packages/dsh-gamecenter/lib/dsh-adapter/context.d.ts` (3788 B)
- `packages/dsh-gamecenter/lib/dsh-adapter/context.js` (1456 B)
- `packages/dsh-gamecenter/lib/dsh-adapter/context.js.map` (665 B)
- `packages/dsh-gamecenter/lib/dsh-adapter/protocol.d.ts` (1394 B)
- `packages/dsh-gamecenter/lib/dsh-adapter/protocol.js` (2451 B)
- `packages/dsh-gamecenter/lib/dsh-adapter/protocol.js.map` (1009 B)
- `packages/dsh-gamecenter/lib/index.d.ts` (3984 B)
- `packages/dsh-gamecenter/lib/index.js` (4819 B)
- `packages/dsh-gamecenter/lib/index.js.map` (1427 B)
- `packages/dsh-gamecenter/lib/remote/contribution-shape.d.ts` (4862 B)
- `packages/dsh-gamecenter/lib/remote/contribution-shape.js` (9351 B)
- `packages/dsh-gamecenter/lib/remote/contribution-shape.js.map` (5152 B)
- `packages/dsh-gamecenter/lib/remote/game-center-service.d.ts` (10071 B)
- `packages/dsh-gamecenter/lib/remote/game-center-service.js` (18748 B)
- `packages/dsh-gamecenter/lib/remote/game-center-service.js.map` (8794 B)
- `packages/dsh-gamecenter/lib/runtime/lease.d.ts` (11454 B)
- `packages/dsh-gamecenter/lib/runtime/lease.js` (15464 B)
- `packages/dsh-gamecenter/lib/runtime/lease.js.map` (9491 B)
- `packages/dsh-gamecenter/package.json` (1086 B)
- `packages/dsh-gamecenter/src/ai/model-catalog.ts` (7456 B)
- `packages/dsh-gamecenter/src/dsh-adapter/context.ts` (4164 B)
- `packages/dsh-gamecenter/src/dsh-adapter/protocol.ts` (2053 B)
- `packages/dsh-gamecenter/src/index.ts` (5106 B)
- `packages/dsh-gamecenter/src/remote/contribution-shape.ts` (10596 B)
- `packages/dsh-gamecenter/src/remote/game-center-service.ts` (17868 B)
- `packages/dsh-gamecenter/src/runtime/lease.ts` (20632 B)
- `packages/dsh-gamecenter/src/types/node-crypto.d.ts` (1068 B)
- `packages/dsh-gamecenter/test/adapter-dispatch.test.mjs` (2954 B)
- `packages/dsh-gamecenter/test/build-artifact.test.mjs` (14093 B)
- `packages/dsh-gamecenter/test/codec-gate.test.mjs` (7639 B)
- `packages/dsh-gamecenter/test/contribution-shape.test.mjs` (6041 B)
- `packages/dsh-gamecenter/test/identity-binding.test.mjs` (10056 B)
- `packages/dsh-gamecenter/test/model-catalog.test.mjs` (3949 B)
- `packages/dsh-gamecenter/test/remote-service.test.mjs` (5512 B)
- `packages/dsh-gamecenter/test/runtime-lease.test.mjs` (6065 B)
- `packages/dsh-gamecenter/test/type-assert.test.mjs` (2207 B)
- `packages/dsh-gamecenter/tools/assert-negative-check.ts` (1308 B)
- `packages/dsh-gamecenter/tools/check-authorization-ready.mjs` (5758 B)
- `packages/dsh-gamecenter/tools/check-lib-deps.mjs` (3269 B)
- `packages/dsh-gamecenter/tools/check-loader-name.mjs` (2427 B)
- `packages/dsh-gamecenter/tools/probe-client-codec.mjs` (1346 B)
- `packages/dsh-gamecenter/tools/probe-client-discovery.mjs` (1768 B)
- `packages/dsh-gamecenter/tools/probe-codec-gate.mjs` (3691 B)
- `packages/dsh-gamecenter/tools/probe-contribution-shape.mjs` (2167 B)
- `packages/dsh-gamecenter/tools/probe-gateway-mount.mjs` (1458 B)
- `packages/dsh-gamecenter/tools/probe-host-assembly.mjs` (5457 B)
- `packages/dsh-gamecenter/tools/probe-loader-disabled.mjs` (2465 B)
- `packages/dsh-gamecenter/tools/probe-profile-boot.mjs` (1592 B)
- `packages/dsh-gamecenter/tools/probe-profile-resolution.mjs` (2068 B)
- `packages/dsh-gamecenter/tools/probe-remotes-client.mjs` (1652 B)
- `packages/dsh-gamecenter/tools/probe-remotes-window.mjs` (1164 B)
- `packages/dsh-gamecenter/tools/probe-typert-generator.mjs` (3485 B)
- `packages/dsh-gamecenter/tools/simulate-profile-link.mjs` (3970 B)
- `packages/dsh-gamecenter/tools/verify-load-prereqs.mjs` (11813 B)
- `packages/dsh-gamecenter/tsconfig.build.json` (366 B)
- `packages/dsh-gamecenter/tsconfig.json` (208 B)
- `packages/dsh-gamecenter/tsconfig.staging.json` (370 B)
- `packages/dsh-gamecenter-client/lib/client.js` (1082 B)
- `packages/dsh-gamecenter-client/lib/index.d.ts` (2020 B)
- `packages/dsh-gamecenter-client/lib/index.js` (1785 B)
- `packages/dsh-gamecenter-client/package.json` (1401 B)
- `packages/dsh-gamecenter-client/src/bridge/diagnostics.js` (14847 B)
- `packages/dsh-gamecenter-client/src/bridge/host-bridge.js` (8771 B)
- `packages/dsh-gamecenter-client/src/bridge/remote-mount.js` (20248 B)
- `packages/dsh-gamecenter-client/src/index.js` (12002 B)
- `packages/dsh-gamecenter-client/src/runtime/lease.js` (8823 B)
- `packages/dsh-gamecenter-client/src/runtime/resources.js` (3155 B)
- `packages/dsh-gamecenter-client/src/types/bridge/diagnostics.d.ts` (2901 B)
- `packages/dsh-gamecenter-client/src/types/bridge/host-bridge.d.ts` (6992 B)
- `packages/dsh-gamecenter-client/src/types/bridge/remote-mount.d.ts` (7437 B)
- `packages/dsh-gamecenter-client/src/types/index.d.ts` (1164 B)
- `packages/dsh-gamecenter-client/src/types/runtime/lease.d.ts` (5834 B)
- `packages/dsh-gamecenter-client/src/types/runtime/resources.d.ts` (1418 B)
- `packages/dsh-gamecenter-client/src/types/ui/focus.d.ts` (786 B)
- `packages/dsh-gamecenter-client/src/types/ui/GameCenterOverlay.d.ts` (1408 B)
- `packages/dsh-gamecenter-client/src/types/ui/RemoteDiagnostics.d.ts` (592 B)
- `packages/dsh-gamecenter-client/src/ui/focus.js` (3685 B)
- `packages/dsh-gamecenter-client/src/ui/GameCenterOverlay.js` (6953 B)
- `packages/dsh-gamecenter-client/src/ui/RemoteDiagnostics.js` (10692 B)
- `packages/dsh-gamecenter-client/test/assembly.test.mjs` (9379 B)
- `packages/dsh-gamecenter-client/test/bridge-constants.test.mjs` (1247 B)
- `packages/dsh-gamecenter-client/test/bundle-shape.test.mjs` (7081 B)
- `packages/dsh-gamecenter-client/test/diagnostics.test.mjs` (12412 B)
- `packages/dsh-gamecenter-client/test/diagnostics-ui.test.mjs` (13777 B)
- `packages/dsh-gamecenter-client/test/discovery-chain.test.mjs` (7243 B)
- `packages/dsh-gamecenter-client/test/fixtures/host-half-types.ts` (1408 B)
- `packages/dsh-gamecenter-client/test/focus.test.mjs` (4878 B)
- `packages/dsh-gamecenter-client/test/host-bridge.test.mjs` (4639 B)
- `packages/dsh-gamecenter-client/test/host-half-types.test.mjs` (7078 B)
- `packages/dsh-gamecenter-client/test/real-host-staging-joint.test.mjs` (9307 B)
- `packages/dsh-gamecenter-client/test/remote-mount.test.mjs` (25663 B)
- `packages/dsh-gamecenter-client/test/runtime-lease.test.mjs` (5465 B)
- `packages/dsh-gamecenter-client/test/wire-contract.test.mjs` (2307 B)
- `packages/dsh-gamecenter-client/tools/asar-grep.mjs` (1461 B)
- `packages/dsh-gamecenter-client/tools/asar-probe.mjs` (2336 B)
- `packages/dsh-gamecenter-client/tools/build-bundle.mjs` (3113 B)
- `packages/dsh-gamecenter-client/tools/build-candidate.mjs` (1374 B)
- `packages/dsh-gamecenter-client/tools/check-bundle-externals.mjs` (868 B)
- `packages/dsh-gamecenter-client/tools/check-dependency-cycle.mjs` (4417 B)
- `packages/dsh-gamecenter-client/tools/check-esbuild.mjs` (275 B)
- `packages/dsh-gamecenter-client/tools/check-wire-contract.mjs` (7298 B)
- `packages/dsh-gamecenter-client/tools/probe-loader-resolution.mjs` (5300 B)
- `packages/dsh-gamecenter-client/tools/probe-remote-shape.mjs` (4745 B)
- `packages/dsh-gamecenter-client/tools/probe-remote-store.mjs` (4102 B)
- `packages/dsh-gamecenter-client/tools/probe-skill-entry.mjs` (3834 B)
- `packages/dsh-gamecenter-client/tools/probe-typert-rules.mjs` (3291 B)
- `packages/dsh-gamecenter-client/tools/probe-ui-entries.mjs` (3261 B)
- `packages/dsh-gamecenter-client/tsconfig.json` (728 B)
- `packages/protocol/package.json` (876 B)
- `packages/protocol/schemas/bridge-envelope.v1.json` (769 B)
- `packages/protocol/schemas/catalog-entry.v1.json` (1653 B)
- `packages/protocol/schemas/manifest.v1.json` (3453 B)
- `packages/protocol/schemas/save.v1.json` (2107 B)
- `packages/protocol/src/bridge.ts` (3316 B)
- `packages/protocol/src/capabilities.ts` (3557 B)
- `packages/protocol/src/catalog.ts` (4008 B)
- `packages/protocol/src/dshVersions.ts` (2343 B)
- `packages/protocol/src/errors.ts` (3158 B)
- `packages/protocol/src/index.ts` (2207 B)
- `packages/protocol/src/json.ts` (352 B)
- `packages/protocol/src/manifest.ts` (2051 B)
- `packages/protocol/src/save.ts` (5026 B)
- `packages/protocol/src/version.ts` (3747 B)
- `packages/protocol/test/contract.test.mjs` (7035 B)
- `packages/protocol/tsconfig.build.json` (288 B)
- `packages/protocol/tsconfig.json` (191 B)
- `pnpm-lock.yaml` (11480 B)
- `pnpm-workspace.yaml` (27 B)
- `README.md` (5541 B)
- `tools/cordis-inject-probe/extract-cordis.mjs` (3094 B)
- `tools/cordis-inject-probe/extract-typert.mjs` (2549 B)
- `tools/cordis-inject-probe/gateway-dispatch.mjs` (9730 B)
- `tools/cordis-inject-probe/README.md` (5079 B)
- `tools/cordis-inject-probe/repro-inject-guard.mjs` (4790 B)
- `tools/cordis-inject-probe/repro-remote-claims.mjs` (6502 B)
- `tools/cordis-inject-probe/tsconfig.probe.json` (291 B)
- `tools/cordis-inject-probe/typecheck-probe.ts` (1464 B)
- `tools/cordis-inject-probe/verify-browser-cordis.mjs` (3781 B)
- `tsconfig.base.json` (566 B)
