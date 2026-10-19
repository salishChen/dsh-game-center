# 文档路径脱敏台账（2026-10-19）

授权：项目经理裁决方案 A，并明确跨文档所有权授权由架构与协议负责人集中处理本轮替换，QA 复核 diff。
范围：**仅文档机械模板化**。未改源码、未改在线 `lib`/`dist`、未改玩家 profile、未动 junction、未提交、未推送。

## 1. 替换规则（最长前缀优先）

| 原样本模式（脱敏前） | 占位符 |
| --- | --- |
| `<驱动器>:\Users\<用户名>\Desktop\<仓库目录名>`（含 `...\...` 简写场景） | `<REPO>` |
| `<驱动器>:\Users\<用户名>\.dsh\profiles\<profile名>` | `<PROFILE_DIR>` |
| `<驱动器>:\Users\<用户名>\.dsh`、`...\AppData\...`、`...\.dsh\electron\...`、`...\.dsh\bot\workspace` | `<USER_HOME>\...` |
| `<驱动器>:\Program Files\<DSH 安装目录>`（正、反斜杠两种写法） | `<DSH_INSTALL>` |
| `<驱动器>:\code\DevEnvironment\nodejs` | `<NODE_BIN>` |

说明：本表只写模式，**不写真实用户名、盘符与安装目录名**，避免台账本身成为新的泄露源。

约定：占位符**不是可直接执行的路径**；文中所有摘要（SHA256、整树摘要、BIND 摘要）仍取自脱敏前的原始样本，**未按替换后文本重算**，比对以原始部署材料为准。

## 2. 逐文件结果（替换后占位符计数，含新增的说明行）

| 文件 | 所有者 | `<REPO>` | `<PROFILE_DIR>` | `<USER_HOME>` | `<DSH_INSTALL>` | `<NODE_BIN>` |
| --- | --- | --- | --- | --- | --- | --- |
| `docs/phase0-acceptance.md` | 测试与发布负责人 | 2 | 9 | 2 | 2 | 2 |
| `docs/phase0-execution-log.md` | DSH Host工程师 | 5 | 8 | 1 | 4 | 0 |
| `docs/phase0-host.md` | DSH Host工程师 | 4 | 5 | 1 | 2 | 0 |
| `docs/phase0-client.md` | 界面与运行时工程师 | 1 | 5 | 1 | 1 | 0 |
| `docs/phase0-architecture.md` | 架构与协议负责人 | 4 | 3 | 3 | 1 | 1 |
| `docs/phase0-build-facts.md` | 架构与协议负责人 | 0 | 0 | 0 | 2 | 0 |
| `docs/host-deploy-manifest.md` | 架构与协议负责人 | 1 | 2 | 1 | 1 | 0 |
| `docs/git-baseline-inventory.md` | 架构与协议负责人 | 2 | 1 | 1 | 1 | 0 |
| `tools/cordis-inject-probe/README.md` | 架构与协议负责人 | 0 | 0 | 0 | 1 | 0 |
| `README.md`（新增） | 架构与协议负责人 | 1 | 1 | 1 | 1 | 1 |

说明：上表计数包含各文件顶部新增的「脱敏约定」说明行本身出现的占位符（每份文档 1 组），因此不等于被替换的原样本处数。

## 3. 脱敏前原样本统计（替换前实测，供 QA 对账）

- 本机用户目录绝对路径：**39 处**，分布为 `phase0-execution-log.md` 11、`phase0-acceptance.md` 10、`phase0-host.md` 6、`phase0-architecture.md` 6、`phase0-client.md` 4、`host-deploy-manifest.md` 1、`git-baseline-inventory.md` 1；
- 正斜杠写法（`phase0-architecture.md`）：1 处；
- DSH 安装路径及其 `D:/` 变体：`phase0-execution-log.md` 3、`phase0-acceptance.md` 1、`phase0-host.md` 1、`tools/cordis-inject-probe/README.md` 1、`phase0-build-facts.md` 1（另含安装目录路径片段 3 处，随行一并替换）；
- 工具链路径（node 可执行文件所在目录）：`phase0-acceptance.md` 1 处；
- **代码、配置、Schema、测试中 0 命中**（`*.ts/*.js/*.mjs/*.json/*.yml` 全量扫描）。

## 4. 过程偏差与补救（如实记录）

替换采用逐处 `read` + `edit`，**未保存替换前的文件副本**。原始字节仍在下列位置可取：

1. **Git 历史**：本次未提交，暂无历史副本；
2. **本机回滚快照**：仅覆盖部署产物（`staging-rollback/`），**不含 docs**；
3. **可重建**：替换是纯文本映射，按第 1 节规则可逆向还原（`<REPO>` → 原路径），但**原始摘要值不可由逆向文本重算**。

结论：本轮**没有独立的脱敏前 MD 快照**，只有可逆向的映射规则。若 QA 要求字节级 diff，必须先由各文档所有者提供替换前副本，或接受「按映射规则逆向 + 复核计数」的对账方式。此项列为本次交付的已知缺口，不掩饰。

## 5. 复核清单（供 QA 只读执行）

```bash
# 1) 确认无残留本机绝对路径（应为 0）
grep -rn --include=*.md -E 'C:[\\/]Users|D:[\\/]Program Files|D:[\\/]code' . --exclude-dir=node_modules

# 2) 确认占位符存在且已加说明
grep -rln --include=*.md '<REPO>\|<PROFILE_DIR>\|<USER_HOME>\|<DSH_INSTALL>' . --exclude-dir=node_modules

# 3) 确认摘要未被重算：抽查任一摘要值仍在原文本位置
grep -n '4AA2223B' docs/*.md

# 4) 确认代码未被触碰
pnpm run typecheck && pnpm run test
```

## 6. 未做（明确边界）

- 未提交、未推送、未改 remote；
- 未改任何源码、Schema、测试、`lib/`、`dist/`、profile、junction；
- 未对摘要值重新计算，也未调整任何证据分栏结论；
- 未创建 warehouse 仓内容。
