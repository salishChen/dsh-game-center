# 扫雷独立验收记录（阶段1 本地候选）

- **验收负责人**：测试与发布负责人
- **验收时间**：2026-10-20
- **目标仓库**：`C:\Users\salis\Desktop\dsh-game-minesweeping`
- **Git 基线**：`main` @ `46018960800f582c3c8a451fd5a428919174a071`（未配置 upstream，未推送远程）
- **验收结论**：**【本地隔离环境验证通过（UNIT/MOCK/BUILD），DSH-REAL 实机挂账未验】**

---

## 1. 产物与文件 SHA256 清单（独立实测核对）

| 文件路径 | 字节大小 | 独立计算 SHA256 | 状态 |
|---|---|---|---|
| `dist/game.js` | 50,313 | `CAF59F8D12E4D868958E729E0914172EF2708A42000B8D60D1110D17732CD3AE` | 最新自包含前端产物 |
| `src/ai.js` | 13,540 | `7AA4AEF222FD8BB219F6BB19C21088F95EA3F008BD51F37C755BD7B8514DC63F` | AI 结构化生成与无猜门禁 |
| `src/engine.js` | 13,687 | `215E10E1F20DA5B6289005D85EF3E07B764E0340725A704FC59D8B740D9740D9` | 确定性引擎与首击无猜重布雷 |
| `src/solver.js` | 10,020 | `EAB400FEC527150E79217ADB2C44D58994A52E893E92FC78930288A536AEF204` | 确定性无猜求解器 |
| `src/ui.js` | 8,516 | `2A33A573EA8B60C8C4075BDEA6E3E55ABC42A55B30ADCC680A2387BDA10CD330` | 交互控制器与失败重试提示 |
| `scripts/build.mjs` | 2,168 | `8DEAC8DE42BE1A22C81DF48BE4EE792AEBEA7426A596E768E5A749035B1917AE` | 打包脚本 |
| `test/solver.test.mjs` | 7,322 | `0E37785FDE546731B66D6BA57CF612A0BEFF84D673AF5675F48296791E8858A9` | 求解器与无猜全链路测试套件 |

- 语法校验：`node --check dist/game.js` 退出码 0。

---

## 2. 证据分栏与测试套件实跑证据（31/31 全部通过，退出码 0）

测试执行命令：`node --test test/*.test.mjs`，耗时 211ms。

### 2.1 原有历史基线测试（18 项，证据分栏：UNIT/MOCK）
- ✔ A8 - 请求结构构造验证
- ✔ A8 - AI 校验拒绝：非法 payload 非对象
- ✔ A8 - AI 校验拒绝：尺寸不符 (DIMENSION_MISMATCH)
- ✔ A8 - AI 校验拒绝：雷数不符 (MINE_COUNT_MISMATCH)
- ✔ A8 - AI 校验拒绝：坐标越界 (OUT_OF_BOUNDS)
- ✔ A8 - AI 校验拒绝：存在重复雷位 (DUPLICATE_MINE)
- ✔ A8 - AI 校验拒绝：首击保护违背 (FIRST_CLICK_VIOLATION)
- ✔ A8 - AI 校验通过：合法棋盘
- ✔ A8 - 本地确定性保底 Fixture 生成与首击安全
- ✔ A8 - 对局获取与失败降级全链路
- ✔ A7 - 确定性规则引擎基础：固定种子可复现雷位与相邻数计算
- ✔ A7 - 首击保护：第一次点击的位置及其结果绝对安全，不会踩雷
- ✔ A7 - 空白扩散（Flood Fill）：翻开 0 相邻雷的空格时自动级联扩散
- ✔ A7 - 胜负判定：踩雷判定失败，翻开所有非雷格子判定胜利
- ✔ A7 - 插旗标记与计数
- ✔ A7 - 虚拟时钟与暂停恢复：暂停时不累积时间，恢复后不跳变
- ✔ Save/Restore - 检查点完整性、单调 revision 与状态恢复
- ✔ Save/Restore - 异常快照防范

### 2.2 本轮新增确定性无猜与鲁棒性测试（13 项，证据分栏：UNIT/MOCK）
- ✔ Solver - 经典 50/50 死猜对局精准拦截 (`DEDUCTION_DEADLOCK`)
- ✔ Solver - 规则 1 单格直推成功解开
- ✔ Solver - 规则 2 双格差集推导 (Subset / 1-1 / 1-2 模式)
- ✔ Solver - 规则 3 全局剩余雷数守恒约束
- ✔ AI Validation - 拒绝自称无猜但无法被证明的对局 (`NOT_NO_GUESS_SOLVABLE`)
- ✔ AI Validation - 接受严格无猜可解对局并带有 `noGuessVerified` 凭据
- ✔ AI Generator - 本地确定性无猜生成器保证求解成功与真实凭据
- ✔ AI Pipeline - 模型自称无猜实为死猜时，严密拦截并降级为本地无猜已验证
- ✔ AI Pipeline - 超出搜索预算时明确拒绝开启猜雷局 (`EXCEEDED_SEARCH_BUDGET`)
- ✔ Coverage - 首击坐标变化多点覆盖（四个角、边缘、中心）且均保证无猜可解
- ✔ Coverage - 多种随机种子下均稳定生成无猜可解对局
- ✔ Engine - 首击移雷与重新校验一致性
- ✔ Engine & Save/Restore - 快照序列化与反序列化还原无猜凭据一致性

---

## 3. 关键缺陷闭环验证事实

1. **彻底关闭猜雷局自动开局**：
   - 早期版本在搜索超时后降级为普通首击安全随机局（`noGuessVerified: false`），违背默认无猜体验。
   - 现版本在 `src/ai.js` 中明确返回 `NO_GUESS_GENERATION_FAILED`，`src/ui.js` 收到后阻断游戏开局并展示 `⚠️ 生成受阻：无法证明无猜，请点击重试`。
2. **首击移雷无猜闭环**：
   - `src/engine.js` 的 `generateDeterministicMines` 接入了 `solveNoGuess`，首击遭遇地雷重新布雷时必须验证无猜方可进入 `playing` 状态，并准确维护 `noGuessVerified` 状态。
3. **求解器信息隔离**：
   - 经审查 `src/solver.js`，求解器严格仅依 `cellState === 1` 的已知格子线索与全局未标记雷数进行逻辑演绎，隐藏底牌完全未参与选安全格或标雷。
4. **死锁命名规范**：
   - 推导死锁统一规范命名为 `DEDUCTION_DEADLOCK`，并在文案中准确表述为“无法证明全盘无猜”，杜绝将多项式规则无法覆盖的局面断言为数学必然死猜。

---

## 4. 真实性挂账与交付边界（纪律约束）

- **DSH-REAL 实机挂账**：上述所有测试均在 Node.js 测试套件与 Mock 环境下执行，尚未在真实 DSH iframe 沙箱、真实 MessagePort 桥接及真实 Gateway 通信下运行；
- **真实模型调用**：严格保持 `AUTH-PENDING` 门禁，未执行真实付费模型调用；
- **状态冻结**：当前扫雷仓库（`dsh-game-minesweeping`）保持本地工作区未提交（不新增 commit）、未推送远程（不执行 git push）。
