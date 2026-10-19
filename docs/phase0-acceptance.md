# 阶段0 独立验收矩阵（测试与发布负责人）

状态：**无付费核心 Remote 闭环实测通过 / 完整门禁收敛中**。已于 2026-10-19 16:45 取得 DSH-REAL 无付费 7 项核心诊断全绿实测证据；按 PM 严谨口径，严格剔除未实机取证项并明确分栏映射，剩余项列入清单挂账。本文只记录可复现证据；无证据不报通过。
设计基线：`docs/gamecenter-design.zh-CN.md`（2026-10-18，已全文读取 484 行）。
建立时间：2026-10-18。

> 脱敏约定（2026-10-19）：文中 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>`、`<NODE_BIN>` 为路径占位符，**不是可直接执行的路径**。所有摘要值（SHA256、整树摘要等）均取自脱敏前的原始样本，未按替换后的文本重算，比对时以原始部署材料为准。

## 0. 证据分栏约定（强制）

每个用例必须在下列**唯一一栏**打勾，不得混填：

| 分栏 | 含义 | 可否计入阶段0通过 |
| --- | --- | --- |
| `STATIC` | 读源码/读类型/读配置得到的结论 | 否，仅作设计依据 |
| `UNIT` | 进程内单元测试，无 DSH 参与 | 否，仅作逻辑回归 |
| `MOCK` | 用 mock Host/Client 模拟契约 | 否，不得称为 DSH 集成 |
| `BUILD` | 编译/打包成功（tsc、bundle） | 否，不得称为运行通过 |
| `DSH-REAL` | 在真实安装 DSH 中实际观察到行为并留存证据 | 是 |
| `AUTH-PENDING` | 需要用户授权（付费调用/远程写入/发布）后才能执行 | 否，挂账 |

## 1. 环境核查结果（已执行）

### 1.1 shell 可用性（已恢复）

| 时点 | 命令 | 结果 |
| --- | --- | --- |
| T1（早期） | `pwsh -Command "Get-Location"` ×2 | 退出码 `3221225794` = `0xC0000142`（STATUS_DLL_INIT_FAILED），无输出 |
| T2（文件策略切到 danger-full-access 后） | `pwsh` 读当前目录 + `node --version` | **成功**：`<USER_HOME>\.dsh\bot\workspace`；`node v24.19.0` |

结论：shell 早期确实不可用，现已恢复，`UNIT`/`BUILD` 分栏具备产出条件。
注意版本差异：本会话 `node v24.19.0`，而运行时清单 `runtime.json` 记录 `node 24.21.0`、`pnpm 11.28.5`。
构建时须记录**实际使用**的 node/pnpm 版本，不能引用清单值当作已执行证据。
后续不得重复尝试已失败的 T1 命令形态；shell 可用性以本表 T2 为准。

### 1.2 DSH 已安装版本

来源：`<DSH_INSTALL>\resources\app.asar\package.json`

| 字段 | 值 |
| --- | --- |
| name | `@deepseek-ai/dsh-desktop`（Electron shell：bundled dsh runtime + external plugins） |
| version | `0.2.1-rc.2` |
| dshBuildCommit | `332895e0f7c9d4dbfb29729f5eb367fa263ff986` |
| dshBuildDirty | `false` |
| dshDesktopUpdateChannel | `nightly` |
| 运行中进程 | `DeepSeek Harness.exe` pid 23864，窗口 `游戏中心｜项目统筹`，1296x828 |
| 界面入口 | Web GUI `http://127.0.0.1:3080` |

**版本口径说明（已按项目经理裁定修正）：**
基线中的 `687f282e8625c6b8d11ff58211a90524be2e4317` 是设计调研的**参考提交**，不是必须匹配的目标版本。
本轮待验证目标统一为 `0.2.1-rc.2 / 332895e0…`。
`nightly` 是**更新通道**标签，不代表当前已安装内容会自行变化；但 nightly 通道**不构成兼容承诺**，
因此全部 `DSH-REAL` 证据只声明「对 0.2.1-rc.2 / 332895e0 有效」，不声明对其他版本有效。

### 1.3 asar 归档可读性（逐路径实测记录）

先前报告曾写「文件工具无法穿透 asar」，该结论**过于绝对，现予以修正**。逐路径实测如下：

| 路径 | 操作 | 结果 |
| --- | --- | --- |
| `app.asar\package.json` | `read` | **成功**，27 行，取得 desktop 版本与 buildCommit |
| `app.asar\dsh\package.json` | `read` | **成功**，312 行，取得 runtime 包名 `@deepseek-ai/dsh-desktop-runtime`、version `0.2.1-rc.2`、全部 `@deepseek-ai/*` 依赖清单（cordis 4.0.5、typert、llm、api-remotes、client-modules 等） |
| `app.asar\dsh\` | `glob` | **失败**，`os error 3` 系统找不到指定路径 |
| `app.asar\dsh\` | `grep` | **失败**，同上 |
| `app.asar.unpacked\dsh\` | `glob` | 成功但仅有原生模块（fflate、libreoffice-kit、koffi、swc helpers），无 dsh 主包 |

修正后的准确结论：
- `read` **可以**按具体文件路径穿透 asar 归档；`glob`/`grep` **不能**按目录遍历归档内部。
- 因此取得源码证据的路径是「**已知精确文件路径 → read**」，而不是「必须解包后才能读」。
- `npx asar extract` 不是唯一途径，仅在大范围检索/遍历时才需要，且应解包到**临时目录**、不修改安装目录。
- 由此可得的依赖清单已足以支撑契约调研（`dsh-api-remotes`、`dsh-typert-*`、`dsh-client-modules` 确存在且版本一致），
  但**依赖存在 ≠ 装配入口可用**，A0-2/A0-3 仍须真实加载验证。

→ Host/Client 工程师声称"基于源码证据"时，应附**具体文件路径 + 行号**，便于我复核。
→ 源码可读性与 shell 可执行性是两项独立问题，分别取证，不得互相代偿。

**工具差异补充（实测，重要）：** 同一个 asar 内部路径，`read` 成功而 shell 的 `Test-Path` 返回 `False`。

| 路径（asar 内） | `read` | `Test-Path`(pwsh) |
| --- | --- | --- |
| `app.asar\dsh\package.json` | 成功 312 行 | — |
| `app.asar\dsh\node_modules\@deepseek-ai\dsh-llm\package.json` | **成功 76 行** | **False** |
| `…\dsh-api-remotes\package.json` | 未测 | False |
| `…\dsh-client-modules\package.json` | 未测 | False |

含义：asar 内部文件必须用 **read 工具按精确路径**读取；**不能**用 shell 的 Test-Path/Get-Content/node fs 去判断存在性或读取，
那些调用得到的 False/ENOENT **不代表文件不存在**，容易误判"源码缺失"。这是取证方法的硬约束，已记录以免团队二次踩坑。

已取得的 `dsh-llm` 契约证据（可用于 A0-6 口径校准）：
`exports` 明确提供 `./typert`（Host 侧）与 `./remote`（Client 侧 typert remote-client），
peerDependency `@deepseek-ai/cordis ~4.0.5`，依赖含 `dsh-typert-protocol`。
→ 这**支持**「LLM 服务有 Host/Remote 双端导出」的判断，但**仍不能**证明第三方插件可装配，A0-4 须实测。

### 1.4 账号与凭据现状

- 团队记忆：仅项目经理可用 `gpt-6.1-sol`，其他角色及子代理只用非 GPT 模型。本会话照此执行。
- 真实模型调用可能计费：本会话**不调用**，相关用例标 `AUTH-PENDING`。

## 2. 阶段0 验收矩阵（7 项，对应项目经理派工）

判定口径：一项须 `DSH-REAL` 证据齐全才算通过。当前全部 **未验证（BLOCKED）**。

| ID | 验收目标 | 判定方法（可复现） | 分栏 | 现状 |
| --- | --- | --- | --- | --- |
| A0-1 | 锁定 DSH 版本 | 记录 version+buildCommit+dirty；声明兼容承诺范围 | STATIC | **已完成**：desktop `0.2.1-rc.2` / `332895e0…` / dirty=false；runtime `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.2`；node v24.19.0（实测）。承诺范围＝仅此版本 |
| A0-2 | Host 加载 | 插件放入 DSH 插件目录 → 重启 → Host 侧出现注册日志/服务；卸载后消失 | DSH-REAL | **待执行**：shell 已恢复，阻塞转为「插件目录约定与入口字段须有源码依据」 |
| A0-3 | Client 显式装配 | 仅在有显式 contribution 装配时 UI 出现入口；不写装配则**不出现**（负例必须验证） | DSH-REAL | **BLOCKED** |
| A0-4 | Remote 往返 | Client 调 Host 类型化方法返回一致结果；流式方法收到增量；取消使 Host 侧停止并回 `ABORTED` | DSH-REAL | **BLOCKED** |
| A0-5 | 弹层不覆盖既有 overlay | 打开游戏中心弹层时，其他插件 `shell.overlay` 内容仍可见/未被替换；Escape 关闭后焦点回原处 | DSH-REAL | **BLOCKED**：需先枚举当前占用 `shell.overlay` 的插件，否则无法证明"未覆盖" |
| A0-6 | 模型目录脱敏 | 目录含 provider/model/能力声明；**不含** apiKey/baseURL/token/account（字段级断言） | DSH-REAL | **BLOCKED** |
| A0-7 | 关闭后拒绝请求 / 取消语义 | 关闭后同实例新请求返回 `PAUSED` 或拒绝；租约失效后 Host 不受理；在途请求被 best-effort 取消 | DSH-REAL | **BLOCKED** |

### 2.1 必测负例（防止"看起来通过"）

1. **A0-3 负例**：不配置 contribution，入口必须**不出现**。若出现，说明是隐式全量装配，契约理解错误。
2. **A0-5 负例**：让另一插件占据 `shell.overlay`，游戏中心打开后该内容若消失 → 判定**失败**（覆盖他人内容）。
3. **A0-6 负例**：**仅在隔离测试配置中进行**——使用一份临时/测试用 provider 配置放入哨兵字符串（如 `SENTINEL_SECRET_DO_NOT_LEAK`），
   断言其**不出现在** Client 返回体；同时断言未"脱敏到不可用"（provider/model 仍可辨识）。
   **禁止修改玩家现有 provider 配置**：不得改动、不得在其中写入哨兵、不得备份后污染真实凭据；测试结束须确认真实配置字节未变。
   若隔离配置无法与真实凭据存储分离，则该用例标 `AUTH-PENDING` 等待授权，不得为跑测试而触碰真实配置。
4. **A0-7 负例**：关闭后**旧运行代次**的迟到写入必须被拒绝（不能因新实例存活而被接受）。

## 3. 暂不执行的用例（挂账）

| 项 | 原因 |
| --- | --- |
| 真实模型 `ctx.llm.stream` 调用 | 可能计费，需用户单独授权 → `AUTH-PENDING` |
| 发布 / 打标签 / 远程写入 | 需用户授权；本角色只给建议 |
| 阶段1-3 的 12 项关键场景 | 依赖阶段0 通过，不在本轮范围 |

## 4. 独立复跑与源码核对（2026-10-18 第三轮）

对界面与运行时工程师交付的 Client Remote 主线做独立验证。**以下退出码为本人在本会话实测，非转述。**

### 4.1 独立复跑结果（全部复现）

| 命令（workdir=`packages/dsh-gamecenter-client`） | 我的退出码 | 结论 |
| --- | --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | **0** | 复现 |
| `node --test test/{runtime-lease,host-bridge,bridge-constants,assembly,focus,bundle-shape,remote-mount}.test.mjs` | **0**，`tests 42 / pass 42 / fail 0` | 复现 |
| `node tools/build-bundle.mjs` | **0**，`dist\client.js` 23226 chars（UTF-16 计 23810，sha256 `1B83C7C8…B880D`） | 复现 |

分栏判定：以上三条分别是 `BUILD`、`UNIT`、`BUILD`。**均不计入阶段0 通过。**
（注：此为第一轮快照 42 项时的记录；修复后同一批测试为 46 项，见 4.4。）

### 4.2 核对范围与方法

- 对照对象为实装 DSH `0.2.1-rc.2 / 332895e0` 的 asar 内源码，用 `read` 按精确路径读取（`glob`/`grep`/node fs 均无法穿透 asar，见 1.3）。
- 逐项核对界面工程师提出的三条待核问题，并**另行自建"源码规则复刻探针"**独立判定，不采信其自测结论。
- 所有结论绑定快照：`remote-mount.js` mtime `2026-10-18 23:27:46`、304 行、sha256 前缀 `3BDBCE85A0EF8638`。

### 4.3 源码核对：界面工程师的撤回是正确的（我独立判定）

| 断言 | 源码位置（本人实读） | 判定 |
| --- | --- | --- |
| `ctx.typert.remotes` = `RemoteStore.view()`，只读 `package`/`descriptors` | `dsh-typert-registry/lib/client.browser.js:437-439`（`get remotes(){return this.remoteStore.view(this.ctx)}`）；`RemoteStore.register:147-162` 只做 `validateSegment(package)` → 重名 throw → `this.descriptors.validate(contribution.descriptors)` | **成立** |
| 另一条 `register(contribution)` 才读 `invocations` | 同文件 `:459-479`，`const invocations = contribution.invocations` | **成立**（正是早先探针抓错的目标） |

→ 因此早前「(b) 不可行」的结论确实错误，撤回正确。这条我采信，依据是源码而非其改口。

### 4.4 我发现的缺陷已由界面工程师修复（复核通过，含一次回归）

**第一轮**（早期 `remote-mount.js`，215 行）我查出三处与实装源码不符，其中两处会导致真实挂载失败：

1. descriptor **缺 `id` / `service`**：`DescriptorStore.validate`（`dsh-typert-registry/lib/client.browser.js:75-86`）
   经 `validateInvocation`（`:583-622`）首句即要求 `descriptor.id` 非空、`descriptor.service` 非空，并对 `id` 查重（`:82`）。
2. `cancellation` 字段名错误：真实判据是 `cancellation.parameter !== "signal"`（`:603-604`），
   原实现写 `{ signal: 'abort' }`，缺 `parameter`。
3. `result` 走 strict 时 typert 要求 `typeSymbol` 非空 + `create()` 是函数（`validateCodec:623-627`），原实现缺失。

**修复后复核**（当前快照 mtime `23:27:46`，304 行，sha256 `3BDBCE85A0EF8638…`）：
descriptor 已补 `id: '@dsh-gamecenter/client#gameCenter.<method>'`、`service: 'dsh-gamecenter'`、
`cancellation: { parameter: 'signal' }`，`result`/参数改用 `strictCodec()`（`typeSymbol` + `create`）。
→ 三条均已修复。

**我用独立编写的"严格按源码复刻"探针验证**（`.strict-mock-probe.mjs`，逐条照抄 `DescriptorStore.validate` + `validateInvocation` + `validateCodec`，
含 `id`/`service` 必填、`wire` 查重、`cancellation.parameter`、`mode` 限制、codec 严格性）：

| 快照 | tsc | 单元测试 | 严格探针 |
| --- | --- | --- | --- |
| 修复前（215 行） | 0 | 42/42 | **未过**：缺 `id`/`service`（按当时文件推演） |
| 修复中（335 行瞬间） | **2**（6 个 TS 错误） | 46/46 | 全过 |
| **稳定快照（304 行，23:27:46）** | **0** | **46/46，fail 0** | **5/5 全过，`DescriptorStore.validate: PASS`** |

→ 结论：当前快照在"源码规则复刻"层面**已自洽**。

**期间发现一次真实回归，必须记录**：修复过程中 `tsc` 曾退出码 **2**（6 个错误：`push` 隐式 any ×3、
`WireDescriptor` 上无 `mode`/`scope` 属性 ×3），但同一时刻**单元测试 46/46 全绿**。
这印证了本验收矩阵的核心判断：**测试全绿不能替代编译通过，更不能替代真实集成**。
我据此要求：任何交付的"通过"声明必须同时给出 `tsc` 退出码与测试退出码，缺一不可。

### 4.5 测试对象不稳定性（流程风险，须记录）

复核期间 `remote-mount.js` 在约 10 秒内被连续改写（215 → 335 → 297 → 304 行，mtime `23:27:37`→`23:27:46`）。
我的结论因此经历了"判定有问题 → 判定已修复 → 发现编译失败 → 判定通过"的翻转。
→ 流程要求：验收方与实现方必须**先约定快照**（commit sha 或 mtime+sha256）再验收；
本报告所有结论仅对快照 `mtime=23:27:46 / 304 行 / sha256 3BDBCE85…` 有效。
在此之前的任何口头"通过"均不可追溯，不予采信。

### 4.6 `cancellation` 判据：已独立核对并结案（2026-10-18 第六轮）

此前挂账的"Host 侧 `prepareInvocation` cancellation 判据"现已由我**直接读源码**核对完毕，不采信转述。

| # | 事实 | 我实读的位置（`dsh-api-gateway/lib/index.js`） |
| --- | --- | --- |
| 1 | `if (descriptor.cancellation !== void 0) args.push(signal);` | **第 1210 行** |
| 2 | `const signal = methodSignal(request, control, descriptor.mode === "stream");` | **第 1196 行** |
| 3 | SRC 生成侧：`const cancellation = signalIndex >= 0 ? { parameter: "signal" } : void 0;` | **第 1253 行** |
| 4 | signal 非末位则抛 `gateway/signature-invalid`（"must be the final parameter"） | **第 1252 行** |
| 5 | SRC 参数 codec = `{ mode: "src-json" }`；result = `{ mode: "src-json" }` | **第 1265、1271、1299 行** |

**结论：`cancellation` 是"存在即触发 signal 注入"，判据只看 `${!== void 0}$`，不看内容。**
Client 侧 `modelCatalog` 填 `{parameter:'signal'}`、其余四个不填，**与 Host 侧判据一致，无错**。
→ 该项**结案**，从待核清单移除。

**附带澄清一处真实的不对称（Host 工程师提出，我复核成立）：**
Host 侧 SRC 生成的 descriptor 内部全部用 `src-json`（1265/1271/1299），
而 **Client 挂载侧必须用 `strict`**（gateway `requireStrictInputs` 强制）。
两端不对称是**设计如此**，不是任何一方抄错——这解释了早前 src-json 争议的根源（见 4.7）。

### 4.6b `SERVICE_KEY` 命名不一致：判定为**非阻断**（我独立核实，不计入缺陷）

| 项 | 值 |
| --- | --- |
| Host `SERVICE_KEY`（`packages/dsh-gamecenter/src/dsh-adapter/protocol.ts`） | `'gameCenter'` |
| Client `SERVICE_KEY`（`src/bridge/remote-mount.js:83`） | `'dsh-gamecenter'` |
| 一致？ | **否** |

**是否阻断调用：不阻断。** 我按源码调用链验证：
`invoke → 1191 resolveReceiverContext(descriptor,…) → 1192 receiverContext.get(descriptor.service)`，
此处的 `descriptor` 来自 `1224 resolveDescriptor()`——它只从
`1225 ctx.typert.local.get(endpoint)`（Host 本地 store）或 `1243 srcDescriptor()`（SRC 生成）取，
而 `1291 service: binding.serviceKey` 用的是 **Host 自己的 Cordis 服务键**。
→ **Client contribution 的 `service` 字段从不参与 Host 取服务**。
→ typert 的 `validateInvocation` 对 `service` 只查非空 + 禁 `#`（`:585`、`:631-633`），`'dsh-gamecenter'` 合法。

**但记一条非阻断风险**：两端命名不同，将来若做端到端对账（比对 Client descriptor 与 Host 生成 descriptor）会产生歧义，
且易让人误以为 `service` 会被 Host 采用。建议 Client 改为 `gameCenter` 统一，**优先级低，不阻断阶段0**。
→ 我按 Host 工程师的建议**不把它记为验收阻断项**，只记为命名一致性风险。

### 4.7 src-json vs strict 争议：独立裁定（2026-10-18 第四轮）

**争议**：架构与协议负责人主张 descriptor 可用 `codec: {mode:'src-json'}` 降低手写成本（依据 registry `validateCodec` 对 src-json 直接 return）；
DSH Host工程师主张本版本会失败（依据两层校验先后顺序）。两人都要求我独立判定，不采信转述。

**我独立确认的源码事实（本人实读）：**

| # | 事实 | 位置 |
| --- | --- | --- |
| 1 | `mountContribution` **先** `this.validateContribution(contribution)`，**后** `callerCtx.typert.remotes.register(contribution)` | `dsh-api-gateway/lib/client.browser.js:1697-1698` |
| 2 | `validateContribution` 遍历 descriptor 时**无条件**调用 `requireStrictInputs(descriptor)` | 同文件 `:1728-1730` |
| 3 | `requireStrictInputs` 只查 parameters / uplink / context-invocation 三处 codec，**不含 result** | 同文件 `:2101-2109` |
| 4 | `validateCodec` 对 `src-json` 直接 `return` 放行 | `dsh-typert-registry/lib/client.browser.js:623-627` |
| 5 | registry 层 strict 还要求 `typeSymbol` 非空 + `create()` 是函数 | 同上 |

**我用自建两层顺序复刻探针实测（4 组对照）：**

| 用例 | 实测结果 |
| --- | --- |
| **参数** codec 用 `src-json` | **拒绝于 GATEWAY 层**：`generated Remote gameCenter/m field "input" has no strict codec` |
| **仅 `result` 用 `src-json`** | **两层均通过** |
| strict 但 `typeSymbol` 为空 | 拒绝于 REGISTRY 层：`type symbol — must be nonempty` |
| strict 但无 `create()` | 拒绝于 REGISTRY 层：`strict codec has no create() factory` |

**裁定：**
- Host 工程师结论**成立，但限「参数」**：参数用 src-json 在 gateway 层即被拒，走不到 registry。
  架构负责人的观察（registry 放行 src-json）本身也成立，但**不适用于参数**。
- **双方都没说准的边界（我补充）**：`requireStrictInputs` 不校验 `result`，
  所以 **`result` 用 `src-json` 实际能通过两层**。争议真实边界是「参数 vs result」，不是笼统的「src-json 行不行」。
- 对当前实现：Client 用全 strict + `typeSymbol` + `create()`，是最保守且正确的选择，**无需改**。

**Client 现状独立审计**（逐 descriptor 逐 codec 断言 mode/typeSymbol/create）：9 个 codec（5 result + 4 param.input）**全 OK，VIOLATIONS=0，退出码 0**。

**Host 侧证据我复跑（非转述）**：`probe-codec-gate.mjs` 退出码 **0**（含 `.encode(` 命中 0 次）；
`codec-gate.test.mjs` **6/6 通过，退出码 0**。分栏均为 `STATIC`/`UNIT`，不是 `DSH-REAL`。

### 4.8 三段手抄 mock 的逐条忠实度核对（2026-10-18 第五轮）

界面工程师要求我核 `remote-mount.test.mjs` 里 `gatewayValidate()` / `typertValidateInvocation()` / `remoteStoreRegister()` 三段手抄实现。
**快照**：`src/bridge/remote-mount.js` mtime `23:29:14`、313 行、sha `16116B3BBF2D`；`test/remote-mount.test.mjs` mtime `23:28:42`、390 行。

**独立复跑（我的退出码，非转述）**：`tsc` **0**；`node --test` 七文件 **51/51 pass，退出码 0**；`build-bundle` **0**，`dist/client.js` 26078 字符。

**核对结论：三段主体忠于源码，但 3 类规则被抄得过松（mock 放行真实会拒绝的形状）。**

| # | 规则 | 源码 | Client mock | 偏差方向 |
| --- | --- | --- | --- | --- |
| 1 | `scope` 唯一性 | `scopedProjection:2083-2100` 要求 lookup **恰好 1 个**，且 `wire` 与 `lookup` 都要与 `scope` 匹配 | 第 68-76 行 `find()` 只判断"存在任一 lookup" | **过松** |
| 2 | `validateWireName` 字符集 | `:628-630`：禁 `.`、`..`，且须匹配 `/^[A-Za-z0-9_$.-]+$/` | 第 104-107 行只查"非空字符串" | **过松** |
| 3 | `validateSegment` 禁 `#` | `:631-633`：非空且不含 `#` | `service` 只查非空（第 105、136 行对 package 查了 `#`，对 service 没查） | **过松** |

**用差异用例实测（.scope-diff.mjs / .wire-diff.mjs / .seg-diff.mjs）：**

| 用例 | 真实规则 | Client mock | 一致 |
| --- | --- | --- | --- |
| scope + 2 个 lookup（非唯一） | 拒绝 | 通过 | **否** |
| scope + 1 个 lookup 但 wire 不匹配 | 拒绝 | 通过 | **否** |
| namespace = `有中文` / `a b` / `.` / `..` / `a/b` | 拒绝 | 通过 | **否** |
| service = `a#b` / `#` | 拒绝 | 通过 | **否** |
| scope + 恰好 1 个匹配 lookup | 通过 | 通过 | 是 |

**但这三处过松不影响当前结论**——我按 `@584-592` 精确规则（`id` 仅 `validateNonempty`；`service` 走 `validateSegment`；`namespace`/`method`/`parameter.name`/`wire` 走 `validateWireName`）审计当前 contribution：
**5 个 descriptor 命名违规 = 无（NONE）**。因为本项目的 `namespace`、`method`、`service`、`id` 全部由代码常量生成，不含中文/空格/`#`/点号，也不使用 `scope`。
→ 判定：**mock 忠实度不足，但当前实现未踩到**。建议补这 3 条守卫测试，防止将来改命名或加 scope 时被放过。

**一处我自我更正（必须记录）**：我第一版审计脚本误把 `validateWireName` 用于 `descriptor.id`，得出"5 个 id 全部违规"的错误结论。
重读 `:584` 确认 `id` **只过 `validateNonempty`，不校验字符集**，`id` 含 `#` 合法。该误报已回收，不作为缺陷记录。
这说明"用错误规则写探针"的风险对验收方同样存在，不能只要求实现方自查。

### 4.9 Host 包独立复核：测试通过，但 `contribution-shape.ts` 缺陷未修（第七轮）

Host 工程师报 `tsc` 0 / `node --test` **49/49**。我独立复跑结果**不一致且更好**：

| 项 | Host 自报 | **我的实测** |
| --- | --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | 0 | **0** |
| `node --test`（workdir=`packages/dsh-gamecenter`） | 49/49 | **52/52，pass 52 / fail 0 / skipped 0 / todo 0，退出码 0** |

→ 差异原因：测试文件由 5 个增至 6 个（新增 `codec-gate.test.mjs`，mtime `23:30:50`），他报数时尚未加入。
→ 我逐条看了 52 项名称，**无跳过、无 todo**，覆盖 inject/apply、codec 门禁、模型目录脱敏、租约状态机等，全部真实执行。
→ 分栏：`BUILD` + `UNIT`，**不是 `DSH-REAL`**。

**但我查出一项 Host 未修、且会致真实挂载失败的缺陷：**

`packages/dsh-gamecenter/src/remote/contribution-shape.ts`（147 行）**完全没有按界面工程师的转告补齐**。
静态审计结果（`.host-static-audit.mjs`，直接读该文件）：

| # | 缺失项 | 源码要求 | 现状 |
| --- | --- | --- | --- |
| 1 | `descriptor.id` | `validateInvocation:584` 硬性非空 | **缺** |
| 2 | `descriptor.service` | `:585` 硬性 nonempty + 禁 `#` | **缺** |
| 3 | `codec.typeSymbol` | `validateCodec:625` strict 必需 | **缺** |
| 4 | `codec.create` | `validateCodec:626` 必须是函数 | **缺** |
| 5 | `cancellation.parameter` | `:604` 必须 `=== "signal"` | **错**：写的是 `{ signal: 'abort' }`（第 102 行） |

**缺失 5 / 5 项。**

**影响判定（要分清两件事）：**
- `contribution-shape.ts` 目前是 Host 包的**类型定义 + 本地校验器**，测试证明它被 import 且 tsc 通过；
  但**它不是实际挂载到 Client 的那个 contribution**（实际挂载的是 Client 包自己的 `createGameCenterContribution()`，已修正）。
- 因此：**当前不影响真实挂载**（Host 侧挂载走 Client 的 contribution）；
  但**它作为"形状契约"已经过期且是错误的**——若有人照它手写 descriptor，会在 registry 阶段失败。
- 同时，它自带的 `validateContributionShape()`（第 121-146 行）**只复刻了 gateway 一道**，缺 typert 那道，
  所以**跑它全绿不代表形状能挂载**。这是"本地校验器放过真会失败的形状"的又一实例。

**判定：不计为阶段0 阻断项（当前未参与实际挂载），但记一项"契约文档与代码不一致"缺陷，须修。**
理由：它公开承诺自己是"供界面工程师手写时对齐的形状契约"（文件头第 2 行），却是错的——这比没有契约更危险。

### 4.10 本轮判定

- `BUILD`：**通过**（Client tsc 0；Host tsc 0）。
- `UNIT`：**通过**（Client 51/51；Host 52/52，均实测无跳过）。
- `STATIC`：src-json 争议结案（4.7）；cancellation 判据结案（4.6）；`SERVICE_KEY` 非阻断（4.6b）。
- `MOCK`：**有条件通过**——形状能过两道闸门复刻；但 mock 有 3 处过松（4.8），不构成集成证明。
- `DSH-REAL`：**仍未进行**，A0-3/A0-4 继续 `BLOCKED`。
- 剩余待办：
  1. **Host `contribution-shape.ts` 五项缺陷待修**（4.9），并补 typert 那道校验；
  2. Client 补 3 条守卫测试：scope 唯一性、wire 字符集、service 禁 `#`；
  3. Client `SERVICE_KEY` 建议改 `gameCenter` 消歧（低优先级）；
  4. 真实 `$mount`、Host `resolveDescriptor` SRC 回退、弹层渲染——需装进 profile 并重启 GUI，**须用户授权**。

## 5. 当前结论

- 阶段0：**未通过**。A0-1（版本锁定）已有硬证据并可结案；A0-2 至 A0-7 **尚未产生任何 `DSH-REAL` 运行证据**。
- 已消除的阻塞：① shell 已恢复（node v24.19.0 实测可用），`UNIT`/`BUILD` 可产出；
  ② asar 可由 `read` 按精确路径穿透并已读到 runtime 依赖清单。
- 仍存在的阻塞：插件目录约定、Host 入口字段、`/remote` 显式装配点、`shell.overlay` 现有占用者——**均需源码依据**。
- 解除阻塞最小条件（更新后）：
  1. Host/Client 工程师给出**精确文件路径 + 行号**的装配入口源码证据；
  2. 我据此编写可复现的 `DSH-REAL` 验证步骤（含负例）；
  3. 运行前须得到「在真实 DSH 中加载插件」的授权——该操作会重启 GUI 当前窗口，属于影响用户现场的操作。
- 不结案声明：本轮不产出"通过"结论，不得以编译通过或 mock 通过替代真实加载验证。

## 6. 编辑窗口与快照台账（测试与发布负责人维护）

新用户需求「游戏中心入口放在技能中心附近」触发 Client 入口改动。为免验收基于"编辑中代码"下结论，
按实现方请求建立两步快照制：**实现方在窗口外只读；窗口内独占编辑；窗口关闭后我重取快照并复跑。**

### 6.1 快照 A（编辑前基线）——已固定

取于 `2026-10-18 23:31:40`（文件时间），命令复跑于 `23:31:44`：

| 文件 | mtime | 行数 | sha256 前缀 |
| --- | --- | --- | --- |
| `src/index.js` | 23:25:13 | 243 | `B68BB5AF1903` |
| `src/bridge/remote-mount.js` | 23:29:14 | 313 | `16116B3BBF2D` |
| `src/ui/GameCenterOverlay.js` | 23:11:01 | 176 | `847E7C29738F` |
| `dist/client.js` | 23:30:41 | 741 | `8DA62767B730` |
| `docs/phase0-client.md` | 23:29:37 | 470 | `1482FCB597F6` |

**快照 A 的可复现性已验证**：`tsc` 退出码 **0**；`node --test` 七文件 **51/51，退出码 0**。
→ 快照 A 是一个自洽、可复现的基线，后续任何回归都以此对比。

### 6.2 编辑窗口授权

**已放行**：实现方可在 `packages/dsh-gamecenter-client/**` 内编辑，范围为
`src/index.js`（入口插槽）、`dist/client.js`（重新打包）、`docs/phase0-client.md`（记录插槽证据）。
`remote-mount.js`、`lease.js`、`host-bridge.js`、`focus.js` 及各 test **不应变动**——若必须改动，需在窗口内提前告知，否则我按"I/O 外变更"记为流程偏差。

**窗口规则（三条，缺一即判无效）**：
1. 窗口内我不对 Client 包下任何"通过/不通过"结论；
2. 窗口关闭信号 = 实现方给出**完成声明 + 自身 tsc/测试退出码 + 新 mtime**，我据此取快照 B；
3. 快照 B 若与 A 在"预期不动"文件上有差异，无论测试是否全绿，均记流程偏差并单独复核。

### 6.3 快照 B（编辑后）——待取

状态：**未取得**。取到后在本节补登，并对 A→B 做差异审计（预期改动 vs 实际改动），
重点核对：入口插槽是否真在技能中心同区域（需源码级插槽证据，不接受"看起来在附近"）；
是否动到 `remote-mount.js` 等预期不动文件；51 项测试是否仍全绿。

### 6.4 对"补充需求"本身的验收注记

- 该需求**不豁免** Remote 真验收，也**不扩大**阶段0 范围。
- 入口位置属于 UI 层证据，仍只计 `BUILD`/`UNIT`/`MOCK`；真实渲染必须 `DSH-REAL`（须授权）。
- 需守住用户原话「**保留技能中心，不替换不遮挡**」——我在快照 B 的审计中会专门查：
  是否新增独立入口而非替换既有项；`sidebar.panellist` 或新插槽若会导致遮挡，需显式说明。

## 7. 快照 B 独立验收结论（第八轮，PM 指派接续）

**验收有效性的前提已满足**：执行前 T0 与执行后 T1 的输入摘要**完全一致**，说明验收期间无人改动输入，
本轮结论不建立在"编辑中代码"上。

| 项 | 值 |
| --- | --- |
| T0（`23:39:43` 之后） | COUNT=**115**，INPUT_DIGEST=`2B1334116329CF88971CB488D0BE7327253AB77310B00396AF75A2ED13BDBB02` |
| T1（`23:40:05`） | COUNT=**115**，INPUT_DIGEST=`2B133411…BDBB02` |
| 一致 | **是（UNCHANGED=True）** |

### 7.1 工具环境（实际路径与版本，非清单引用）

| 工具 | 实际路径 | 版本 |
| --- | --- | --- |
| node | `<NODE_BIN>\node.exe` | **v24.19.0** |
| npm | 同上 bin | **11.17.0** |
| PowerShell | — | 5.1.26100.9711 |
| TypeScript | `npx -p typescript@5.7.3` | 5.7.3 |

注意：与 `runtime.json` 记载的 `node 24.21.0 / pnpm 11.28.5` **不一致**；本报告一律以**实测**为准。

### 7.2 执行结果（本人实测退出码）

| 包 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| Client | `tsc -p tsconfig.json` | **0** | BUILD 通过 |
| Client | `node --test` ×7 文件 | **0** | **54/54**，fail 0 / skipped 0 / todo 0 |
| Client | `node tools/build-bundle.mjs` | **0** | 26563 chars，**确定性构建**（前后 sha 均 `9CEAC9E0DEF38DBF…`） |
| Host | `tsc -p tsconfig.json` | **0** | BUILD 通过 |
| Host | `node --test` | **0** | **52/52**，fail 0 / skipped 0 / todo 0 |
| Protocol | `node --test test/contract.test.mjs` | **0** | **10/10** |

→ 合计 **116 项单测全通过，零跳过、零 todo**。分栏：`BUILD` + `UNIT`，**不是 `DSH-REAL`**。

### 7.3 唯一一条可复现缺陷（交文件 owner，按规则只报一条）

**文件**：`packages/dsh-gamecenter/src/remote/contribution-shape.ts`（快照 B 中 sha `F0B61A8A7475B1F6…`，6174 字节）
**复现命令**：`node .recheck-shape.mjs`（读该文件，比对五项源码要求）
**退出码**：0（脚本本身成功），**检出缺失 5/5**

| # | 缺失 | 源码要求 | 该文件现状 |
| --- | --- | --- | --- |
| 1 | `descriptor.id` | `typert-registry/client.browser.js:584` `validateNonempty` | **缺** |
| 2 | `descriptor.service` | `:585` + `:631-633` 非空且禁 `#` | **缺** |
| 3 | `codec.typeSymbol` | `:625` strict 必需 | **缺** |
| 4 | `codec.create` | `:626` 必须函数 | **缺** |
| 5 | `cancellation.parameter` | `:604` 必须 `=== "signal"` | **错**（第 102 行仍 `{ signal: 'abort' }`） |

另：其 `validateContributionShape()` **只复刻 gateway 一道**，缺 typert 那道 → 跑绿不代表形状可挂载。

**预期 vs 实际**：预期该契约文件与实装两道闸门一致；实际与源码不符 5 项，且校验器少一道。
**影响定性（不夸大）**：当前真实挂载走的是 Client 包已修正的 `createGameCenterContribution()`，
所以**该文件缺陷不阻断当前挂载**；但它是文件头自称的"形状契约"，照它手写必然在 registry 阶段失败。
**责任人**：DSH Host工程师（包所有权），**不阻断本轮进入真实加载准备**，但须修。

### 7.4 与本地 mock 的差异核对（PM 重点要求项）

已逐条对照源码复核 Client mock 三道复刻（`remote-mount.test.mjs`），本轮补充确认：

| mock 函数 | 对照源码 | 结论 |
| --- | --- | --- |
| `gatewayValidate` | `client.browser.js:1718-1744`、`2101-2109` | 只查 parameters/uplink/context，**正确不查 result** |
| `typertValidateInvocation` | `typert-registry:583-622` | 含 `id`/`service`/wire 查重/`cancellation.parameter`/`mode`/scope 分流，**已忠实** |
| `remoteStoreRegister` | `:75-86`、`:147-162` | 只读 package/descriptors + id/endpoint 查重，**已忠实** |

→ 前轮指出的三处"过松"（scope 唯一性、wire 字符集、service 禁 `#`）**已修复并补齐守卫测试**，本轮 54/54 覆盖。
→ **但仍是 mock**：它证明"形状能过我所复刻的两道闸门"，**不证明真实 `$mount` 成功**。

### 7.5 明确结论

**可以进入"真实加载准备"（变更单编写），但不可宣称阶段0 通过。**

进入真实加载准备的依据：Client/Host/Protocol 三包 tsc 与单测全绿且输入稳定；codec、cancellation、命名规则均已源码级对齐；bundle 确定性可复现。

**剩余门禁（全部为 `DSH-REAL`，未执行）：**
1. 真实 `$mount` 是否接受该 contribution（挂载期两道闸门在实装进程中是否按预期放行）；
2. `ctx.remote.gameCenter.*` 是否真的连到 Host `@Remote` 服务；
3. Host `resolveDescriptor` 的 SRC 回退路径是否命中（`gateway/invocation-unavailable` 风险）；
4. 弹层在真实 DSH 内的渲染与"不覆盖既有 overlay"；
5. 关闭后拒绝请求 / 取消语义的实机行为。

→ 以上均需装 profile + 重启 GUI，**须用户授权**，本轮未做、不视为已做。
→ `A0-2`~`A0-7` 状态一律仍为 **`BLOCKED（未验证）`**。

**窗口处置**：本轮验收已固定，**解除 Client/Host 编辑窗口**。任何后续修改请先告知，我按新快照重验。

### 7.6 冻结声明核对与一处不可复现异常（第八轮补充）

界面工程师提交了 Client 包冻结摘要（12 个关键文件 SHA256 前 16 位）。我**逐条用 SHA256 实算比对**：

| 文件 | 其声明 | 我实测 | 一致 |
| --- | --- | --- | --- |
| `dist/client.js` | `9CEAC9E0DEF38DBF` | 同 | OK |
| `src/index.js` | `C7E259A4A9AFDD07` | 同 | OK |
| `src/bridge/remote-mount.js` | `32A5582905D6B898` | 同 | OK |
| `src/ui/GameCenterOverlay.js` | `847E7C29738F0245` | 同 | OK |
| `src/ui/focus.js` | `ADC09408220EB9FA` | 同 | OK |
| `src/runtime/lease.js` | `F59962995BA077F1` | 同 | OK |
| `src/runtime/resources.js` | `E6BB922BAF350259` | 同 | OK |
| `src/bridge/host-bridge.js` | `0245D97E8E88BD71` | 同 | OK |
| `test/remote-mount.test.mjs` | `3149C6267C7D934D` | 同 | OK |
| `lib/client.js` | `539E0573BA91EC10` | 同 | OK |
| `package.json` | `D8068394EEB244D0` | 同 | OK |
| `tsconfig.json` | `03D32DB338FA5E33` | 同 | OK |

**MISMATCH_COUNT = 0**，与我快照 B 完全吻合。冻结声明成立，本轮验收结论继续有效。

**"构建副产物"说法我独立验证后采信**：我实算了 `src/*.js` 共 7 个文件的合并摘要，
执行 `tsc -p tsconfig.json`（emitDeclarationOnly，只生成 `src/types/**`）后**再次实算，摘要不变**
（`FF87836587F225A044415BC462E7E47CBE05B9BC8E5EFAE86FDF7821AD3CBB23` 前后相同）。
→ 确认 `tsc` 不修改 `src/*.js` 源码，`dist/client.js` 的 mtime 变化伴随**字节数与 sha 均未变**，
属重新打包的副产物。**不记为偏差。**

**一处必须如实记录的异常（不可复现，不作缺陷）**：
在一次组合命令中，`tsc` 曾返回**退出码 1**（该命令形态为 `tsc | Out-Null` 后紧接 `Get-FileHash`）。
我随后用同一命令形态**连续重跑 3 次，均为 0**；单独运行 3 次亦均为 0，输出恒为空。
→ 判定：**单次不可复现，不认定为缺陷，也不隐藏**。可能为 `npx` 首次解析/并发写 `src/types` 的一次性竞争。
→ 影响：本轮"tsc 退出码 0"的结论建立在多次稳定复现之上，不受此单次影响。
→ 建议：实现方与我今后跑 tsc 时**保留完整 stdout，而不只记退出码**，以便下次出现时能定位。
→ 这也是本轮唯一一处工具层面不确定项，已如实上报。

## 8. 真实装载入口审计：发现一处**阻断级**缺陷（第九轮）

背景：进入"真实加载准备"后，我审计 Client 包能否被 DSH 实际装载（变更单的前置条件）。
**结论：当前 `exports["./client"]` 指向错误文件，真实装载会拿到过渡壳而非生产 bundle。**

### 8.1 DSH 侧的解析规则（我实读源码）

`@deepseek-ai/dsh-client-modules/lib/index.js`：

| 位置 | 事实 |
| --- | --- |
| `:171-182` `clientExportOf(pkgName, exportsField)` | **只读 `exports["./client"]`**；字符串直接用；对象取 `.default`；否则抛错 |
| `:99-101` `stripClientSuffix` | `<id>/client` 与裸包名**归一为同一 exports** |
| `:128-143` `MissingClientBundleError` | 找不到 bundle 时给出 `client bundle not found` |

→ **DSH 不读 `dshGameCenter.bundle`**（那是本项目自定义的非标准字段）。

### 8.2 现状与偏差

| 项 | 值 | 判定 |
| --- | --- | --- |
| `exports["./client"].default` | **`./lib/client.js`** | ← DSH 实际取这个 |
| `exports["."].default` | `./lib/client.js` | 同上 |
| `main` | `lib/client.js` | 同上 |
| `dshGameCenter.bundle`（自定义） | `dist/client.js` | **DSH 不读** |

`lib/client.js`（789 字节）实测：
- **含顶层 `import`**（`import { apply } from '../src/index.js'`）；
- 直接引用 ESM 源码路径 `../src/index.js`；
- 其自身文件注释写明：「**这个文件不是 DSH 生产形态**……真实加载前必须切到 dist 产物」。

`dist/client.js`（26730 字节）实测：首行 `window.__ModuleLoader__.load({`，**无顶层 import**，符合 bundle 形态。

### 8.3 影响与严重性

**严重性：高（阻断真实装载）。** 处理逻辑：
1. DSH 按 `exports["./client"].default` 取到 `lib/client.js`；
2. 该文件是源码层 ESM 壳，引用了 `../src/index.js`，且 `files` 字段虽含 `lib`，但装载环境是浏览器端
   模块加载器（`window.__ModuleLoader__`），不保证能解析该 ESM 依赖链；
3. 即使侥幸解析，装载的也**不是**经过 esbuild 打包、已通过 54 项测试的那个产物。

→ 后果：**变更单若按现状执行，真实加载大概率失败或加载到未验证的代码**，且失败原因容易被误判成 Remote 或 profile 问题。

### 8.4 修法（交 owner，一行级改动）

把三处入口改为 `./dist/client.js`：
- `exports["./client"].default`
- `exports["."].default`
- `main`

**不改 `dshGameCenter.bundle`**（它已是正确值，作为项目自检标注保留）。

### 8.5 严重性的自我校准（必须说明）

我在写这条时先怀疑"是不是我看错了 `dsh.client` 声明"，已核对：`dsh.client = {"platform":"web","inject":[]}`，
**`parseDshClient`（`:62-76`）只解析 `platform`/`inject`/`external`/`immediately`，不含入口路径**。
入口路径唯一来源就是 `exports["./client"]`。因此该结论不是推测。

**但必须标注边界**：以上是**源码级（`STATIC`）**结论，**未在真实 DSH 中执行装载验证**。
真实装载失败/成功属 `DSH-REAL`，本轮未做、须授权。所以本条定位为：
**"有强源码依据的阻断级风险，待 DSH-REAL 确认"**，而非"已实测失败"。

### 8.6 对变更单的前置要求（给 DSH Host工程师）

变更单**不建议**在入口修正前定稿并提交授权。理由：授权一次 GUI 重启的成本高，
若因入口指向错误而失败，会浪费一次授权窗口并污染首轮 DSH-REAL 结论。

**建议顺序**：
1. Client owner 修 `exports`/`main` 三处 → 我复跑 tsc + 54 项测试 + bundle 确定性，取快照 C；
2. 我复核 `node -e "require.resolve"` 级别或静态确认三处一致指向 `dist/client.js`；
3. 变更单定稿 → 用户授权 → 一次性执行真实装载 → 我取 DSH-REAL 证据。

→ 若 PM 决定按"先加载再看"的方式，请明确知晓：**首轮失败很可能来自这条入口，而非 Remote 契约**。

## 9. 共享协议与本地类型子集的一致性核查（第十轮，响应 PM 要求）

PM 要求送验前补"本地类型子集与共享协议的一致性检查，避免形成两套漂移契约"。
**核查结论：漂移已经发生，且可量化。**

### 9.1 事实

Host 工程师为解决构建依赖（`import type ... from '@dsh-gamecenter/protocol'` 会把 protocol 源码拉进 program，
触发 TS6059），把两处**仅用于类型**的引用改为本地内联结构子集。我已确认产物侧是干净的：

| 检查 | 结果 |
| --- | --- |
| `lib/**/*.js` 真实 ESM import 语句扫描（排除注释） | **全部为相对导入与 `node:` 内建，无外部包依赖** |
| 我最初的文本匹配告警（`lib/runtime/lease.js` 含 protocol） | **误报**——命中的是第 3 行 JSDoc 注释，非运行时 import。该告警已回收 |

→ 说明构建层面的处理**没有**把 protocol 拖进运行时依赖，这一点是合格的。

### 9.2 但类型契约已经分叉

| | 共享协议（权威） | Host 本地子集 |
| --- | --- | --- |
| 文件 | `packages/protocol/src/save.ts:94` | `packages/dsh-gamecenter/src/runtime/lease.ts:48` |
| 类型名 | `RuntimeLease` | `LeaseRecord` |
| 公共字段 | `runtimeInstanceId`、`generation`、`gameId`、`saveId`、`expiresAt`、`sealed` | 同左 6 项，**完全一致** |
| 协议独有 | — | — |
| **本地独有** | — | **`state: LeaseState`**、**`lastPersistedRevision: number`**、**`tokenDigest: string`** |
| 另有本地类型 | — | `LeaseErrorCode`、`LeaseState`、`LeaseViolation`、`LeaseCheck`、`AcquireInput` |

**判定：不是字段冲突，是"本地超集"。** 本地 3 个额外字段（`state`/`lastPersistedRevision`/`tokenDigest`）
是 Host 运行时状态机需要的实现细节，协议里未定义。

### 9.3 风险定性与建议

- **当前不构成运行时错误**：类型只在编译期起作用，产物已切断依赖，功能不受影响。
- **构成契约漂移风险，且 PM 的担心成立**：同一概念在两个包有两个名字（`RuntimeLease` vs `LeaseRecord`），
  字段集不同，且没有自动化一致性检查。**下游（Client、SDK、存档迁移）若按协议写，会缺 3 个字段；
  若按 Host 本地写，则与协议不符。**
- **建议（交架构与协议负责人 + Host 工程师，不阻断本轮验收）**：
  1. 明确 `RuntimeLease` 是**对外契约**、`LeaseRecord` 是**Host 内部状态**，在两端注释里写死这层关系；
  2. 增加一条一致性断言测试：本地 `LeaseRecord` 必须满足 `extends RuntimeLease` 的字段约束
     （可用 TS 的 `satisfies` 或类型级 `LeaseRecord extends RuntimeLease ? true : never` 编译期校验）；
  3. 该断言应放在能被 `tsc` 检查的范围内，不能用运行时字符串比较替代。
- **优先级**：中。不阻断阶段0 的装载验证，但**必须在阶段1 写 SDK 之前解决**，否则会扩散。

### 9.4 本轮不做的事

PM 已明确本轮不做快照 C 验收、不发起新冻结。我遵守：
**本节仅为一致性核查结论，不是验收结论**，不改任何实现方文件，也不解除/建立窗口。
真实装载、`$mount`、SRC 回退、弹层渲染仍全部 `DSH-REAL` 未验证，`A0-2`~`A0-7` 依旧 `BLOCKED`。

## 10. 完整候选独立验收（第十一轮，PM 指定两项重点）

**验收有效性**：执行前 T0 与执行后 T1 输入摘要**完全一致**（COUNT=185，`DIGEST=C9148AA5DB001B5F…C9E22DA`），期间无文件改动。

### 10.1 实测退出码（本人在仓库根与包目录分别执行）

| 包 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| Host | `tsc -p tsconfig.json` | **0** | — |
| Host | `tsc -p tsconfig.build.json` | **0** | — |
| Host | `node --test test/*.test.mjs` | **0** | **73/73**，skipped 0 / todo 0 |
| Host | `node tools/verify-load-prereqs.mjs`（仓库根） | **0** | 11/11，**但第 11 项判据不成立，见 10.2** |
| Client | `tsc -p tsconfig.json` | **0** | — |
| Client | `node --test test/*.test.mjs` | **0** | **63/63**，skipped 0 / todo 0 |
| Protocol | `node --test test/*.test.mjs` | **0** | **10/10** |

附注：`verify-load-prereqs.mjs` 必须在**仓库根**执行；从包目录执行会因相对路径假设得到 0/11（ENOENT）。
这是脚本可移植性缺陷，非产品缺陷，建议改为基于 `import.meta.url` 定位，避免验收方误判。

### 10.2 风险一：Client 是否真被发现 —— **不成立，属阻断缺陷**

我**不复用实现方的探针**，而是按 `dsh-client-modules/lib/index.js` 的
`exactPackageSpecifier`(764-766) → `nearestPackage`(793-809) → `resolveMeta`(720-750)
逐步复刻，并以真实 Loader 条目名执行：

| Loader 条目 name | `locatePkgJson` 返回 | `dsh.client.platform` | `exports["./client"]` | `resolveMeta` 结果 |
| --- | --- | --- | --- | --- |
| `@dsh-gamecenter/host` | Host 包 | **undefined** | **undefined** | **null（不是 client 包）** |
| `@dsh-gamecenter/client` | Client 包 | `web` | `./dist/client.js` | Client 包（被发现） |

**判定：当前 patch 只有 `@dsh-gamecenter/host` 一条 Loader 条目，`resolveMeta` 对 Host 条目返回 `null`，
Client 永远不会进入 source 表。静态 `import '@dsh-gamecenter/client'` 不改变这一点**——
因为 `expectedPackageName` 恒等于 Loader 条目 name（host），`nearestPackage` 要求
`pkg.name === expectedPackageName`，只会返回 Host 包。

**实现方注释存在一处误读**（patch 内明确写着"这里绝不能给 client 再单独加一条"）：
`:893-896` `reconcilePackage` 的判定对象是 **同一 `packageName` 命中多个 active source**，
而 host 与 client 是两个不同包名，**各登记一条不会触发该 throw**。
正确含义是"每个包各自只能一条"，不是"整个 patch 只能一条"。

**修复方向（交 Host 工程师，其文件）**：在 `cordis.patch.yml` 的 `insert` 中**再加一条**
`{ id: gamecenter-client, name: "@dsh-gamecenter/client" }`。前提是 Client 已有可 Node 加载的 Host 半
（`lib/index.js`，实测可 import 且不依赖 window，已验证）。
**静态 import 锚点方案不成立，不能作为替代。**

### 10.3 风险二：类型一致性断言是否真能拦错 —— **成立，当前写法有效**

PM 指出 `type X = A extends B ? true : never` 因 never 不报错。我做了**三组对照实验**：

| 写法 | 类型不一致时 | 退出码 |
| --- | --- | --- |
| 裸 `type T = B extends A ? true : never` | **不报错** | 0 |
| `type Assert<T extends true> = T` + `Assert<...>` | `TS2344` | 2 |
| **`type T = ... ? true : never` + `const v: T = true`** | **`TS2322`** | 2 |

→ PM 的担心对**裸写法**成立；但 **Host 当前用的是第三种**（`lease.ts:118-123` 两对 type+const），
`never` 会让 `const v: T = true` 报 `TS2322`。**该写法有效。**

**负例实测（我的关键证据）**：向 `src/runtime/` 注入一份把 `runtimeInstanceId` 改名破坏的
`__neg_lease.ts`，执行 `tsc -p tsconfig.json`：

```
__neg_lease.ts(119,7): error TS2322: Type 'true' is not assignable to type 'never'.
__neg_lease.ts(122,47): error TS2344: 'keyof RuntimeLease' does not satisfy 'keyof LeaseRecord'.
__neg_lease.ts(123,7): error TS2322: Type 'true' is not assignable to type 'never'.
NEG_EXIT = 2
```

→ **故意破坏字段确实编译失败，且报错点正落在两条断言上**。负例文件已删除并确认清理（`Test-Path=False`）。
**结论：类型一致性检查有效，无需改写法。** 但建议补一条自动化负例测试，避免将来被改成裸 `type`。

### 10.4 本轮结论

**不可进入真实加载。** 依据：风险一（Client 发现链）**未闭环**，patch 缺 Client Loader 条目，
按源码 `resolveMeta` 不会发现 Client 包。若现在装载，Host 可能被加载但 Client bundle 不会被下发，
游戏中心入口与弹层不会出现——失败现象极易被误判为 UI 或 Remote 问题。

**已具备的条件**：Host/Client/Protocol 三包 tsc 与单测全绿（73/73、63/63、10/10，零跳过）；
类型契约一致且有可验证的编译期拦截；protocol 已改为 dist 产物；
`exports` 子路径全部指向真实产物；Client Host 半可 Node 加载。

**剩余门禁**：
1. 【阻断】patch 补 Client Loader 条目（owner=Host，修完我重验）；
2. 真实 `$mount` 是否接受 contribution；
3. `ctx.remote.gameCenter.*` 是否连到 Host；
4. `resolveDescriptor` SRC 回退是否命中；
5. 弹层真实渲染 + 不覆盖既有 overlay；
6. 关闭后拒绝请求 / 取消语义。

第 2-6 项均为 `DSH-REAL`，需装 profile + 重启 GUI，**须用户授权**，本轮未做。
`A0-2`~`A0-7` 仍为 **`BLOCKED`**。

**窗口处置**：本轮验收已固定，**结束该失败快照窗口，放行 Host 修复以上阻断项**；
修完给出新快照与退出码，我重新取摘要复验，不等 PM 转发。

## 11. 完整候选收尾验收（第十二轮）——明确结论

### 11.1 结论

**可以进入「真实加载准备」（即可将变更单交付用户审批），但阶段0 本身仍未通过。**

理由：装载所需的**全部 Node 侧前置条件已独立复现闭环**（见 11.2–11.5）；
但**没有任何一条 `DSH-REAL` 证据**，阶段0 的判定标准（真实装载 + 调用 + 弹层）尚未触及。
`A0-2`~`A0-7` 保持 **`BLOCKED`**。

### 11.2 实测退出码（本轮，本人执行）

| 目标 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| Host | `tsc -p tsconfig.json` | **0** | — |
| Host | `tsc -p tsconfig.build.json` | **0** | — |
| Host | `node --test test/*.test.mjs` | **0** | **77/77**，skipped 0 / todo 0 |
| Client | `tsc -p tsconfig.json` | **0** | — |
| Client | `node --test test/*.test.mjs` | **0** | **64/64**，skipped 0 / todo 0 |
| Protocol | `node --test test/*.test.mjs` | **0** | **10/10** |
| 仓库根 | `pnpm run build` | **0** | protocol 先行，host/client 并行均 Done |
| 仓库根 | `pnpm run test` | **0** | 见 11.6 覆盖缺口 |

构建确定性：`build-bundle.mjs` 重建前后 `dist/client.js` sha 均为 `9CEAC9E0DEF38DBF`（**确定性成立**）。

### 11.3 Client 发现链：已闭环（本人独立复现，未复用实现方探针）

按 `dsh-client-modules` 源码逐步复刻 `exactPackageSpecifier`(764-766) → `nearestPackage`(793-809)
→ `resolveMeta`(720-750)，以 **patch 中真实的两条 Loader 条目名**逐一执行：

| Loader 条目 name | `resolveMeta` 结果 |
| --- | --- |
| `@dsh-gamecenter/host` | **null**（`dsh.client.platform` = undefined） |
| `@dsh-gamecenter/client` | **Client 包被发现**（platform=web，clientPath=`./dist/client.js`） |

**`CLIENT_DISCOVERED = true`**。patch（sha `9033468FBCBEDDE1`）含两条独立 `insert`。

**探针两目录可运行**：`verify-load-prereqs.mjs` 从**仓库根**与**包目录**各 **12/12 PASS，退出码 0**
（此前包目录 ENOENT 的可移植性缺陷已修）。

### 11.4 删条目负例：成立（证明该断言非自证）

临时删除 patch 中的 `gamecenter-client` 条目后：

- 探针降为 **10/12，退出码 1**；
- 两条失败信息准确指向缺失条目与发现链断点。

已**按字节恢复**，恢复后 sha 回到 `9033468FBCBEDDE1`，探针复现 **12/12，退出码 0**。

### 11.5 依赖解析与真实链接目标（显式核验，未纳入源码摘要）

| 从 | 解析 `@dsh-gamecenter/...` | 实际落点 |
| --- | --- | --- |
| host | protocol | `packages/protocol/package.json` |
| host | client | `packages/dsh-gamecenter-client/package.json` |
| client | host | `packages/dsh-gamecenter/package.json` |
| client | protocol | `packages/protocol/package.json` |

四个 workspace 符号链接全部存在且指向含真实 `package.json` 的目录。
`node_modules` **未**纳入源码摘要（安装产物），其存在性以本节的解析实测为准。

### 11.6 依赖环评估：**不阻断可重复构建**（最小判定，不外扩）

- 根构建脚本为「protocol 先行，其余并行」，`pnpm run build` **退出码 0**，两包均成功。
- 实测 **Client 不 import Host**（`lib/`、`dist/` 均无该导入）；Host 的 `lib/index.js` 有一条
  `import '@dsh-gamecenter/client'`（副作用导入，即发现锚点）。
- 因此该环是**声明层环**，不存在相互的构建期依赖，`private` workspace 下 pnpm 可处理。
  **本轮不修、不扩范围**；已记录为结构债，建议 Client 补 `host` 依赖的理由消失后可拆除。

### 11.7 本轮新发现两处验证缺口（非阻断，但影响后续门禁有效性）

**(A) `tsc` 不校验「仅副作用导入」的模块解析——`tsc exit 0` 不能证明该依赖可解析。**
对照实验（本人在 Host 包内实测后已清理探针）：

| 写法 | 结果 |
| --- | --- |
| `import { x } from '不存在的包'`（值导入） | **TS2307**，退出码 2 |
| `import '不存在的包'`（仅副作用） | **退出码 0，无报错** |
| 故意类型错误 `const bad: number = 'str'` | **TS2322**，退出码 2（证明 tsc 确实在检查） |

→ Host 的 Client 锚点是**副作用导入**，故 **Host 的 `tsc` 通过并不证明该依赖可解析**。
当前该解析由 `verify-load-prereqs` 的**真实 Node import** 覆盖（已 PASS），故不阻断。
**建议**：把该锚点改为值导入（如 `import { name } from '@dsh-gamecenter/client'`）或加显式解析断言，
让 `tsc` 也能拦住解析失败。

**(B) Host 的 `package.json` `test` 脚本漏跑 2 个测试文件。**
脚本显式列出 6 个文件，`test/` 下实为 **8** 个；未覆盖 `build-artifact.test.mjs` 与 **`type-assert.test.mjs`**。
后果：仓库根 `pnpm run test` 只跑 **61** 项（直接 glob 为 **77** 项），
**恰好跳过守护类型漂移的断言测试**。→ 建议 `test` 脚本改为 glob 或补全文件列表，否则根门禁形同虚设。

**(C) 验收窗口未被完全冻结（流程事实，如实记录）。**
T0（`00:41`，187 文件）与 T1（`00:53`，189 文件）摘要**不一致**。已定位原因：
Host 工程师在窗口内新增 `tools/probe-profile-resolution.mjs`（00:49）、`tools/simulate-profile-link.mjs`（00:51），
**均为 `tools/` 辅助探针，不参与包产物**；我自身的对照实验产物已全部清理。
→ 结论不受影响，但记录为流程事实：实现方在验收窗口内写文件会使摘要失效，
今后窗口内新增文件须先告知。

### 11.8 剩余门禁（全部 `DSH-REAL`，本轮未做）

1. 真实 profile 装载：`dsh.profile.bundles` + patch 生效，stderr 无 `skipping profile bundle`；
2. `resolveMeta` 在真实 Loader `baseUrl` 下是否命中 Client；
3. `ctx.remote.gameCenter.*` 是否连通 Host（`claimsEndpoint('gameCenter/handshake')`）；
4. `$mount` 是否接受该 contribution；`resolveDescriptor` 的 SRC 回退是否命中；
5. 弹层真实渲染 + 不覆盖既有 overlay；
6. 关闭后拒绝请求 / 取消语义。

→ 均需装 profile + 重启 GUI，**须用户授权**。

### 11.9 交付给变更单的前置事实（供 Host 定稿）

- **clean clone 必须先构建**：`.gitignore` 忽略 `dist/`，故 Client bundle 与 protocol dist 不在版本库；
  未 `pnpm run build` 时 Client `exports["./client"]` 指向的 `dist/client.js` 不存在，
  DSH 侧会抛 `MissingClientBundleError`。授权动作中应包含「先构建」这一前置步骤。
- 目标 profile 解析与项目内 workspace 链接**不是同一件事**：项目内 4 条软链已验证，
  但 **profile 能否解析裸包名未验证**，不能假定；如需链接/安装应列入用户授权动作。
- 未输出任何 provider 敏感值。

## 12. A/B 两处缺口复验与最终结论（第十三轮）

### 12.1 稳定快照（已停下，摘要可复现）

| 项 | 值 |
| --- | --- |
| 取摘要 | 连续三次采样，`S2`(`01:22:30`) 与 `S3`(`01:23:15`) 一致；验证后 `T1`(`01:23:54`) 仍相同 |
| 文件数 | **191** |
| `SRC_DIGEST` | `C54D6FB29E0D3028A847A14D2D49313163420D4D2178D9C08B364D8DC0A4B82B` |
| 说明 | 我在快照上跑了 `tsconfig.build.json` 重建 `lib/`，摘要**未变** → 构建确定性成立 |

**产物摘要（供变更单绑定，均为完整 SHA256）**：

| 文件 | SHA256 |
| --- | --- |
| `packages/dsh-gamecenter/cordis.patch.yml` | `9033468FBCBEDDE19CAB03E14623A327BA2AE5B21F82E96E7C083883C566A235` |
| `packages/dsh-gamecenter-client/dist/client.js` | `9CEAC9E0DEF38DBF5882DF48CAA4B734F2DE8F1677879CB0998E4A723AE2A610` |
| `packages/dsh-gamecenter/lib/index.js` | `36A01FBBEB4DA75A698AD6A1B6E9D6ABA210DBA4ADA6A90EED3E5D164BC9CEE9` |
| `packages/protocol/dist/index.js` | `E4C11E5B20F1740F7BFC7EDC57B6CD5AFBE53E8BD13A2EB3D6193F946540AB1D` |

### 12.2 (A) tsc 副作用导入盲区 —— **已消除**

Host 未改用值导入，而是**整个移除**了锚点导入，理由成立（该导入对发现无作用、会多执行一次 Client Host 半）。
我的复核：

| 检查 | 结果 |
| --- | --- |
| `src/index.ts` 是否仍含锚点导入 | **已无** |
| `lib/**/*.js` 外部运行时导入 | **零**（含副作用导入形式一并扫描） |
| `check-lib-deps.mjs` | 退出码 0，输出 `RESULT: PASS — 无白名单外的外部包运行时导入` |

→ 盲区随导入移除而消失：产物不再依赖外部包解析，`tsc` 的沉默不再掩盖任何解析失败。

### 12.3 (B) 测试脚本漏跑 —— **已修，根门禁已覆盖**

| 检查 | 结果 |
| --- | --- |
| `package.json` `test` 脚本 | `node --test "test/*.test.mjs"`（glob） |
| `test/` 实际文件数 | 8（与 glob 一致，不再漏跑） |
| 包内 | **78/78，退出码 0**（原 61） |
| 根 `pnpm run test` | 退出码 0，日志中出现 **`✔ Assert<T extends true> 对不满足协议的类型必须报 TS2344`** |

→ 上一轮指出的「根门禁恰好跳过类型漂移断言」**已闭环**。

### 12.4 Client 侧类型缺陷（Host 报出）—— 复核**已修**

| 检查 | 结果 |
| --- | --- |
| `exports["."]` | `{types:"./lib/index.d.ts", default:"./lib/index.js"}`（已指向 Host 半） |
| `exports["./client"]` | `{types:"./src/types/index.d.ts", default:"./dist/client.js"}`（浏览器半，正确） |
| `lib/index.d.ts` | **存在**，声明 `name` / `apply` / `default`，与 `lib/index.js` 实际导出一致 |
| 负例实测 | 注入 `import { name } from '@dsh-gamecenter/client'` 的 TS 文件 → **退出码 0**（TS2305 已消失，此前为 exit 2） |

### 12.5 最终全量（稳定快照上执行，本人退出码）

| 目标 | 结果 |
| --- | --- |
| Host `tsc -p tsconfig.json` / `tsconfig.build.json` | **0 / 0** |
| Host `node --test test/*.test.mjs` | **78/78**，skipped 0 / todo 0，退出码 0 |
| Client `tsc` | **0** |
| Client `node --test test/*.test.mjs` | **68/68**，skipped 0 / todo 0，退出码 0 |
| Protocol `node --test` | **10/10**，退出码 0 |
| `verify-load-prereqs.mjs` | 仓库根 **12/12** 退出码 0；包目录 **12/12** 退出码 0 |
| `check-lib-deps.mjs` | 退出码 0 |

### 12.6 最终结论

**可以进入真实加载（即可将变更单交付用户审批执行）。**

依据：装载所需的 Node 侧前置条件全部独立复现并通过（发现链闭环 + 删条目负例 + 两目录探针 + 零外部产物导入 + 构建确定性）；
三包 tsc 与单测全绿且零跳过；类型契约有可失败的编译期断言保护；上一轮两处验证缺口 (A)(B) 与 Client 类型缺陷均已闭环。

**但阶段0 仍未通过**：以上全部为 `STATIC`/`BUILD`/`UNIT`/`MOCK`，
**`A0-2`~`A0-7` 保持 `BLOCKED`，无任何 `DSH-REAL` 证据**。
真实装载、`$mount`、Remote 连通、SRC 回退、弹层渲染、关闭拒请求，均须装 profile + 重启 GUI，**须用户授权**。

### 12.7 流程事实（如实记录，不隐去）

本轮验收窗口**两次被实现方写入打断**：

1. Host 工程师于 `00:49`、`00:51` 新增 `tools/probe-profile-resolution.mjs`、`tools/simulate-profile-link.mjs`（上一轮已记录）；
2. Client 工程师于 `01:18:53`–`01:21:00` 新增 `lib/index.d.ts`、`test/fixtures/host-half-types.ts`、`test/host-half-types.test.mjs` 并改动 `package.json`（为修 12.4 的缺陷）。

→ 影响：本轮前两次取样摘要均失效，最终结论以 **`12.1` 的 191 文件稳定快照**为准。
→ 我自身的对照实验产物（`__p1`、`__p2`、`__probe_*`）已全部清理并复查无残留。
→ 建议：修复类写入完成后统一告知验收方再取样，避免反复失效。

## 13. 依赖环已消除 + 快照仍变动（第十四轮）

### 13.1 依赖环：**已消失**（修正 11.6 的记录）

Client 工程师已移除 `@dsh-gamecenter-client` 对 Host 的依赖。实测当前声明：

| 包 | `dependencies` |
| --- | --- |
| `dsh-gamecenter` | `@dsh-gamecenter/client`、`@dsh-gamecenter/protocol` |
| `dsh-gamecenter-client` | **（空）** |
| `protocol` | （空） |

`check-dependency-cycle.mjs` 输出 **`未发现环 / RESULT=PASS —— 无环`**，退出码 0。
→ **11.6 中"声明层环、记为结构债"的记录已过时**：该环现已不存在，无需后续拆除动作。
→ Host 保留 `@dsh-gamecenter/client` 依赖是单向的（作为解析保险），不再构成环。

### 13.2 Client 测试脚本改为显式列表（同一风险模式，当前无漏跑）

`package.json` 的 `test` 现为**显式列出 10 个文件**（不再用 glob）。实测：

| 项 | 值 |
| --- | --- |
| 脚本列出 | 10 |
| `test/` 实际存在 | 10 |
| 漏跑 | **无** |
| 列出但不存在 | 无 |
| `npm test` | **67/67**，退出码 0 |

→ 当前**没有**漏跑，不判缺陷。但这正是我在 12.3 指出的同一风险模式（显式列表会随新增测试文件静默失效），
Host 已改 glob，Client 仍用列表。**建议 Client 一并改为 glob**，或加一条"脚本列出的文件集合 == test/ 实际集合"的守卫测试。

### 13.3 本轮复验退出码（本人执行）

| 目标 | 结果 |
| --- | --- |
| Client `tsc` | **0** |
| Client `node --test test/*.test.mjs` | **67/67**，skipped 0 / todo 0，退出码 0 |
| Client `build-bundle.mjs` | 退出码 0，重建前后 sha 均 `9CEAC9E0DEF38DBF`（**确定性成立**） |
| Client `check-dependency-cycle.mjs` | 退出码 0，**无环** |
| Host `node --test test/*.test.mjs` | **78/78**，skipped 0 / todo 0，退出码 0 |
| 根 `pnpm run test` | 退出码 0（host 78/78、client 67/67） |
| 根 `pnpm run build` | 退出码 0 |
| `verify-load-prereqs.mjs` | **12/12**，退出码 0 |

### 13.4 快照仍在变动（如实记录）

本轮采样期间候选**持续被写入**，摘要多次失效：

| 时间 | 变化 |
| --- | --- |
| `01:24:41`、`01:25:37` | Client 改 `package.json`、`test/discovery-chain.test.mjs` |
| `01:27:55` | Client 改 `tools/check-dependency-cycle.mjs` |
| `01:27:56` | Host 新增 `tools/check-authorization-ready.mjs` |
| `01:28:11`、`01:28:25` | Client `tsc` 重生成 `src/types/**`、重建 `dist/client.js` |

**我复验覆盖到的状态摘要**：`C930B8D9BE5E252166C703CD05E46EBAC65963C65117FD59E3DF94F60D3AD3D7`（**192 文件**）。

→ **该摘要是"复验覆盖到的状态"，不是"冻结候选"**：Host 正在为授权方案新增工具，写入尚未停止。
→ **最终绑定必须在实现方声明停止后重新取样**，我已把此要求写入交接。
→ 就本次复验覆盖到的状态而言：**三个包全绿、零跳过、构建确定性成立、无依赖环、装载前置条件 12/12**。

### 13.5 结论（未变）

**可以进入真实加载（变更单可交用户审批执行）；阶段0 仍未通过。**
`A0-2`~`A0-7` 保持 `BLOCKED`，无任何 `DSH-REAL` 证据。真实装载、`$mount`、Remote 连通、
SRC 回退、弹层渲染、关闭拒请求，均须装 profile + 重启 GUI，**须用户授权**。

## 14. 新增只读工具差异核查与新摘要（第十五轮，应 PM 要求）

PM 要求：完成新增只读工具的差异核查，确认运行代码、配置及产物未变，补记新摘要；
且**不得把验收范围缩成仅四个产物**。本节按此执行。

### 14.1 先更正我自己的一处表述

我在 13.4 把 `tools/check-authorization-ready.mjs` 列为"复验快照之后"的变化，**不准确**：
该文件新增于 `01:27:56`，而我记录的 `C930B8D9` 摘要取自 `01:28:42`（192 文件），**已包含它**。
→ 实际时序：该工具**在快照内**，不是快照后的新增。

### 14.2 差异核查：自 `C930B8D9` 以来唯一的内容变化是**我的报告本身**

| 时间 | 变化 | 性质 |
| --- | --- | --- |
| `01:29:30` | Client `src/types/**/*.d.ts` 重生成 | **产物**，内容确定性 |
| `01:29:30` | Client `dist/client.js` 重建 | **产物**，sha 仍 `9CEAC9E0DEF38DBF` |
| `01:30:26` | `docs/phase0-acceptance.md` | **我自己的验收报告** |

**决定性验证（构建确定性）**：对三个包依次执行 `tsc`（Client typecheck、Host build、Protocol build）
与 `build-bundle`，**重建前后全量源码摘要字节相同**：

```
D0 F3CFD2F142FCE7BDB0C13C502C415FCF4F6B96DB69BAD8B988ED70228F7CFA45 n=192
CLIENT_TSC=0  BUNDLE=0  HOST_BUILD=0  PROTO_BUILD=0
D1 F3CFD2F142FCE7BDB0C13C502C415FCF4F6B96DB69BAD8B988ED70228F7CFA45 n=192
```

→ 结论：**运行代码、配置、产物均未变**；`C930B8D9` → `F3CFD2F1` 的差异**完全由我自己的报告编辑造成**。

### 14.3 绑定产物摘要复核（逐个 MATCH）

| 文件 | 当前 SHA256（前 16） | 与已绑定值 |
| --- | --- | --- |
| `dsh-gamecenter/cordis.patch.yml` | `9033468FBCBEDDE1` | **MATCH** |
| `dsh-gamecenter-client/dist/client.js` | `9CEAC9E0DEF38DBF` | **MATCH** |
| `dsh-gamecenter/lib/index.js` | `36A01FBBEB4DA75A` | **MATCH** |
| `protocol/dist/index.js` | `E4C11E5B20F1740F` | **MATCH** |
| `dsh-gamecenter-client/lib/index.js` | `B551CE10B9378E05` | 稳定 |
| `dsh-gamecenter-client/lib/index.d.ts` | `547D3803A5B757F3` | 与 Client 自报一致 |

### 14.4 新增只读工具安全性核查

| 工具 | 字节 | 写操作/外部命令 | 判定 |
| --- | --- | --- | --- |
| `tools/check-authorization-ready.mjs` | 5201 | **0 处** | **只读**，符合声明 |
| `tools/probe-profile-resolution.mjs` | 1863 | **0 处** | 只读 |
| `tools/simulate-profile-link.mjs` | 3558 | 3 处，目标为 `os.tmpdir()` 沙箱（`mkdtempSync` + `rmSync` 清理），**不触真实 profile、不写仓库** | 安全 |

另核实：`tools/` 下 18 个文件中**无一是 `lib/`、`dist/` 产物**；`host lib` 对
`check-authorization-ready` 的引用次数为 **0**，即工具内容不进运行代码。

### 14.5 新摘要（补记，作为本轮绑定基线）

| 口径 | 文件数 | SHA256 |
| --- | --- | --- |
| **全量源码摘要**（含我的报告） | **192** | `F3CFD2F142FCE7BDB0C13C502C415FCF4F6B96DB69BAD8B988ED70228F7CFA45` |
| **候选源码摘要**（排除我的验收报告自身，避免自指变动） | **191** | `47023A17FAB34506CE76E976175CBD1D055D7E311E97536EBADF5D9B58616113` |

**绑定口径（按 PM 要求，不缩范围）**：
1. **候选源码摘要**（上述 191 文件）——证明除验收报告外整棵树未变；
2. **全部绑定产物摘要**（14.3 六项）——授权执行时必须复用同一产物；
3. 任一摘要不匹配即说明代码已变，须重新验收。
→ 我**不采纳**"仅以四个产物为准、源码摘要仅作参考"的口径：源码摘要同样绑定，
只是排除我自己那份会随本报告更新而变化的文件，避免自指干扰。

### 14.6 本轮复验退出码（本人执行）

| 目标 | 结果 |
| --- | --- |
| Client `tsc` / `build-bundle` | **0 / 0** |
| Client `node --test` | **67/67**，零跳过 |
| Host `node --test` | **78/78**，零跳过 |
| Protocol `node --test` | **10/10** |
| `verify-load-prereqs.mjs` | **12/12**，退出码 0 |
| `check-dependency-cycle.mjs` | 退出码 0，**无环** |
| 三包重建 | **摘要字节不变**（确定性成立） |

### 14.7 结论（未变）

**可以进入真实加载，变更单与授权方案可交用户审批执行；阶段0 仍未通过。**
`A0-2`~`A0-7` 保持 `BLOCKED`，无任何 `DSH-REAL` 证据。
授权执行时建议保留可完整回滚路径，并在重启后按 11.8 的观察点逐项取证。

## 15. 最终冻结快照与绑定口径（第十六轮）

实现方已声明**停止写入**。我据此刻取冻结快照，并按 PM 要求确定绑定口径。

### 15.1 冻结确认（三次采样一致）

| 采样 | 时间 | 摘要 | 文件数 |
| --- | --- | --- | --- |
| S1 | `01:35:21` | `71DA59FE…E1F0DE8` | 192 |
| S2 | `01:36:11` | `71DA59FE…E1F0DE8` | 192 |
| S3 | `01:36:51` | `71DA59FE…E1F0DE8` | 192 |

→ 跨约 90 秒三次完全相同，**树已冻结**，可作绑定基线。

### 15.2 绑定口径（**不缩范围**，按 PM 要求）

Host 建议"以 4 个产物摘要为执行绑定、源码摘要仅作参考"。**我不采纳**——
PM 明确要求不得把验收范围缩成仅四个产物。实际绑定三组：

| 组 | 范围 | 文件数 | SHA256 |
| --- | --- | --- | --- |
| **BIND-A 运行源码** | `packages/**` 全部 | **180** | `7C573CE784A35FC3089667186A37C4A93E898D3661290F446BF409F55FBB683E` |
| **BIND-B 根配置** | `.gitignore`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json`（**排除 `docs/`**） | **5** | `64B5DFF44514597637232F3E24EE5B244B6588D072219BBB6E3F573B380CA5D7` |
| **BIND-C 产物** | 见 15.3 | 6 | 逐个 SHA256 |

**全量参考值**（含 `docs/`，仅供交叉核对）：`71DA59FE6466D078FF87F7150F5BABE5B232237FEDA95F2B5CBE73FCEE1F0DE8`，192 文件。

**为什么 BIND-B 排除 `docs/`**：`docs/` 是文档，不在装载路径内；且 `phase0-acceptance.md`（本报告）会随验收持续更新，
若纳入绑定会造成自指变动。**排除的只是文档，未排除任何可执行代码或配置**——`packages/**` 与根配置全部在绑定内。
`docs/` 各文件当前摘要另记于 15.4，供完整性核对，不作为执行门禁。

### 15.3 BIND-C 产物摘要（授权执行必须复用同一产物）

| 文件 | SHA256（前 16） | 状态 |
| --- | --- | --- |
| `dsh-gamecenter/cordis.patch.yml` | `9033468FBCBEDDE1` | MATCH |
| `dsh-gamecenter/lib/index.js` | `36A01FBBEB4DA75A` | MATCH |
| `dsh-gamecenter-client/dist/client.js` | `9CEAC9E0DEF38DBF` | MATCH |
| `dsh-gamecenter-client/lib/index.js` | `B551CE10B9378E05` | 稳定 |
| `dsh-gamecenter-client/lib/index.d.ts` | `547D3803A5B757F3` | 稳定 |
| `protocol/dist/index.js` | `E4C11E5B20F1740F` | MATCH |

### 15.4 `docs/` 当前摘要（完整性参考，非门禁）

| 文件 | SHA256（前 16） |
| --- | --- |
| `docs/gamecenter-design.zh-CN.md` | `F89EF05DABF6A725` |
| `docs/phase0-architecture.md` | `6FD6A0472579FE3B` |
| `docs/phase0-build-facts.md` | `644368FF073AC95E` |
| `docs/phase0-client.md` | `CBC69E8E9EA6C674` |
| `docs/phase0-host.md` | `51E9E1CD2FC7E7FE` |
| `docs/root-config-registry.md` | `A471D4E663866D49` |
| `docs/phase0-acceptance.md` | `B53DCB98B969893E` |

### 15.5 执行门禁（授权后逐项核对）

任一不匹配即说明代码已变，**须重新验收，不得带病执行**：
1. BIND-A `packages/**` 摘要 = `7C573CE7…FBB683E`；
2. BIND-B 根配置摘要 = `64B5DFF4…380CA5D7`；
3. BIND-C 六个产物摘要逐个匹配。

### 15.6 结论（未变）

**可以进入真实加载，建议用户批准执行；阶段0 仍未通过。**
`A0-2`~`A0-7` 保持 `BLOCKED`，无任何 `DSH-REAL` 证据。
改动真实 profile 与重启 GUI 属用户授权范围，**我无权代批**；
执行后由我按 11.8 观察点取证，届时才可能首次产生 `DSH-REAL`。

## 16. A/B/C 执行独立复核 + 取证通道缺口（第十七轮）

### 16.1 我的独立复核结果（未采信转述，全部实测）

| 项 | 预期 | 我实测 | 判定 |
| --- | --- | --- | --- |
| BIND-A `packages/**` | `7C573CE7…FBB683E` / 180 | **同值 / 180** | **MATCH** |
| BIND-B 根配置 5 文件 | `64B5DFF4…380CA5D7` | **同值 / 5** | **MATCH** |
| 六产物摘要 | 见 15.3 | **逐个 MATCH，不符数 0** | **MATCH** |

→ 确认 Host 的说法成立：授权构建**只刷新了 mtime，内容未变**，绑定未被破坏。

### 16.2 profile 实际状态复核（只读）

| 项 | Host 报告 | 我实测 | 判定 |
| --- | --- | --- | --- |
| `package.json` sha | `4AA2223BFC0E4C50…` | **同值** | MATCH |
| `cordis.patch.yml` sha | `F7411138A112DFA4…`（未改） | **同值** | MATCH |
| 备份 `package.json.bak-gamecenter-2026101907` | `788BDECBC3717258…` | **同值**，1007B | MATCH |
| 备份 `cordis.patch.yml.bak-…` | `F7411138…` | **同值**，4572B | MATCH |
| 既有 3 个旧备份 | 未被覆盖 | `bak2` / `bak-final` / `bak-lanbind` **均在** | 成立 |
| junction 类型 | Junction | `LinkType=Junction`，两目标均含 `package.json` | 成立 |
| 编辑最小性 | +1 行 | **无 BOM、LF 换行、JSON 合法、bundles 16、末项 `@dsh-gamecenter/host`、无重复** | 成立 |
| profile 解析裸包名 | 现在可解析 | `host → …\lib\index.js`、`client → …\lib\index.js` | 成立 |

→ **A/B/C 三步执行正确，未发现越界或多余改动。**

### 16.3 发现的缺口：观察点 ① 没有取证通道（**必须在重启前解决**）

Host 的方案把「stderr 有无 `skipping profile bundle`」列为第一手证据。我实测**该通道不存在**：

| 检查 | 结果 |
| --- | --- |
| `~/.dsh/logs/` | 只有 `vision-router/`，**无 DSH 启动日志** |
| `~/.dsh/desktop-launcher/launcher.ps1` | `Start-Process -WindowStyle Hidden`，**不重定向 stdout/stderr** |
| `.dsh` 下 07:00 后修改的文件 | 仅 `profiles/desktop/package.json`、`remote-web-ui-devices.json`、`skin-center-active.json`，**无装载记录** |

→ **结论**：DSH 桌面版是 GUI 进程，stderr 无落盘、无控制台。重启后
`skipping profile bundle` **不会被任何地方记录**，观察点 ①（以及 ⑥ 的浏览器 console）**默认不可取证**。

**这直接影响门禁有效性**：若只按原方案执行，重启后将拿不到 ①，而 ① 恰恰是"bundle 是否被静默跳过"的唯一直接信号
——这正是 Host 自己在 patch 注释里写的"静默跳过、界面表现为什么都没发生"。

**建议（重启前决定）**：
- **方案甲（首选，能保住 ①）**：用户从**终端**启动 DSH 并把输出重定向到文件，
  例如 `& "<安装目录>\DeepSeek Harness.exe" *> "<日志路径>\dsh-launch.log"`；
  之后我即可从该文件读取 ① 与 Electron 主进程日志。
  代价：这一次启动方式与平时不同，需用户接受。
- **方案乙（不改启动方式）**：放弃 ①，把**② `pluginInventory` / `fiberPhase`** 提为一级门禁
  （bundle 被跳过则不会 active），并以 ⑤ 侧栏入口截图、④ 服务认领状态作为交叉证据。
  代价：静默跳过若发生，定位信息弱于 stderr。

**我倾向方案甲**：一个文件重定向的成本，换来唯一直接信号；否则一旦"什么都没发生"，
只能靠排除法，而这正是 Host 担心难以排查的场景。

### 16.4 我自身的取证限制（必须声明）

**我也运行在将被重启的这个 DSH 实例内**，重启会终止我的会话。因此：
- 我**无法**在应用关闭后执行采集或回滚；
- 重启后的证据必须在**新会话**中读取，且只能读**已落盘**的东西（方案甲日志、UI 截图）；
- 回滚不依赖重启（config 未生效前），但**只有用户或新会话**能执行。

→ 执行前须明确：**重启后的取证责任人是谁**。若无人取证，本次授权只会得到"应用能启动"这一弱结论。

### 16.5 结论

**A/B/C 执行正确，profile 已具备加载条件；但重启前需先决定 ① 的取证方案。**
`DSH-REAL` 仍为 **0 条**，阶段0 未通过，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 17. 按原算法重算门禁 + 流程偏差记录（第十八轮，应 PM 要求）

### 17.1 按**同一算法**重算（PM 明确要求，不接受等价证明）

我用与 15.2 完全相同的算法（全量文件按相对路径排序 → `路径|SHA256` 逐行拼接 → 对拼接串取 SHA256）
在**授权构建与 profile 修改之后**重新实算：

| 组 | 预期（冻结值） | 本次实算 | 判定 |
| --- | --- | --- | --- |
| BIND-A `packages/**` | `7C573CE7…FBB683E` / 180 | **`7C573CE784A35FC3089667186A37C4A93E898D3661290F446BF409F55FBB683E` / 180** | **MATCH** |
| BIND-B 根配置 5 文件 | `64B5DFF4…380CA5D7` / 5 | **`64B5DFF44514597637232F3E24EE5B244B6588D072219BBB6E3F573B380CA5D7` / 5** | **MATCH** |
| BIND-C 六产物 | 见 15.3 | 逐个 MATCH，不符 0 | **MATCH** |

→ **门禁全部通过**。Host 声称的"内容未变、仅 mtime 变化"**经原算法验证成立**。

### 17.2 mtime 变化的精确分类（补足证据）

自冻结时刻 `01:36:51` 起，`packages/` 下有 **52** 个文件 mtime 变化，全部是授权构建产生的**产物**：

| 目录 | 数量 |
| --- | --- |
| `*/dist/**` | **31** |
| `*/lib/**` | **21** |
| **`src/`、`tools/`、`test/`、`package.json`、`tsconfig*`** | **0** |

→ 无任何源码或配置被写入；且 BIND-A 内容摘要 MATCH，**证明这 52 个文件是纯 mtime 变化（字节未变）**。

### 17.3 流程偏差（按 PM 要求记录）

**偏差成立**：A/B/C 中**修改真实 profile 配置（C 步）发生在门禁原算法重算之前**。
Host 当时采用的是「冻结后零写入 + 文件数一致 + 六产物 MATCH」的**等价证明**，
并在文字中**如实标注了这是等价证明、非同一算法复算**——标注诚实，但**不等同于通过既定门禁**。

**处置**：
1. 现已由我**按原算法补算，结果 MATCH**，故本次变更在**实质上**未越界，**不要求回滚**；
2. 但**顺序偏差已记录**：正确顺序应是「先按原算法复算门禁 → 通过 → 再改配置」；
3. 后续若再有 profile/配置类变更，**必须先复算门禁并给出原算法结果**，等价证明只能作为辅助，不能替代。

### 17.4 重启前仍未解决的一项（重申，未获回应）

16.3 指出的 **观察点 ① 无取证通道**（`~/.dsh/logs` 无启动日志、launcher 不重定向）、
以及 16.4 的 **取证责任人未明确**，**至今无答复**。
→ 这两项若不决定，重启后可得的证据将只剩 UI 侧观察，**静默跳过将无法定位**。
→ 我不因此否决重启，但**必须在重启前由 PM 或用户指定方案与责任人**。

### 17.5 结论

**门禁通过（原算法），可以重启。** 但重启前应先定下 ① 的取证方案与取证责任人。
`DSH-REAL` 仍为 **0 条**；阶段0 未通过，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 18. 取证通道定论与门禁修订（第十九轮）

### 18.1 我收回 16.3 的"方案甲"（自我更正）

我独立验证了 Host 的机制结论（用只读工具 `asar-grep` 直接检索 `app.asar/lib/main.js`，len=513441）：

| 检查 | 实测 |
| --- | --- |
| `process.stderr` 命中数 | **0** |
| 子进程 `stdio` | `["ignore","pipe","pipe","ipc"]` |
| stderr 去向 | `child.stderr.on("data")` → `this.stderr = (this.stderr + chunk).slice(-65536)`（**64KB 内存缓冲**） |
| stdout 去向 | `child.stdout?.pipe(process.stdout)`（**仅 stdout 转发**） |

→ **结论：子进程 stderr 永不转发、永不落盘。**
→ **我 16.3 提出的"方案甲（终端重定向启动）"对 ① 无效**——重定向只能拿到 Electron 主进程 stdout（内含子进程 stdout），**拿不到子进程 stderr**。
→ **该建议作废，明确不采纳**。这是我自己的一次判断失误，记录在案。
→ 唯一能见 ① 的情形：子进程**非零退出**时，其 stderr 尾巴被拼进错误信息。

### 18.2 接受修订门禁：「四项排除 + 正向信号」

`dsh-app-boot` 导致 profile bundle **静默跳过**的条件经 Host 逐条核实，我复核认可其存在性与路径
（② 缺 `dsh.bundle` 的 `:1023-1024` 与 `skippedBundles` 的 `:1035-1040` 我在第 8 节已独立实读）：

| 条件 | 判定方式 | Host bundle |
| --- | --- | --- |
| ① `resolveBundleDir` 解析不到 | 复刻 `packageDirFromAnchor` | PASS（解析到 `packages/dsh-gamecenter`） |
| ② 缺 `dsh.bundle` | 读 `package.json` | PASS（`dsh.bundle.patch` 存在） |
| ③ `engines.dsh` 不满足 | `unmetRequirements` | PASS（`>=0.2.1-rc.2 <0.3.0` vs 运行时 `0.2.1-rc.2`） |
| ④ patch 形状非法/缺失 | `loadOverlayPatches` | PASS（含两条 Loader 条目） |

**我接受把主门禁改为正向信号**：`ctx.get('gameCenter')` 存在、`typertRemote.namespace === 'gameCenter'`、
`claimsEndpoint('gameCenter/handshake') === true`——这些只有插件真被装载并执行 `apply()` 才为真。

**但必须写明两条限制（我的验收口径）**：
1. **排除法不等于证明**：四项不成立说明"按已知跳过路径不会被跳过"，**不等于"不存在其它跳过路径"**。
   若重启后应用正常启动而正向信号全假，即说明存在未覆盖路径，届时另申请诊断手段。
2. **正向信号需要可执行的观察通道**。我能亲自获得的通道为：
   - **UI 侧（可截图）**：DSH 存在插件管理/插件清单界面（`dsh-client-ui-settings-plugin-inventory`、
     `dsh-client-ui-plugin-manager`、`dsh-host-plugin-inventory`），可观察 Host 插件是否被装载及其状态；
   - **UI 侧（可截图）**：侧栏「游戏中心」入口是否在技能中心之后；点击后弹层是否渲染；
     以及弹层内**只读**模型目录是否可取出（若经由 Remote 取到，即同时证明 Host 服务与 Client 挂载）。
   - **我无法直接求值**：`ctx.get('gameCenter')`、`claimsEndpoint(...)` 属运行实例内部状态，
     我**没有**直接查询它们的工具通道。若无人提供通道，这两项应记为**"无法观察"，而非"通过"**。

→ 请 Host 明确：**重启后由谁、用什么命令或界面求值 ②③④ 三项正向信号**。
   若有通道，我按其步骤取证；若无，我按第 2 条把它们标为"无法观察"，只用 UI 侧证据下结论。

### 18.3 结论

**门禁通过（原算法）且 ① 已定论（结构性不可得），可以重启。**
重启后由我主责取证，取证对象：插件装载状态、侧栏入口位置、弹层渲染、Remote 实际行为（全程只读、不调模型）。
`DSH-REAL` 目前仍为 **0 条**；阶段0 未通过，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 19. ① 取证缺口关闭：独立复现装载重放（第二十轮）

Host 提出用 `ELECTRON_RUN_AS_NODE` + 实装同版本 `dsh-app-boot` 在真实 profile 上重放装载路径。
**我不采信转述，自己独立复现**，并记录一处 Host 报告未显示的要点。

### 19.1 方法与独立复现结果

`DeepSeek Harness.exe` 在 `ELECTRON_RUN_AS_NODE=1` 下为 **Node v24.21.0**，
且其 fs **可读 app.asar 内部**（普通 node.exe 不行）。据此 `require` 到实装同版本
`@deepseek-ai/dsh-app-boot@0.2.1-rc.2`（导出含 `loadProfileDirectory`、`reportSkippedBundles`、`resolveBundleDir`），
对**真实 profile** 调用 `loadProfileDirectory()` 读取真实返回值。**我实跑，exit 0**：

| 锚点（`installAnchor`） | layers | skipped | host 在 layers | host 在 skipped | 末层 | patchPaths 经 junction | insert 条目 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `app.asar/dsh/package.json`（**dsh 运行时**，正确） | **16** | **0** | **是** | **否** | `@dsh-gamecenter/host` | **是** | `gamecenter-host` / `gamecenter-client` |
| `app.asar/package.json`（桌面外壳） | 12 | 4 | 是 | 否 | `@dsh-gamecenter/host` | 是 | 同上 |

**与 Host 报告一致**：正确锚点下 `layers=16 / skipped=0`、`host_in_layers=true`、`host_in_skipped=false`、
`last_layer=@dsh-gamecenter/host`、`patchPaths` 走
`…\profiles\desktop\node_modules\@dsh-gamecenter\host\cordis.patch.yml`、
两条 Loader 条目确由我们的 patch 产出。

### 19.2 我补充的一处要点（Host 报告未显示）

**锚点选择会改变结论。** 用桌面外壳锚点时 `skipped=4`（`@deepseek-ai/dsh-web-app` 版本不兼容
`0.1.5-rc.2` vs `0.2.1-rc.2`，另三个在该锚点下解析不到）。这**不是缺陷**——桌面 Host 子进程的解析锚点是
dsh 运行时包，用外壳锚点属**用错参数**。
→ 记录原因：**后续任何人复跑都必须用 `app.asar/dsh/package.json` 作锚点**，
否则会看到 `skipped=4` 而误判为"有 bundle 被跳过"。

### 19.3 只读性核验

| 检查 | 结果 |
| --- | --- |
| 重放前后 profile `package.json` / `cordis.patch.yml` 摘要 | **`4AA2223BFC0E4C50` / `F7411138A112DFA4`，未变**（`PROFILE_UNCHANGED=true`） |
| profile 目录 07:35 后新增文件 | **无** |
| 仓库内我的临时文件 / 探针残留 | **无**（脚本均在 `%TEMP%`，已删除） |
| BIND-A `packages/**` | `7C573CE784A35FC3…`，180 文件，**MATCH** |
| BIND-B 根配置 | `64B5DFF445145976…`，5 文件，**MATCH** |

→ 该重放**未写 profile、未写仓库**，可安全重复执行。

### 19.4 证据分栏与缺口结案

- 该证据记作 **`DSH-BOOT-REPLAY`**（用实装同版本代码在真实输入上重放），
  **与 `DSH-REAL`（运行中 GUI 实测）严格分开**。
- **① "静默跳过"缺口就此关闭**：在真实 profile 与真实 app-boot 上，`skippedBundles` 为 0，
  Host bundle 确实进入 `layers`——这是**实测**而非排除法推断。
- **仍未证明**（必须留给重启后）：Loader 是否真把两条条目挂成可运行插件（fiber active）、
  `$mount` 是否接受 contribution、`ctx.remote.gameCenter.*` 是否连通、
  `resolveDescriptor` 的 SRC 回退、侧栏/弹层渲染、关闭后拒请求。

### 19.5 结论

**门禁通过、① 已由重放实测关闭，可以重启。** 重启后由我主责取证（UI 侧 + 插件装载状态，全程只读、不调模型）。
`DSH-REAL` 仍为 **0 条**；阶段0 未通过，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 20. 我方观察通道实测：GUI 侧我同样看不到（第二十一轮）

Host 已诚实回答"三项内部状态无可执行通道"。我进一步**实测了我自己的 GUI 观察能力**，
结论同样是否定的——这直接决定重启后的取证方案，必须写清。

### 20.1 逐条实测（全部为否定结果）

| 通道 | 实测 | 结论 |
| --- | --- | --- |
| `/api` 鉴权 | `POST /api`、`GET /api`、`GET /` **均 401**（我独立复跑，与 Host 一致） | 无凭据，不可用 |
| 桌面窗口无障碍树 | `screen_read` 只返回窗口边框三个按钮，内容全为空 `Pane` | Electron 渲染在 web 视图内，**无 a11y 通道** |
| 窗口截图 | `screen_shot` 返回图片，但传输层提示图片被省略（transport 不支持图像） | **我看不到图像** |
| OCR | `screen_find` 返回 **`OCR available: false`** | 不可用 |
| 浏览器面板 | `read_browser` 返回"面板未打开；需用户在聊天顶部打开并加载页面" | 需用户操作，当前不可用 |
| 落盘的插件清单/装载状态 | 搜遍 `.dsh`（排除 sessions/bot/attachments/logs）：`fiberPhase`、`pluginInventory`、`gamecenter-host` **零命中**；`logs/` 仅 vision-router | **无落盘通道** |

→ **结论：重启后我无法自行观察 UI**（侧栏入口、弹层渲染、插件清单），也无法求值 Cordis 内部状态。

### 20.2 因此接受的证据分级（采纳 Host 的 `derived` 标注）

| 观察项 | 谁/以何种方式取证 | 分栏 |
| --- | --- | --- |
| bundle 是否进入 layers、两条 Loader 条目 | `DSH-BOOT-REPLAY`（我已独立复现，exit 0） | **`DSH-BOOT-REPLAY`**（非 `DSH-REAL`） |
| 插件是否装载、`fiberPhase=active` | **需用户目视**（插件清单界面） | 用户观察 → 可记 `DSH-REAL` |
| 侧栏「游戏中心」是否在技能中心之后 | **需用户目视** | 用户观察 → 可记 `DSH-REAL` |
| 弹层是否渲染、弹层内只读取到模型目录 | **需用户目视** | 用户观察 → 可记 `DSH-REAL` |
| `ctx.get('gameCenter')` / `namespace` / `claimsEndpoint` | 无通道 | **`无法直接求值（derived）`**，不得记通过 |

**推断链（采纳，但标注为推断）**：`apply()` 内服务构造无条件 ⇒ `fiber=active` ⇒ 服务已注册 ⇒ `namespace` 为常量成立；
若弹层**经 Remote 成功取回模型目录**，则一条即覆盖「端点被认领 + `$mount` 被接受 + Host 服务可达」。
→ 推断结论**只能标注为 derived，不能等同于直接测量**。

### 20.3 重启后取证方案（用户为观察主体）

1. **用户目视**并按固定四问回报：① 侧栏是否出现「游戏中心」，且紧邻技能中心之后；② 点开后弹层是否正常渲染；
   ③ 弹层内是否能看到模型列表（**只读，不点任何会调用模型的按钮**）；④ 技能中心本身是否仍完好可用。
2. **可选增强**：用户打开我的浏览器面板并加载 GUI，我再尝试用 `read_browser` 读 DOM——
   若该面板带同源会话，我就能拿到**第一手 DOM 级证据**，不再依赖转述。
3. 我负责：重启后在新会话核对进程命令行、绑定摘要、以及按 20.2 汇总分栏，**明确哪些是直接测量、哪些是推断、哪些无法观察**。

### 20.4 结论

**门禁通过、① 已由重放实测关闭，可以重启。**
但必须说明：**重启后若无用户目视回报，本次授权只能得出"应用能启动 + profile 不跳过"这一弱结论**，
`fiber`/`$mount`/UI/关闭拒请求仍无法取证。`DSH-REAL` 仍为 **0 条**；阶段0 未通过，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 21. 回滚命令安全性实测 —— 发现原命令会失败（第二十二轮）

回滚会在「应用起不来、Bot 全部失联」时由用户独自执行，因此我**在临时目录隔离实测**了命令本身。
**发现：Host 给出的 `Remove-Item` 写法在非交互执行下失败，junction 不会被删除。**

### 21.1 实测：三种写法的结果

隔离沙箱：建 `target`（含 `SENTINEL.txt`）+ 真 junction，逐一测试删除：

| 写法 | 结果 | junction 是否删除 | 目标是否受损 |
| --- | --- | --- | --- |
| `Remove-Item "<junction>" -Force`（**原命令**） | **抛错**：`Windows PowerShell 处于非交互模式。朗读和提示功能不可用` | **否（残留）** | 未受损 |
| `Remove-Item "<junction>" -Force -Confirm:$false` | **同样抛错** | **否（残留）** | 未受损 |
| **`cmd /c rmdir "<junction>"`** | **成功** | **是** | **未受损（SENTINEL 仍在）** |

→ 原因：PS 5.1 对"含子项的目录"删除会走确认提示，非交互环境下直接失败；`-Confirm:$false` 也绕不过该提示。
→ **`cmd /c rmdir`（不带 `/S`）只摘除 junction 本身，不递归目标**，这是可靠写法。

### 21.2 修正后的回滚命令（已端到端验证）

我在隔离沙箱完整模拟了一次真回滚（2 个 junction + 父目录 + 被改的 `package.json` + 备份）：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
cmd /c rmdir "$p\node_modules\@dsh-gamecenter\host"
cmd /c rmdir "$p\node_modules\@dsh-gamecenter\client"
cmd /c rmdir "$p\node_modules\@dsh-gamecenter"
Copy-Item "$p\package.json.bak-gamecenter-2026101907" "$p\package.json" -Force
```

**模拟结果（全部通过）**：两个 junction 与父目录被移除；`node_modules` 本身保留（属 profile 自有目录）；
`package.json` 恢复为改前内容；**仓库目标完好**（`host`/`client` 的 `package.json` 均存在，未被递归删除）；备份文件保留。

**明确禁令**：**不要给 `Remove-Item` 加 `-Recurse`**。Windows 上对 junction 递归删除存在删穿目标的数据丢失风险，
而本流程**不需要**递归——只摘链接。

### 21.3 结论

**原回滚命令不可直接依赖**，已给出实测可用的替代写法（21.2）。
其余不变：门禁通过、① 已由重放关闭、可以重启。
`DSH-REAL` 仍为 **0 条**；阶段0 未通过，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 22. 重启后首次实机取证（第二十三轮）—— **取得首批 DSH-REAL 证据**

### 22.1 重启已确认（**直接观察 / 进程级**）

| 项 | 实测 |
| --- | --- |
| DSH 进程启动时间 | **全部 07:59:56**（此前主进程 23864、Host 子进程 32684）→ **确已重启** |
| 运行中 Host 子进程 | PID **30996**，`--expose-internals …\dsh-desktop-host\lib\index.js` |
| 其命令行 profile 参数 | `…\resources\app.asar\dsh" <PROFILE_DIR> "…\runtime\primary-runtime"` |
| 含义 | **重启后确实以我们改过的 desktop profile 为解析根**——`DSH-BOOT-REPLAY` 的前提在真实运行中成立 |

重启后 profile 未被再改动：`package.json` = `4AA2223BFC0E4C50`、`cordis.patch.yml` = `F7411138A112DFA4`、junction 仍 2 个。

### 22.2 **无障碍树在重启后可读**（更正 20.1）

重启后 `screen_read` 返回**完整元素树**（弹层打开时 62 个元素；界面无弹层时 500 个）。
→ **我 20.1 记的"无 a11y 通道"已过时，现予更正：我有真实 UI 观察通道。**

**直接观察到的侧栏「全局面板」列表（顺序即渲染顺序）**：

| 位置 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | Button「插件」 | (316,250) |
| 2 | Button「自动化任务」 | (316,290) |
| 3 | **Button「技能中心」** | (316,330) |
| 4 | Button「记忆系统」 | (316,370) |
| 5 | **Button「游戏中心」** | (316,410) |

→ **直接观察结论**：
1. 「游戏中心」入口**确实存在**，且与技能中心**同属「全局面板」同一组**；
2. **技能中心原入口完好保留**（未被替换、未被遮挡），满足用户"保留技能中心"的要求；
3. **但不是紧邻技能中心的下一项**：`记忆系统` 位于两者之间（第 3、4、5 位）。
   这是**事实偏差**，是否接受由 PM/用户判定；成因是排序号 30 与 31 之间还插入了记忆系统。

**直接观察到的弹层（当时处于打开状态）**：

| 元素 | 内容 |
| --- | --- |
| Window「游戏中心」 | 600x196 @ (651,418) |
| Text | 「阶段0 探针：验证 DSH 内可打开弹层，且关闭按钮 / Escape / 遮罩 / 返回列表都走同一个 requestPause。」 |
| StatusBar + Text | 「当前没有运行中的游戏。」 |
| Button「返回列表」 | (1067,558) |
| Button「关闭」 | (1169,558) |

→ **直接观察结论**：**弹层确实渲染**，含标题、说明、空状态文案与两个关闭入口按钮；
与用户贴出的文字**完全一致**，两边互相印证。

### 22.3 证据四分类（按 PM 要求）

| 类别 | 内容 |
| --- | --- |
| **直接观察（我）** | 重启发生、profile 参数为 desktop、侧栏 5 项顺序、技能中心保留、弹层渲染及其文案/按钮、`/api` 仍 401 |
| **用户报告** | 用户贴出同样的弹层文字 → 与我的直接观察一致 |
| **推断（derived）** | 弹层由 Client 插件渲染 ⇒ Client 插件**已装载**；`apply()` 内服务构造无条件 ⇒ `fiber=active` ⇒ Host 服务已注册、`namespace==='gameCenter'` |
| **未验证** | ① `关闭`/`返回列表`/`Escape`/`遮罩` 是否都归一到 `requestPause`；② **Remote 连通性**——空状态界面**未展示模型目录**，无法证明端点被认领；③ 有运行实例时的拒请求；④ `ctx.get('gameCenter')`/`claimsEndpoint` 直接求值 |

### 22.4 交互测试受阻（如实记录）

两次尝试用无障碍树交互（点`关闭`、点侧栏`游戏中心`）均被拒，原因均为
**"accessibility tree changed since observation"**——因为**用户正在同时操作同一界面**。
→ 为避免与用户互相干扰，**我停止自动点击**，不强行重试。
→ 关闭路径的实操改由用户进行（用户本就在机器前，PM 已请其试 Escape/关闭）。

### 22.5 最小补齐建议（交 PM，不绕到阶段1）

**问题**：空状态弹层只显示「当前没有运行中的游戏」，**不展示模型目录**，
因此 `$mount` 是否被接受、端点是否被认领、Host 服务是否可达**在 UI 上不可观察**，
而这三项恰是本阶段最关键验收点。

**最小补齐（Client 侧，建议纳入阶段0 收尾）**：在弹层内增加**只读**的「模型目录」区域（空状态也显示），
内容为经 Remote 调用 `gameCenter.modelCatalog` 拿到的脱敏目录，并显示三态之一：
`已连通（N 个模型）` / `未连通（code>）` / `加载中`。
→ 一条 UI 观察即可同时证明**端点被认领 + `$mount` 被接受 + Host 服务可达**，且**只读、不触发模型调用**。
→ 代价：一小块只读 UI 与一次目录读取，**不扩大阶段范围**。

### 22.6 结论

**阶段0 仍未通过，但已取得首批 `DSH-REAL` 直接证据**：
`A0-2`（Host 加载）与 `A0-3`（Client 显式装配）具备**强直接观察证据**（入口出现在侧栏、弹层渲染）；
`A0-4`（Remote 往返）、`A0-5`（不覆盖既有 overlay）、`A0-6`（目录脱敏）、`A0-7`（关闭后拒请求）**仍无直接证据**。
→ 下一步：**用户手动完成四条关闭路径并回报**；同时按 22.5 补只读目录区以打通 A0-4/A0-6 可观察性。

## 23. 绑定值更正 + 当前代码复测 + 窗口交接（第二十四轮）

### 23.1 必须更正：Client 在**重启前 13 秒**改过文件，旧绑定值已失效

我在准备交出编辑窗口、取"编辑前快照"时发现 **BIND-A 不再匹配**。逐一定位：

| 文件 | mtime | 说明 |
| --- | --- | --- |
| `src/ui/GameCenterOverlay.js` | **07:57:15**（174 行） | 已改动 |
| `src/index.js` | **07:59:43** | 已改动 |
| `dist/client.js` | **07:59:43**（27307 字符） | 已重新打包 |

而 GUI 重启发生在 **07:59:56**——即**改动与重建完成后 13 秒就重启了**。

| 项 | 旧绑定值 | **当前值** |
| --- | --- | --- |
| BIND-A `packages/**` | `7C573CE7…`（180） | **`1F93CD1496C3DC7E…`（180）** |
| `dist/client.js` | `9CEAC9E0DEF38DBF` | **`1A5B9875F06ADE8B`** |
| BIND-B 根配置 | `64B5DFF4…` | **未变（MATCH）** |
| 其余五个产物 | — | **未变**（patch `9033468F`、host lib `36A01FBB`、client lib `B551CE10`、client dts `547D3803`、protocol `E4C11E5B`） |

→ **我 22 章以前"BIND-A MATCH"的结论对应的是更早的状态，现予更正**：当前运行中的 Client 代码是 07:57–07:59 那版。
→ **偏差记录**：这批改动发生在"门禁复算通过"之后、"重启"之前，**未再经门禁复算**。按既定口径，绑定值必须随之一并更新，而不是沿用旧值。

### 23.2 当前代码复测（本人实测）

| 目标 | 结果 |
| --- | --- |
| Client `tsc -p tsconfig.json` | **0** |
| Client `node --test test/*.test.mjs` | **69/69**，skipped 0 / todo 0，退出码 0（此前 67 → **+2**） |
| `build-bundle.mjs` | 退出码 0，重建前后 sha 均 `1A5B9875F06ADE8B`（**确定性成立**） |

→ Host / Protocol 产物摘要未变，**第 12 章对 Host（78/78）与 Protocol（10/10）的结论仍然有效**。

### 23.3 诊断区**尚未实现**（独立确认 Host 的判断）

`src/ui/GameCenterOverlay.js` 实测：**不含** `remoteState`、**不含** `modelCatalog`、**不含**任何「已挂载/诊断」字样，全文 174 行。
→ 与 Host 的判断一致：**当前弹层是静态占位，不能作为 Remote 证据**；我在 22.3 已把"UI 装配已观察 / Remote 未观察"**分列**，未合并。

### 23.4 窗口交接与重建/重载的技术边界（回答 Host 三问）

1. **旧 UI 验收窗口：已结束。** 该窗口要测的是占位弹层；它将被诊断区替代，继续测无意义。Client 可以开始改。
2. **重建是否需重载**：我**无法从外部确认**。`/plugins/...` 与 `/api` 同样需鉴权（`GET /` 已实测 401），因此我无法直接比对服务端下发的新字节。
   → 现实路径：改完 → `build-bundle` → **先试页面重载**；若诊断区未出现，**就需要重启**，而重启须用户授权（由 PM 提交）。
   → 运行中已加载的是 07:59 那版 bundle；**诊断区不会凭源码改动自动出现**。
3. **交回要求**：改完给我 `tsc` 退出码、`node --test` 退出码与文件数、`dist/client.js` 新 mtime+sha、以及是否已试重载。我据此**重算 BIND-A 并取新快照**，再复验。

### 23.5 关于插件清单交叉验证（Host 第四条：我可以自己做）

**更正我在 20.1 的结论**：无障碍树在重启后**可读**，所以我**具备**查看设置→插件清单的能力，不必让用户代做。
但实测受阻：我在 08:07 与 08:45 两次读到的是**不同窗口/不同侧栏分组**（一次是主会话视图"全局面板"，一次是 Bot 会话视图"Bot 列表"），
且两次交互尝试都被 **"tree changed since observation"** 拒绝——**因为队友正在同一 GUI 内活跃操作**。
→ **待窗口安静时我会自行完成"设置→插件清单里是否有 `@dsh-gamecenter/host` 且为活跃"的检查**，用它把 `A0-2` 从 derived 提升为直接测量；
→ 在此之前，`A0-2` 记为**"bundle 已进 layers（重放实测）+ Client UI 已渲染（直接观察）"**，Host 服务挂载本身**仍为 derived**。

### 23.6 结论

**阶段0 仍未通过。** 已直接观察：重启发生、profile 为 desktop、侧栏入口与技能中心保留、弹层渲染、`/api` 401。
**仍为 derived 或未验证**：Host 服务挂载、`$mount`、`modelCatalog` 实取、暂停与旧次代拒写、四条关闭路径、目录脱敏。
→ 下一具体行动：**Client 实现诊断区 → 重建 → 交我重算 BIND-A 并复验**；安静时我补插件清单检查。

## 24. 无付费诊断候选独立验收（第二十五轮）

Client 交付 **独立 staging 候选**（未覆盖正在服务的 `dist/`）。我逐项独立复验。

### 24.1 产物与守约核对（全部 MATCH）

| 项 | 交付声明 | 我实测 | 判定 |
| --- | --- | --- | --- |
| `staging/client.js` | 46062B / `1346CF82…4CCD0E` | **46062B / 同值** | **MATCH** |
| `dist/client.js` 内容 | 未被覆盖 `1A5B9875…` | **同值** | **MATCH** |
| `package.json` 是否引用 `staging` | 无 | **无** | 成立（不会误加载） |

**一处需说明**：`dist/client.js` 的 **mtime 是 08:08:36**，但**内容 sha 未变**——
这是我 08:08 复验时执行 `build-bundle` 的**确定性重写**（重建前后 sha 相同）所致，**不是 Client 覆盖了部署产物**。
→ 运行中应用在 07:59:56 已加载旧字节，之后的内容未变，**部署态未被改动**。

### 24.2 独立复跑（本人退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -p tsconfig.json` | **0** | — |
| `node --test "test/*.test.mjs"` | **0** | **76/76**，skipped 0 / todo 0（11 个文件，比上轮 69 → **+7**） |
| `check-wire-contract.mjs` | **0** | `RESULT=PASS —— Client descriptor 与 Host wire 契约一致` |
| `check-bundle-externals.mjs` | **0** | PASS |
| `check-dependency-cycle.mjs` | **0** | `RESULT=PASS —— 无环` |

**staging 产物形态**：首行 `window.__ModuleLoader__.load({`、**无顶层 import**、外部 `require` 仅 `react`
（比 dist 多 1 处，来自新增 UI 模块；`react` 属 DSH 静态外部表且 `check-bundle-externals` PASS）。

### 24.3 PM 指定重点：`accepted:false` 不得显示为成功 —— **负例成立**

我逐条核对实现与测试：

| 检查 | 实测 |
| --- | --- |
| `src/bridge/diagnostics.js` | 279 行，**无 `.stream(` 调用**（零模型调用成立） |
| `remoteFailureOf` | 同时识别 `ok:false`（`errorCode` 与嵌套 `error.code` 双兼容）与 `accepted:false` |
| 负例：`{accepted:true,state:'paused'}` | 断言返回 `null`（成功不误判为失败） |
| 负例：`{ok:false,errorCode:'PROTOCOL_INVALID'}` | 断言取到该 code |
| 负例：`{accepted:false,error:{code:'STALE_RUNTIME'}}` | 断言取到 `STALE_RUNTIME` |
| 负例：`{accepted:false}`（无详情） | 断言回落 `UNKNOWN / 被拒绝` |
| **关键负例**（`diagnostics.test.mjs:167-197`） | **模拟 Host 缺陷：旧代次竟返回 `accepted:true`**，断言 `staleSaveRow.status === 'fail'` 且文案含 **`异常: 旧代次未被拒绝`** |
| 目录不可用三态 | 断言显示 `/不可用/` 且带真实失败原因（`API key not configured`），**不是"没有模型"** |

→ **PM 的核心要求已满足**：旧代次即使被错误接受，也会被判 **fail**，不会渲染成成功。

### 24.4 候选快照（新的绑定基线）

| 组 | 值 |
| --- | --- |
| **BIND-A `packages/**`** | **`3117D2BA31DD22BD24A30D91A6E5746C72569501AA494EEA3F204E1687343A2A`**，**187** 文件（原 180，+7：`staging/client.js`、`bridge/diagnostics.js`、`ui/RemoteDiagnostics.js`、`test/diagnostics.test.mjs`、`tools/build-candidate.mjs`、两个新 `.d.ts`） |
| **BIND-B 根配置** | `64B5DFF4…`（5 文件）**未变 MATCH** |
| **六产物** | **全部未变**（patch `9033468F`、host lib `36A01FBB`、client dist `1A5B9875`、client lib `B551CE10`、client dts `547D3803`、protocol `E4C11E5B`） |

→ **部署态与运行态仍对应旧 bundle `1A5B9875`**；候选 `1346CF82` 仅存在于 staging，**未生效**。

### 24.5 验收结论

**staging 候选：通过（可作为下一次部署负载）。**
- 未付费、未调用任何模型（零 `stream` 已核）；
- 守约：未覆盖部署产物、未接入 `exports`；
- 回归：76/76、tsc 0、三项守卫全 PASS；
- PM 指定的负例要求成立。

**但“部署生效”仍缺一步，且不能自动升级动作**：按 PM 口径，**自动更新 / 普通刷新 / GUI 重启是三个不同动作**。
→ 部署（`Copy-Item staging\client.js dist\client.js`）**须用户授权**；
→ 授权后**先试普通刷新**，并以「UI 是否出现诊断区」作为**新 bundle 已生效的判据**（旧 bundle 没有该区域，天然可区分）；
→ **仅当刷新无效**才请求重启；两秒内无变化**不**作为监听失效的判据。

### 24.6 阶段0 状态（未变）

`A0-2`（Host 加载）：bundle 进 layers（重放实测）+ Client UI 渲染（直接观察），**Host 服务挂载仍为 derived**。
`A0-3`（Client 显式装配）：**直接观察成立**（入口 + 弹层）。
`A0-4`/`A0-6`：**候选已具备可观察路径，但尚未部署生效**，故仍无直接证据。
`A0-5`/`A0-7`：仍无直接证据。
→ **阶段0 未通过**，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 25. 跨存档身份缺陷：独立确认 + 候选结论收窄（第二十六轮，应 PM 裁决）

### 25.1 我独立确认了 Host 的跨存档身份缺陷（**阶段0 安全阻断项**）

**逐行实读 `packages/dsh-gamecenter/src/remote/game-center-service.ts`**：

| 位置 | 事实 |
| --- | --- |
| `:184`（`saveAck`） | `const lease = this.registry.findByGeneration(input.generation)` —— **只按代次全局查找** |
| `:207`（`pause`） | 同上，**只按代次全局查找** |
| `:191-192` / `:223` | 命中后使用 **`lease.gameId` / `lease.saveId`**（即被命中那条租约的身份），**不是调用方请求的身份** |
| `:232`（`leaseStatus`） | `this.registry.get(input.gameId, input.saveId)` —— **正确写法，恰好形成对照** |
| 入参类型 | `SaveAckInput` / `PauseInput` **不含** `gameId`/`saveId`/凭证 → **请求侧根本无法被绑定** |
| `tokenDigest` | 全源码仅见"签发/写入租约/类型定义"（`:160`、`:170`、`lease.ts:63/85/217`），**穷举检索不到任何比较或校验**（`===`/verify/assert 均为空） |

→ **结论：运行时凭证签发后从未校验；`pause`/`saveAck` 的身份取自被命中的租约而非请求。**
→ 因此**任何调用方只要给出别人存档的 `generation`，就能对那个存档执行 `pause`/`saveAck`**。
→ 这违反基线 §6「小游戏不能伪造别的存档身份」的同类要求。**我同意 PM 的定性：阶段0 阻断安全缺陷，不得推迟。**

### 25.2 我此前的候选结论**收窄**（不撤回静态部分，暂停部署结论）

| 第 24 章结论 | 现在 |
| --- | --- |
| "staging 候选通过，可作为下一次部署负载" | **暂停**——PM 已裁定：**现有诊断候选的通过结论仅适用此前测试范围，暂不批准部署运行态诊断链** |
| 静态/单元验证（76/76、tsc 0、工具 PASS） | **仍然成立**（对当时的 commit 有效） |
| 动态 `gameId` + `generation=0` 探针 | **是绕开，不是证据**：它只保证"无命中即 STALE_RUNTIME"，**不能证明旧代次隔离或跨存档隔离正确** |

→ 我接受该收窄：**绕开现象不等于缺陷已消除**。

### 25.3 新候选（第二轮 staging）独立复验

| 项 | 声明 | 我实测 | 判定 |
| --- | --- | --- | --- |
| `staging/client.js` | 46138B / `77FDE87F…FE0357` | **同值** | **MATCH** |
| `dist/client.js` | 未动 `1A5B9875…` | **同值** | **MATCH** |
| `tsc` / `node --test` | 0 / 77-77 | **0 / 77-77**，零跳过零 todo | **复现** |

**断言严格性我专门核了（PM/Host 要求"不许放宽"）**：`diagnostics.js:254` 判定 `code === 'STALE_RUNTIME'` → `ok`；
**若非预期错误码走 `else` → `warn`**，文案 `被拒绝但错误码非预期 [<code>]`。
→ 即：**错误码不符不会显示为成功**（符合底线），但它标为 `warn` 而非 `fail`。
→ 我记为**观感级差异**：建议 PM 决定"非预期错误码"是否应直接 `fail`；我倾向 `fail`（诊断链的用途正是确定性拒写）。

### 25.4 Host 修复的验收测试矩阵（我的口径，与 PM 要求一致）

修复候选交我时，**以下负例缺一不可**：

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 两个存档 `generation` 相同，对 A 发 `pause`/`saveAck` | **只影响 A**，B 不变 |
| 2 | 同一 `gameId` 第二轮（`generation=2`）发 `saveAck(1)` | **严格 `STALE_RUNTIME`**（非 `PROTOCOL_INVALID`） |
| 3 | 旧 iframe 迟到 `pause`/`saveAck`（旧 `runtimeInstanceId`） | **拒绝** |
| 4 | 凭证缺失 / 错误 / 过期 / 属于其他运行实例 | **分别拒绝，错误码可区分** |
| 5 | 正常同代次幂等确认 | **仍然成功**（不因加固而回退） |
| 6 | 威胁模型与令牌保密/失效 | **文档明确**（不只看代码） |

**附加判据（关键）**：修复后诊断探针应能**改回固定 `gameId`** 并仍严格得到 `STALE_RUNTIME`。
→ **若仍需动态 `gameId` 才能过，说明身份绑定没修好，我不接受。**

### 25.5 部署与动作边界（未变）

- 部署 `staging → dist`、普通刷新、GUI 重启：**均须用户授权**，且**"等两秒→自动刷新→自动重启"这条链未被批准**；
- 我**不覆盖在线产物**、不刷新、不重启；
- 本轮结论仅针对项目内候选文件。

### 25.6 结论

**阶段0 未通过。** 新增一条**阻断级安全缺陷**（跨存档身份未绑定、凭证从未校验），已由我独立确认；
诊断候选的静态验证有效，但**部署结论暂停**；修复候选须满足 25.4 全部负例后我再整体复验。
`A0-2`~`A0-7` 保持 `BLOCKED`。

## 26. 插件清单观测：交互被审批拒绝，转交用户（第二十七轮）

### 26.1 我尝试自己取证，**被审批拒绝**

我有可读的无障碍树（第 22 节已更正），因此尝试自行进入插件清单核对 `@dsh-gamecenter/host`。实测：

| 尝试 | 结果 |
| --- | --- |
| 08:07、08:45 两次 `click`（弹层关闭按钮、侧栏入口） | 被拒：**"accessibility tree changed since observation"**（队友同时操作 GUI） |
| 本次 `click`（应用菜单，准备进设置→插件） | 被拒：**`action denied by approval: rejected by the approval answerer`** |

→ **这是审批边界，不是判断错误**。按 PM 规则「交互工具若审批拒绝则停并给用户简短手动步骤」，
**我停止一切 UI 交互**，不再重试。

### 26.2 `A0-2` 的状态（不升格）

| 层次 | 状态 |
| --- | --- |
| bundle 是否进 layers | **`DSH-BOOT-REPLAY` 实测**（`skippedBundles=0`） |
| Client UI 是否渲染 | **直接观察**（侧栏入口 + 弹层） |
| **Host 服务是否挂载（`fiberPhase`）** | **仍 `derived`** —— 缺插件清单一行观测 |

### 26.3 给用户的最小手动步骤（Host 已给出可靠锚点）

> 设置 →「插件」/「内置插件」清单页，找到含 **`@dsh-gamecenter/host`** 的那一行，回报三点：

1. **是否只有一行**（若另有 `gamecenter-host` 一行，那是 patch 的 `id`，需告知——说明有意外重复登记）；
2. **该行原始可见文本整段**（含徽标词，如 `active`/`pending`/`failed`）——徽标是 i18n key，**不要翻成中文猜**；
3. **它在哪个分区**：普通分区 / 失败分区。

**判读（Host 提供的结构判据）**：清单把 `fiberPhase === "failed"` 单独分流。
- 普通分区 + 徽标非 failed/pending ⇒ **Host 半已挂载**（`A0-2` 升为直接测量）；
- 失败分区 ⇒ **挂载失败**，通常带错误文本；
- 整份清单无该行 ⇒ **Host 半未挂载**（"bundle 被跳过"已被重放排除，指向"条目未创建"）。

### 26.4 与 Host 的口径对齐（已确认）

| 项 | 结论 |
| --- | --- |
| 绑定值 `BIND-A → 1F93CD14…`、client bundle `1A5B9875…` | **双方实测一致** |
| 当前运行版本的性质 | **"已部署但未走门禁"**，不是"未部署"——此定性我同意 |
| Host 的跨存档身份缺陷 | **与 Client 数值变化无关**，是源码级事实；我已独立确认（第 25 节） |
| 动态 `gameId` 绕开 | **是绕开，不是证据**；不接受以此证明旧代次或跨存档隔离正确 |

### 26.5 结论

`A0-2` 仍为 `derived`，我无法自行补齐；**需要用户按 26.3 回报一次插件清单观测**。
其余不变：阶段0 未通过，阻断项为第 25 节的跨存档身份缺陷，`A0-2`~`A0-7` 保持 `BLOCKED`。

## 27. 双端 Staging 联合验收（第二十八轮）：Host Staging 通过，Client 出现单行格式阻断缺陷

按 PM 派工接续双端 staging 候选联合验收。在线 `lib/`（`36A01FBB…`）、`dist/`（`1A5B9875…`）及真实 profile **分毫未动**。

### 27.1 Host Staging 候选复核：**通过**

| 项 | 实测 | 结论 |
| --- | --- | --- |
| `tsconfig.staging.json` | 退出码 **0** | BUILD 通过 |
| 产物存在性 | `staging/index.js`（8A913821…）、`staging/remote/game-center-service.js`（D02DB3F8…）、`staging/runtime/lease.js`（EEB28A6B…）全部存在 | 具备独立候选 |
| `node --test test/identity-binding.test.mjs` | **13/13 全通过** | 跨存档碰撞、第二轮旧 token 拒写（严格 `STALE_RUNTIME`）、iframe 封存后迟到写入、凭证缺失/伪造/过期等负例全部覆盖且有效 |
| 全包测试 `npm test` | **92/92 全绿，退出码 0** | 零跳过，零 todo |
| 端到端候选产物守卫 | `test/build-artifact.test.mjs` 第 16 项已覆盖 staging 候选端到端凭证绑定 | 通过 |

→ **Host 端关于第 25 节安全阻断项的修复在 staging 候选内验证通过。**

### 27.2 Client Staging 候选复核：**不通过（发现可复现阻断缺陷）**

在对 Client 提交的 `staging/client.js`（46138B / `77FDE87F…`）进行独立测试复验时，发现严重缺陷：

1. **缺陷位置**：`packages/dsh-gamecenter-client/src/bridge/diagnostics.js` 第 164 行：
   注释末尾缺少换行，导致紧随其后的 `if` 条件语句被合并进单行注释被直接吃掉：
   `// 如果 handshake 失败未能获得有效 generation 或 runtimeToken，后续与租约强关联的探针全部标记为跳过  if (activeGeneration <= 0 || !activeToken) {`
2. **破坏后果**：因为 `if` 条件被注释，随后的 `{ ... return rows; }` 代码块**无条件执行**。每次执行诊断，只要跑完 handshake 和 catalog，后续的 `lease`、`pause`、`staleSave`、`saveAck` 探针**全部被无条件标为 `skip` 并直接返回**！
3. **测试挂掉**：执行 `node --test test/diagnostics.test.mjs`，在第 231 行断言失败：
   `AssertionError [ERR_ASSERTION]: 旧代次未被拒绝必须标记为 fail`（实际值 `'skip' !== 'fail'`），测试退出码为 **1**。
4. **影响**：`npm test` 失败，当前 `staging/client.js` 也是带着该缺陷打包的。

### 27.3 处置与交接

- 已通过 `message_bot` 向 `界面与运行时工程师` 发出具体缺口（精确定位到文件、行号、语法原因与测试退出码），交其修复。
- 修复要求：补全换行使 `if` 生效，跑通 `npm test`（77/77 退出码 0），重新生成 `staging/client.js` 并给出新摘要。
- **当前结论**：**双端联合候选目前不可部署**（Client 侧阻断）；待 Client 修复重验合格后，再出具可部署结论并绑定部署变更单。
- 在线运行态继续保持现状，未做产物替换、未做重启。`DSH-REAL` 仍为 0 条，阶段0 保持 `BLOCKED`。

## 28. 双端 Staging 联合验收定稿（第二十九轮）：全绿通过，具备部署条件

Client 工程师已补齐换行并修复方法调用上下文（`fn.call`），完成了 Client 端对 Host `runtimeToken` 凭证绑定的适配与端到端联合测试。

### 28.1 格式缺陷闭环复核
- `packages/dsh-gamecenter-client/src/bridge/diagnostics.js` 第 164 行换行已补齐，`if (activeGeneration <= 0 || !activeToken)` 条件生效；
- `node --test test/diagnostics.test.mjs`：第 231 行 `旧代次未被拒绝必须判 fail` 成功通过；
- Client 全包单测 `npm test`：**81/81 全绿，退出码 0（12 个测试文件，零跳过零 todo）**。

### 28.2 凭据安全与防泄露核验
1. **内存私有**：`runtimeToken` 仅由 Client Bridge 内存持有，不暴露给任何外部对象；
2. **UI 零泄露**：实测 `src/ui/*.js` 全文不含 `token` 词条；`test/diagnostics.test.mjs`（L110-111）逐行断言每个诊断行 `row.value` 严禁出现 token 原文；
3. **零外部调用**：`diagnostics.js` 全文 **无 `.stream(` 调用**，零模型调用、无付费风险。

### 28.3 真实 Host Staging + Client 逻辑端到端联合测试
`packages/dsh-gamecenter-client/test/real-host-staging-joint.test.mjs` 4 项测试全部通过：
- 加载真实 Host Staging 服务产物（`packages/dsh-gamecenter/staging/remote/game-center-service.js`）；
- 单轮诊断全链路 7 项指标全绿；
- **固定 `DIAG_GAME_ID` 连续两轮运行**，第二轮旧代次拒写依然稳定返回 `STALE_RUNTIME`；
- 凭据伪造与跨 saveId 声明篡改均被严格拒绝为 `PROTOCOL_INVALID`（错误文案 `声明的 saveId 与运行凭证不符。` 匹配验证）。
→ **彻底消除了此前“靠动态 gameId 掩盖缺陷”的隐患，第 25 节安全阻断项在真实代码级实现闭环。**

### 28.4 全工程回归与产物隔离状态

| 包 / 范围 | 验证项 | 实测结果 |
| --- | --- | --- |
| 全工程 | `pnpm run typecheck` | **退出码 0** |
| 全工程 | `pnpm run test` | **退出码 0（Client 81/81 + Host 92/92 + Protocol 10/10）** |
| 协议 | `pnpm run build` | **退出码 0** |
| 前置工具 | `verify-load-prereqs.mjs` | **12/12 PASS** |
| 契约工具 | `check-wire-contract.mjs` | **PASS** |
| 依赖工具 | `check-bundle-externals.mjs` / `check-dependency-cycle.mjs` | **PASS（无环）** |

**在线部署态（分毫未动，已确认恢复并留存仓库内独立备份）**：
- Host 在线产物：`packages/dsh-gamecenter/lib/index.js` sha256: `36A01FBBEB4DA75A698AD6A1B6E9D6ABA210DBA4ADA6A90EED3E5D164BC9CEE9`（备份位于 `packages/dsh-gamecenter/staging-rollback/lib-202610190850`）；
- Client 在线产物：`packages/dsh-gamecenter-client/dist/client.js` sha256: `1A5B9875F06ADE8B403EE81B23D21C15ACA9455C6064BFB5D35CB5DE3F2BC0BA`（备份位于 `packages/dsh-gamecenter-client/staging-rollback/client.js-deployed-1A5B9875`）；
- 真实 profile：`package.json`（`4AA2223B…`）、`cordis.patch.yml`（`F7411138…`）、2 个 junction 均在位未改动。

**待发布 Staging 候选产物**：
- Host 候选：`packages/dsh-gamecenter/staging/index.js`（5310 字节，sha256: `8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`）；
- Client 候选：`packages/dsh-gamecenter-client/staging/client.js`（46457 字节，sha256: `6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`）。

**最新绑定基线**：
- `BIND-A`（`packages/**` 全部）：`843E4DB7DF788315E834FFBA5C856D77BDC5469B38F6A1D514EC29061240EA6D`（n=234）；
- `BIND-B`（根配置 5 文件）：`64B5DFF44514597637232F3E24EE5B244B6588D072219BBB6E3F573B380CA5D7`（n=5，MATCH）。

### 28.5 最终联合验收结论

**双端 Staging 候选全部通过验收，具备正式上线部署条件。**
- 彻底修复第 25 节安全阻断项（凭证校验 + 跨存档隔离）；
- 探针已恢复固定 `__gamecenter_diag__` 且两轮测试均获确定性 `STALE_RUNTIME`；
- 无 token 泄露，零模型付费调用；
- 在线运行态保持完好，回滚镜像双包就位。

### 28.6 唯一部署变更单（交 PM 申请用户授权执行）

**动作 1：产物替换**
1. 将 `packages/dsh-gamecenter/staging/*` 覆盖至 `packages/dsh-gamecenter/lib/`；
2. 将 `packages/dsh-gamecenter-client/staging/client.js` 复制至 `packages/dsh-gamecenter-client/dist/client.js`。

**动作 2：客户端生效与分级观察**
1. 先在 GUI 按 `Ctrl+R`（或 F5）刷新页面；
2. 打开游戏中心弹层，观察是否出现「无付费诊断区」：
   - 若出现表格且 7 项逐步检测通过（特别是 `handshake` 下发代次、`modelCatalog` 只读列出模型、旧代次拒绝返回 `STALE_RUNTIME`），则**无需重启 GUI**！
   - 若刷新后仍为旧版静态占位文案（因 Host 内存缓存未失效），则执行一次 GUI 正常退出与重开。

**回滚方案（若出现任何异常）**：
1. 将 `packages/dsh-gamecenter/staging-rollback/lib-202610190850/*` 拷回 `packages/dsh-gamecenter/lib/`；
2. 将 `packages/dsh-gamecenter-client/staging-rollback/client.js-deployed-1A5B9875` 拷回 `packages/dsh-gamecenter-client/dist/client.js`；
3. 刷新页面或重开 GUI 即可 100% 还原为当前运行态。

## 29. 部署后现场独立复核（第三十轮）：产物与备份 100% 就位，发现 1 处旧契约单测断言待适配

在用户授权执行部署后，对在线产物替换、回滚镜像与真实 profile 进行逐项独立复验。

### 29.1 部署产物替换与完整哈希比对（100% 匹配）
1. **Host 在线目录（`packages/dsh-gamecenter/lib/`）**：
   - 与 `staging/` 目录逐文件比较：**全部 21 个文件 0 差异，100% MATCH**；
   - `lib/index.js`（5310 B）：`8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`；
   - `lib/remote/game-center-service.js`（15517 B）：`D02DB3F88A202F20E67C611BCF5F234FBC43D94108C3070F06001B28D4AF59FD`；
   - `lib/runtime/lease.js`（15464 B）：`EEB28A6B5B414A311A02E9BC41014477B860666823291A50A0E5A86C29572914`。
2. **Client 在线产物（`packages/dsh-gamecenter-client/dist/client.js`）**：
   - 与 `staging/client.js` 完全一致：**46457 B，SHA256: `6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`**。
3. **回滚镜像完整入库**：
   - Host 回滚备份 `packages/dsh-gamecenter/staging-rollback/lib-deployed-36A01FBB-202610190945`：21 个文件全量存在，`index.js` sha256 确为 `36A01FBBEB4DA75A…`；
   - Client 回滚备份 `packages/dsh-gamecenter-client/staging-rollback/client.js-deployed-1A5B9875-202610190945`：sha256 确为 `1A5B9875F06ADE8B…`。
4. **真实 Profile 状态**：
   - `~/.dsh/profiles/desktop/package.json`（`4AA2223BFC0E4C50…`）、`cordis.patch.yml`（`83DA47B1DC975DFE…`）、2 个 Junction 软链接完好指向本地仓库，**未被篡改**。

### 29.2 部署后回归测试发现遗留旧契约单测报错
在部署产物就位后执行自动化回归测试，发现 `packages/dsh-gamecenter/test/build-artifact.test.mjs` 出现 1 处失败：
- **失败用例**：`产物中的核心逻辑可端到端执行：握手 → 暂停 → 旧代次拒写 → 保存确认`（行 210-235）；
- **失败根因**：该测试直接调用 `lib/index.js`，写用例时 `lib/` 还是未加固的旧版，因此测试中调用 `pause` 与 `saveAck` 时**未携带 `runtimeToken`**；
- 产物替换为安全新版后，无凭证调用被正确且严格地拒绝（返回 `accepted: false, error: { code: 'PROTOCOL_INVALID', message: '缺少有效运行凭证。' }`）；
- 但旧测试断言了 `assert.equal(paused.accepted, true)`，导致抛出 `false !== true`；
- 该文件下方的 `staging 修复候选产物中的凭证绑定逻辑端到端执行`（行 240-275）此前已带 `runtimeToken` 测试且通过。
- **处置**：已通过 `message_bot` 告知 Host 工程师将该用例更新为带 `runtimeToken` 调用。

### 29.3 现场结论与状态
- 部署文件物理替换与哈希完全吻合，备份镜像与 profile 状态健全；
- 待 Host 将该处遗留旧契约单测更新并通过（92/92 全绿）后，出具最终“已部署，待用户正常重启”结论；
- **当前提示**：用户暂先不要重启，待测试全绿后统一通知。

## 30. 部署最终复核通过与哈希差异清算（第三十一轮）：已部署，可通知用户正常重启

Host 工程师已完成 `test/build-artifact.test.mjs` 中遗留旧单测的凭证入参适配，自动化回归测试全线通过。同时对 PM 提示的两处哈希演进进行了严格的独立比对与溯源确认。

### 30.1 单测修复与全工程回归确认
- `packages/dsh-gamecenter/test/build-artifact.test.mjs` 中的 `产物中的核心逻辑可端到端执行` 已补齐 `runtimeToken`；
- Host 全量测试：**92/92 全部通过，退出码 0（零失败、零跳过）**；
- 全工程自动化测试 `pnpm run test`：**退出码 0（Client 81/81 + Host 92/92 + Protocol 10/10，合计 183 项全绿，零跳过零 todo）**；
- 全工程类型检查 `pnpm run typecheck`：**退出码 0**。

### 30.2 PM 提示的两处哈希演进独立核验与清算

1. **`cordis.patch.yml` 摘要差异（`83DA47B1…` vs `F7411138…`）的精确事实**：
   - 现场对当前真实 profile 的 `<PROFILE_DIR>\cordis.patch.yml` 与备份 `cordis.patch.yml.bak-gamecenter-2026101907` 逐行逐字 Diff；
   - **两文件总大小完全相同**（均为 4572 字节），**全文差异仅此 1 行**：
     - 备份原值：`    welcomeNoticeVersion: 2026-08-13.1`（38 字符）
     - 当前值：  `    welcomeNoticeVersion: 2026-09-28.1`（38 字符）
     - 实际差异为同列位置的 5 个字符（`09-28` vs `08-13`），**全文无任何其他增、删、改**；
   - **未写入任何游戏中心配置**：检索 `gamecenter` 与 `game-center` 匹配数为 **0**；
   - **修改来源（标为推断）**：基于时间关联（07:59:57 写入，紧随应用启动），推断系 DSH 内核启动弹出欢迎提示后回写的已读通知版本；
   - **路径彻底澄清与错误解释撤回**：
     - 真实 profile patch 路径 `<PROFILE_DIR>\cordis.patch.yml` 绝无游戏中心条目；
     - 游戏中心的 Loader 条目唯一位于项目内文件 `<REPO>\packages\dsh-gamecenter\cordis.patch.yml`（sha: `9033468F…`），由 `package.json` 的 `dsh.bundle.patch` 挂载；
     - 此前所谓“条目已写入真实 profile patch”的混淆解释**在此正式明确撤回并纠正**。
2. **Host 服务模块摘要（`D02DB3F8…` vs `15FECA29…`）**：
   - `15FECA29…` 属于早期仅按 token 查租约的中间过渡态；
   - 后续为满足安全要求，增加了对调用方声明的 `gameId`/`saveId` 交叉比对与校验，重新构建后哈希演进为 `D02DB3F88A202F20E67C611BCF5F234FBC43D94108C3070F06001B28D4AF59FD`；
   - 该哈希已在第 28 节验收报告中被正式锁定并用于端到端联合测试（4/4 通过），本次部署正是原位替换该版本，来源正当合规。

### 30.3 最终复核结论与交接

**复核全部通过！已部署就位，可正式通知用户进行正常 GUI 重启。**
- 部署目录文件哈希 100% 吻合获批版本；
- 回滚镜像完好，随时可一键原位还原；
- 183 项测试、全部守卫工具、类型检查全线退出码 0。

### 30.4 用户操作指引与重启后第一批观察点
1. **用户操作**：请从菜单或正常窗口按钮**正常退出 DeepSeek Harness**，再重新打开（**不要强杀进程**）；
2. **重启后第一批观察点**：
   - 打开游戏中心弹层，观察是否出现 7 项只读检测表格；
   - 观察 `handshake` 服务可达性、`modelCatalog` 只读列出模型数量、`saveAck` 旧代次拒绝返回 `STALE_RUNTIME`；
   - 整个过程全程只读元数据，零模型调用、无付费操作。

## 31. 第二次重启后进程与 UI 自动化直接观测（第三十二轮）

### 31.1 重启实测与命令行核对（直接观察 / 进程级）
- **重启确认**：DSH 桌面主进程 PID **3248**（启动时间 09:57:55）；
- **Host 进程参数**：子进程 PID **23156**，命令行显式携带 `<PROFILE_DIR>` 参数，确认以修改后的 desktop profile 启动；
- **在线产物哈希**：
  - Host `packages/dsh-gamecenter/lib/index.js` sha256: `8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`（100% MATCH）
  - Client `packages/dsh-gamecenter-client/dist/client.js` sha256: `6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`（100% MATCH）
- 部署态与最终安全加固候选严格一致。

### 31.2 UI 自动化树直接观测
- 成功通过 Windows UIAutomation 读取到 DSH 窗口（PID 3248）共 **826 个界面元素**；
- 当前窗口位于 DS Bot 团队群聊界面，侧边栏显示 Bot 列表，游戏中心弹层当前处于**关闭状态**；
- 弹层尚未展开，无法直接读取新版诊断表格数据。

### 31.3 最小用户协助操作
- 请用户在界面左侧切换回主工作区，或在全局面板中点击 **「游戏中心」** 打开弹层，并**保持弹层在屏幕上显示**；
- 弹层打开后，我们便可直接抓取 7 项真实运行指标，或请用户将弹层文字贴入群内完成验收闭环。

## 32. 游戏中心新版弹层直接观测与诊断区就位实证（第三十三轮）

用户点击打开游戏中心后，成功通过 UI 自动化读取到打开的弹层全量元素。

### 32.1 现场直接观测（DSH-REAL 硬证据）
- **弹层窗口尺寸变动**：由旧版的 `600x196` 扩大为 `600x320`（高度增加 124px，确认包含新增诊断区内容）；
- **新版诊断区就位**：
  - 分组控件：`[ControlType.Group] "Remote 连通性与模型只读诊断"` 成功渲染；
  - 标题：`[ControlType.Text] "阶段0 链路诊断与模型目录"`；
  - 契约对账声明：`[ControlType.Text] "契约对账: SERVICE_KEY=gameCenter (两端一致) · 独立探针 (无付费/无模型调用)"`；
  - 刷新按钮：`[ControlType.Button] "重新检测"`（位于坐标 (1165, 517)，大小 62x23）；
  - 诊断表格当前呈现初始占位：`[ControlType.Text] "正在初始化诊断探针…"`。
- **证实事实**：新版客户端候选（`46457` 字节，sha256 `6559EA1C…`）**已被真实 DSH 桌面端加载并在界面上完整渲染出新版诊断模块**。

### 32.2 状态分类与分析
- **直接观察**：新版客户端 bundle 真实加载成功，诊断区结构与按钮完整渲染；
- **未验证**：7 项具体指标表格内容（界面当前停留在初始状态“正在初始化诊断探针…”）；
- **分析**：由于组件初始化或异步执行时机，探针结果尚未刷入表格。

### 32.3 给用户的单步操作指引
- 请用户在当前弹层的诊断区右上角，用鼠标点击一下 **「重新检测」** 按钮；
- 观察表格是否刷新出 7 行检测指标（包括挂载、握手、模型目录、租约、暂停、旧代次拒写、保存确认）；
- 若已刷出结果，请告知各行的状态（如“正常/告警/失败”）或直接截屏/贴出弹层文字。

## 33. 自动化点击拦截与用户手动点击实测复测（第三十四轮）

### 33.1 自动化点击拦截事实（自动化工具级）
- 尝试通过 Windows UIAutomation 自动化调用 `click` 点击元素 `42.14683652.4.4.1.7819`（「重新检测」按钮）；
- 连续两次均被引擎拦截抛错：`Error: the pixels of window 1575646 changed since observation — run screen_read or screen_shot again before acting`；
- **拒执根因**：当前会话执行期间，DSH 侧栏当前会话条目（`(12, 562)` 处）存在高频旋转/呼吸动画，导致窗口像素哈希在观察与执行的微秒级间隔内持续变动，触发自动化操作的安全防并发校验。

### 33.2 用户手动点击实测结果（DSH-REAL 硬证据）
- 用户在界面上完成手动点击「重新检测」按钮后，通过 `screen_read` 获取最新界面树（Window 元素 ID 刷新为 `8306`，按钮 ID 刷新为 `8292`）；
- **实测结果**：弹层依然完全停滞在 `[ControlType.Text] "正在初始化诊断探针…"`，按钮文案仍为 `重新检测`，没有任何检测指标行刷出；
- **结论**：彻底推翻“仅因初次挂载未 re-render、手动点一次就能跑通”的推测，**确认为实机运行态阻断缺陷**。

## 34. 界面与运行时工程师独立修复复核与全新候选验收（第三十五轮）

### 34.1 根因核对与工程加固
1. **远程调用无界挂起与按钮死锁**：原 `runRemoteDiagnostics` 对底层远程 RPC（`client.handshake` 等）未设超时；若底层请求挂起，Promise 永久挂起导致 `execute()` 无法到达 `finally`，`loading` 死锁在 `true`，后续点击被直接拦截；
2. **异常未捕获且未呈现**：`execute()` 顶层缺少全局 `try...catch`，任何前置异常被静默抛给 Promise rejection，导致 `rows` 保持为空，界面永久停在占位文案；
3. **加固项复核**：
   - 单项远程 RPC 增加 3000ms 有界超时（`callWithTimeout` 包裹 `handshake`、`modelCatalog`、`leaseStatus`、`pause`、`saveAck`）；
   - 组件级 4000ms 全局超时防死锁（`setTimeout` 注入）；
   - 移除 `if (loading) return;` 阻断，改为基于自增轮次号 `runSequenceRef` 防并发；
   - 顶层异常捕获转化为可见的 `exec_error` 错误行展示；
   - 新增 `test/diagnostics-ui.test.mjs` 测试真实 UI 交互、点击驱动状态更新、错误可见性负例及挂起超时负例。

### 34.2 独立 QA 复验数据（全工程测试与类型检查）
- **Client 测试**：`pnpm --filter @dsh-gamecenter/client test` → **84/84 PASS**（退出码 0，零跳过零 todo）；
- **Host 测试**：`pnpm --filter @dsh-gamecenter/host test` → **92/92 PASS**（退出码 0，零跳过零 todo）；
- **Protocol 测试**：`pnpm --filter @dsh-gamecenter/protocol test` → **10/10 PASS**（退出码 0）；
- **全工程回归**：**186/186 项全部通过**；
- **类型检查**：`pnpm run typecheck` → **全部包通过，退出码 0**；
- **契约与守卫**：`check-wire-contract` / `check-bundle-externals` / `check-dependency-cycle` 全部 PASS。

### 34.3 产物摘要与受控隔离状态
- **在线运行产物（分毫未动）**：
  - Host `packages/dsh-gamecenter/lib/index.js` sha256: `8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`
  - Client `packages/dsh-gamecenter-client/dist/client.js` sha256: `6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`
- **独立验收候选产物**：
  - Client `packages/dsh-gamecenter-client/staging/client.js`：
    - 大小：**51502 字节**
    - SHA256：`B12532CB5080EE118EB3548B4E93A707B139993A8F1C62274E968C6C19C338FB`
- **Profile 隔离核查**：
  - `package.json` sha256: `4AA2223BFC0E4C50A0C809D743CC068AE112E61860CFC5B4D9158B06FDBAFA39`（保持一致）
  - `cordis.patch.yml` 检索 `gamecenter` 结果为 0，零游戏中心条目注入。

### 34.4 验收结论与交接
- **独立候选验收通过**：具备可部署性，已彻底解决无界死锁与静默吞错问题；
- **阶段0 状态**：保持 **BLOCKED / 未通过**，需待将新版 Client 候选替换进真实环境后取得真实 7 项检测证据；
- **后续动作建议**：
  1. 本次修复仅涉及 Client 单端，Host 产物（已包含凭证加固与交叉校验）分毫未动；
  2. 请项目经理起草单端（Client）替换变更单交用户审批；
  3. 获批后按清单备份并替换 `packages/dsh-gamecenter-client/dist/client.js`，用户再次重启 DSH 后复测。

## 35. 超时预算校准、AbortSignal 取消隔离复验与最终可部署候选锁定（第三十六轮）

### 35.1 PM 提示风险闭环核实
1. **超时预算倒挂已消除**：
   - 全局兜底超时由 4000ms 调整为 **15000ms（15 秒）**；
   - 单项 RPC 保持 3000ms（3 秒），确保 7 步串行正常执行的总耗时（如 4~6 秒）不会被误杀，同时对异常挂起保留有界中断兜底。
2. **远程写调用取消与副作用隔离已建立**：
   - `RemoteDiagnostics` 组件在重试触发及组件卸载时调用 `abortPreviousRun()`，通过 `AbortController` 向底层派发 `abort` 信号；
   - `callWithTimeout` 监听 `signal.onabort`，一旦触发立即以 `ABORTED` 中断并清理定时器；
   - `runRemoteDiagnostics` 在每步调用前置与后置严格检查 `if (signal?.aborted) return rows;`，中止后严禁发起后续步骤，彻底阻断旧轮次在后台对 Host `DIAG_GAME_ID` 租约的迟到写入、代次污染与跨轮串扰。
3. **集成负例测试 100% 覆盖**：
   - `test/diagnostics-ui.test.mjs` 新增 3 项生命周期负例，断言快速重试时旧轮次必定被 abort 且只有最新 1 轮完成、组件卸载立刻 abort 终止后台探针、异常错误脱敏可见。

### 35.2 独立 QA 复验数据（全工程 187/187 全绿）
- **Client 测试**：`pnpm --filter @dsh-gamecenter/client test` → **85/85 PASS**（退出码 0，零跳过零 todo）；
- **Host 测试**：`pnpm --filter @dsh-gamecenter/host test` → **92/92 PASS**（退出码 0）；
- **Protocol 测试**：`pnpm --filter @dsh-gamecenter/protocol test` → **10/10 PASS**（退出码 0）；
- **全工程回归**：**187 项全部通过**；
- **类型检查**：`pnpm run typecheck` → **全部包通过，退出码 0**；
- **契约与守卫**：`check-wire-contract` / `check-bundle-externals` / `check-dependency-cycle` 全部 PASS。

### 35.3 最终可部署候选产物锁定
- **在线运行产物（分毫未动）**：
  - Host `packages/dsh-gamecenter/lib/index.js` sha256: `8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`
  - Client `packages/dsh-gamecenter-client/dist/client.js` sha256: `6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`
- **已验收可部署候选**：
  - Client `packages/dsh-gamecenter-client/staging/client.js`：
    - 大小：**54357 字节**
    - SHA256：`D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`
- **Profile 与运行态隔离**：
  - `package.json` sha256: `4AA2223BFC0E4C50A0C809D743CC068AE112E61860CFC5B4D9158B06FDBAFA39`
  - `cordis.patch.yml` 保持未修改游戏中心条目。

### 35.4 最终验收与部署交付意见
1. **候选结论**：候选 `D5804E1D…` 已经历静态、单元、集成、生命周期中止与超时负例的独立复验，**具备正式部署资格**；
2. **最小更新动作**：
   - 范围仅限 Client 单端：备份当前 `dist/client.js`（`6559EA1C…`），将 `staging/client.js`（`D5804E1D…`）复制覆盖至 `dist/client.js`；
   - Host 服务端与真实 profile **保持分毫未动**；
   - 可在桌面端尝试通过快捷键刷新网页（`Ctrl+R`）热更新 Client 模块，若未生效再进行正常退出重启；
3. **阶段0 状态**：在取得真实 DSH 运行态 7 项指标输出前，**维持 BLOCKED / 未通过**。

## 36. 真实 Host 延迟握手/迟到完成与已提交请求不可撤销风险边界实测（第三十七轮）

### 36.1 结论纠正与证据范围收敛
- **纠正事实**：正式**撤回“彻底阻断迟到写入”这一超出底层机制证据的结论**；
- **底层客观现实**：
  1. DSH typert/Remote 传输层在 wire descriptor 层面仅为 `modelCatalog` 声明了 `cancellation`，其余写方法（`handshake`, `pause`, `saveAck`, `leaseStatus`）在协议层无取消信令通道；
  2. `createGameCenterClient` 亦未向底层 RPC 传递 `signal`；
  3. 因此，本地 `AbortSignal` 与 `Promise.reject` **仅能阻断 Client 本地后续步骤的发起**，对于**已投递至网络/IPC 传输层的单个写请求，Host 侧仍会照常处理完成，无法被客户端强行召回或取消**；
  4. 15000ms（15 秒）为整轮诊断执行的**顶层政策上限**，而非确保所有网络抖动下组合调用绝不超时的数学证明。

### 36.2 真实 Host 延迟与迟到完成负例实测（`test/real-host-staging-joint.test.mjs`）
针对 PM 要求的“固定 `gameId` 下真实 Host 延迟执行 handshake → 旧轮 abort → 新轮开始 → 旧请求最后完成”，实测并断言：
1. **测试设计**：
   - 固定使用 `DIAG_GAME_ID = '__gamecenter_diag__'`;
   - 第一轮在底层 `handshake` 注入 60ms 延迟；在 15ms 时触发 Client 侧 `ctrl.abort()`；
   - 第一轮 Client 立即中断退出，仅记录了 mount 与 handshake(pending)，**未向 Host 发起后续的 catalog, lease, pause, staleSave, saveAck 等 5 个写调用**；
   - 第二轮立即以相同的 `DIAG_GAME_ID` 启动并以 0ms 延迟执行，**全链路 7 项指标全绿顺利完成**（最终状态处于 `paused` 封存态）；
   - 60ms 后，第一轮已发出的底层延迟 `handshake` 在 Host 侧真实结算完毕。
2. **真实 Host 注册表断言结果**：
   - **完全隔离验证**：两轮握手使用独立的 `runtimeInstanceId`（基于 nonce），Host 为其分配了完全独立的 `saveId`（`diag-nonce1` vs `diag-nonce2`）与独立的 `runtimeToken`；
   - **防串扰验证**：第二轮的凭证严格绑定至 `__gamecenter_diag__\0diag-nonce2`，第一轮的凭证严格绑定至 `__gamecenter_diag__\0diag-nonce1`；第一轮迟到握手完全不会影响第二轮的 `generation` 与 `paused` 状态；
   - **最大残留证明**：第一轮被 abort 后，由于后续步骤被 Client 拦截，第一轮在 Host 侧**最大残留且仅残留 1 个处于 `running` 状态的孤儿 LeaseRecord**。该残留租约不具备后续调用者，将在 `ttlMs`（默认 30s）后由 Host 侧定时 sweeper 安全超时销毁。

### 36.3 全量测试回归（188/188 全绿）
- **Client 测试**：`pnpm --filter @dsh-gamecenter/client test` → **86/86 PASS**（含本轮真实 Host 迟到负例，退出码 0）；
- **Host 测试**：`pnpm --filter @dsh-gamecenter/host test` → **92/92 PASS**（退出码 0）；
- **Protocol 测试**：`pnpm --filter @dsh-gamecenter/protocol test` → **10/10 PASS**（退出码 0）；
- **全工程回归**：**188 项全部通过**；
- **类型检查**：`pnpm run typecheck` → **退出码 0**。

### 36.4 最终部署放行意见
- 安全边界与残留上限已有确凿代码断言与集成测试覆盖；
- 候选 `D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`（54357 字节）**可正式进入部署授权申请流程**；
- 部署动作限定为 Client 单文件原位备份与替换，阶段0仍待真实 DSH 运行态输出。

## 37. D5804E1D 单端受控部署与实机运行态异常捕获（第三十八轮）

### 37.1 单端部署核验（100% 吻合）
- 用户明确授权后，界面与运行时工程师执行 `dist/client.js` 单文件覆盖替换；
- **在线产物核验**：`dist/client.js` sha256 确认为 `D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`；
- **回滚备份**：原在线版本已归档至 `packages/dsh-gamecenter-client/staging-rollback/dist-202610191235/client.js`（sha256 `6559EA1C…`）；
- Host 产物与桌面 profile 分毫未动。

### 37.2 实机运行态直接观察与真实错误捕获（DSH-REAL 硬证据）
- 用户在 DSH 桌面端执行页面刷新后打开游戏中心弹层；
- 界面成功摆脱“正在初始化诊断探针…”的静默死锁，**新版顶层全局异常捕获完全生效**，在诊断表格第一行直接爆出底层真实报错：
  - 指标：`[ControlType.Text] "诊断执行异常"`
  - 状态：`[ControlType.Text] "失败"`
  - 详情：`[ControlType.Text] "异常中断: 获取服务客户端失败: cannot get property \"remote.gameCenter\" without inject"`
- **实证结论**：界面与异常暴露链路已打通，错误被精确定位至 Cordis 服务代理机制：`ctx.remote.gameCenter` 点号访问被依赖注入防护层严格拦截。

## 38. Cordis 注入拦截根因闭环、ctx.get 读取方案复验与全新候选验收（第三十九轮）

### 38.1 根因核对与架构方案复现
1. **源码级根因**：`dsh-api-gateway` 将 Remote 命名空间注册为点号键 `remote.${namespace}`（即 `remote.gameCenter`）。Cordis 的上下文代理仅沿 fiber 的 `store` 查找已在 `inject` 声明的服务；
2. **死锁禁忌（已核死）**：严禁将 `remote.gameCenter` 写入 `inject`！因为该服务由插件自身 `apply()` 内 `$mount` 动态生成。若声明 inject，Cordis 会将 fiber 置为 `INACTIVE` 陷入自等候死锁（架构探针 C 组 `applyRan: false` 实证）；
3. **公开合法读法**：根据 Cordis `ReflectService.get` 官方规范，改用 `ctx.get('remote.gameCenter')`（及兼容 `ctx.reflect?.get`），不受当前 fiber 的 inject 声明拦截，纯净直读服务 store。

### 38.2 独立 QA 复验数据（全工程 190/190 全绿）
- **Client 测试**：`pnpm --filter @dsh-gamecenter/client test` → **88/88 PASS**（含防死锁断言与点号拦截负例，退出码 0，零跳过零 todo）；
- **Host 测试**：`pnpm --filter @dsh-gamecenter/host test` → **92/92 PASS**（退出码 0）；
- **Protocol 测试**：`pnpm --filter @dsh-gamecenter/protocol test` → **10/10 PASS**（退出码 0）；
- **全工程回归**：**190 项全部通过**；
- **类型检查**：`pnpm run typecheck` → **全部包通过，退出码 0**；
- **Cordis 探针**：`tools/cordis-inject-probe/repro-inject-guard.mjs` 三组对照真实 Cordis 验证全部 PASS。

### 38.3 候选产物锁定与受控隔离
- **在线运行产物（分毫未动）**：
  - Client `packages/dsh-gamecenter-client/dist/client.js` sha256: `D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`
  - Host `packages/dsh-gamecenter/lib/index.js` sha256: `8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`
- **已验收全新候选**：
  - Client `packages/dsh-gamecenter-client/staging/client.js`：
    - 大小：**54484 字节**
    - SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`
- **代码特征复核**：`staging/client.js` 全文已彻底消除 `ctx.remote?.gameCenter` 点号访问，全面改用 `ctx.get("remote.gameCenter")`；`inject` 维持 `['slots', 'locale', 'remote']`。

### 38.4 最终验收与部署交付意见
1. **候选结论**：候选 `1BE7FDA8…` 完美通过静态、单元、集成与 Cordis 真实运行时注入守卫负例验证，彻底修复了实机捕获的 `cannot get property without inject` 阻断，**具备正式部署资格**；
2. **最小更新动作**：
   - 范围仅限 Client 单端：备份当前 `dist/client.js`（`D5804E1D…`），将 `staging/client.js`（`1BE7FDA8…`）覆盖至 `dist/client.js`；
   - Host 服务端与真实 profile **保持分毫未动**；
   - 部署后在桌面端执行 `Ctrl+R` 页面刷新即可立即加载生效；
3. **阶段0 状态**：在取得真实 DSH 运行态 7 项指标输出前，**维持 BLOCKED / 未通过**。

## 39. 真实实装 Gateway 分派闭环复验、跨副本调用实证与 Host93F30 候选独立验收（第四十轮）

### 39.1 独立复跑命令与执行数据
- **验证脚本**：`tools/cordis-inject-probe/gateway-dispatch.mjs`（由架构与协议负责人实现，QA 全程独立复跑与核查）；
- **执行命令**：`node tools/cordis-inject-probe/gateway-dispatch.mjs`；
- **执行结果**：**退出码 0**，四大判定断言全绿通过；
- **隔离与环境保真度说明**：
  - 在操作系统临时目录构建独立沙箱 `gateway-arena`，从实装 `app.asar` 直接提取原装运行时包（`@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol` 等）；
  - 加载 Host 候选产物 `packages/dsh-gamecenter/staging/index.js`（默认 `apply(ctx)` 入口，不传任何 fakeProtocol 或 options）；
  - 依赖 stub 仅三项最小必须项（`typert` 强制 SRC 认领路径、`remoteAccess` 判 allow、`llm` 零 stream 目录探针，严禁调用真实模型）；未监听新端口、未启动替代服务器、未修改运行中 DSH 主程序与 profile。

### 39.2 建议四大断言独立复验结果（全部 PASS）
| 断言项 | 验证方式 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| **断言 1：默认 apply 注册服务** | 默认 `apply(ctx)`，断言 `remoteMounted === true` 且 `ctx.reflect.props['gameCenter'].type === 'service'` | `remoteMounted === true`，服务键 `gameCenter` 挂载就绪 | **PASS** |
| **断言 2：实装 Gateway 认领端点** | 调用原版 `TypertGatewayService.claimsEndpoint()` 逐个断言 | `gameCenter/handshake`: true<br>`gameCenter/modelCatalog`: true（全量 5 端点见单元测试） | **PASS** |
| **断言 3：实装 Gateway 分派调用** | 调用原版 `TypertGatewayService.invoke()` 模拟实际分派 | `handshake` 真实返回 generation/runtimeToken/tokenDigest<br>`modelCatalog` 真实返回 available:true/entries:[] | **PASS** |
| **断言 4：两独立协议副本协同** | 对比 asar 副本与仓库副本物理路径、版本及导出数 | `sameInstance === false`（宿主 asar 16 导出 vs 仓库 15 导出，版本均为 0.2.1-rc.2） | **PASS (跨副本)** |

**跨副本可行性根因结论**：原版 `@Remote` 装饰器写入的标记键为常量普通字符串 `"@deepseek-ai/dsh-typert-protocol/remote-methods"`，并非 `Symbol()`。不同路径加载的两套协议模块只要字符串键一致，Gateway 即可无缝识别并完成 SRC 路径认领与分派，消除了多副本 Symbol 隔离导致认领失效的隐患。

### 39.3 依赖声明与 Node 解析边界核查（响应 PM 要求）
1. **Host 包级依赖已完整声明**：
   - `packages/dsh-gamecenter/package.json` 的 `dependencies` 已显式包含 `"@deepseek-ai/dsh-typert-protocol": "0.2.1-rc.2"`；
   - 经 pnpm 安装后，`packages/dsh-gamecenter/node_modules/@deepseek-ai/dsh-typert-protocol` 为实体符号链接，指向 `.pnpm` 存储；
   - 根目录 `devDependencies` 的对应条目仅供根级类型检查探针使用；Host 运行时依赖**有包级独立声明**，并非偶然蹭用根 `node_modules`；
2. **Cordis 依赖纯净度**：
   - Host `src/` 中对 `@deepseek-ai/cordis` 仅存在 `import type { Context }` 声明，编译为 JS 产物（`staging/` 与 `lib/`）后无任何运行时 import；
   - 运行时完全依赖 DSH 宿主环境传入的上下文，不构成包级运行时依赖冗余；
3. **部署模式与 Node 模块解析约束（重要）**：
   - 当前 profile 部署采用 **Junction** 软链指向仓库目录，Node 默认按 realpath 解析模块路径，可准确顺着包内 `node_modules` 链找到协议包；
   - 实地排查真实 profile `<PROFILE_DIR>\node_modules\@deepseek-ai`，**目前并没有 `dsh-typert-protocol`**；
   - **关键边界警示**：若未来脱离 Junction 改用纯文件拷贝至 profile，由于 profile 自身缺少该包，会导致 Node `MODULE_NOT_FOUND`；当前 Junction 方式可安全解析。

### 39.4 全工程回归与产物整树锁定
- **全工程自动化测试**：
  - `pnpm run typecheck`：**退出码 0**，全量包类型检查通过；
  - `pnpm run test`：**退出码 0**，总计 192 项单元与契约测试全绿（Client 88/88，Host 94/94，Protocol 10/10，零失败、零跳过）；
  - `gateway-dispatch.mjs` 探针：**退出码 0**；
- **Host 产物整树对比与变更清单（严禁单文件替换）**：
  - 文件总数：两边各 21 个文件，孤儿文件 0 个；
  - **变动文件：共 9 个**（覆盖协议加载适配、服务核心实现与顶层导出）：
    - `index.d.ts` / `index.js` / `index.js.map`
    - `dsh-adapter/protocol.d.ts` / `dsh-adapter/protocol.js` / `dsh-adapter/protocol.js.map`
    - `remote/game-center-service.d.ts` / `remote/game-center-service.js` / `remote/game-center-service.js.map`
  - **整树哈希（作为部署完整性唯一判据）**：
    - 在线 `lib/` 整树摘要：`EB2D9A2B9CF2611ED5F45C376A836E89`
    - 候选 `staging/` 整树摘要：`CB4DDE0DB452C03C666EC1E05F218BA6`
  - **致命陷阱警示**：如果只复制 `staging/index.js` 单文件，`lib/remote/game-center-service.js` 仍维持旧版（内含空参 `@Remote` 和恒返回 `null` 的加载器），修复将**完全不生效**且 404 原样复现！必须执行**整树 21 文件全量覆盖**。
- **产物单文件哈希快照核对**：
  - **Host 在线基准**：`packages/dsh-gamecenter/lib/index.js`
    - SHA256：`8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`
  - **Host 全新候选**：`packages/dsh-gamecenter/staging/index.js`
    - SHA256：`93F30A7B51B8D857CF4B722B56F54E54986F7B520C2E38E76AE23A609BFA5222`
  - **Client 在线产物**：`packages/dsh-gamecenter-client/dist/client.js`
    - SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`
  - **Client 候选产物**：`packages/dsh-gamecenter-client/staging/client.js`
    - SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`

### 39.5 验收结论与部署检查单
1. **证据分栏**：本轮独立复核结果归入 `STATIC + UNIT + MOCK`（进程内装配原版 Gateway 与两副本协议断言），**明确不是 DSH-REAL**（未重启运行中 DSH 主程序与 GUI）；
2. **候选评审结论**：Host 候选 `CB4DDE0DB4…`（入口 `93F30A7B…`）成功闭环了 Gateway 认领与分派全链路，依赖声明真实有效，**具备部署资格，建议进入受控部署**；
3. **部署执行与回滚检查单（向 PM 汇报）**：
   - 步骤 1：新建独立备份目录（如 `lib.bak-gamecenter-20261019-host93f30`），整树备份当前 `lib/`，核对摘要为 `EB2D9A2B…`；
   - 步骤 2：将 `staging/` 下 21 个文件**整树覆盖**至 `lib/`，校验覆盖后 `lib/` 整树摘要精确等于 `CB4DDE0DB452C03C666EC1E05F218BA6`；
   - 步骤 3：确认孤儿文件为 0，且 Client 产物已在位为 `1BE7FDA8…`；
   - 步骤 4：通知用户正常退出并**重启 DSH 桌面主进程**（Host 在进程启动时装载，页面刷新无效）；
   - 步骤 5：重启后开窗点击诊断区，观测 7 项指标是否全绿；若异常，整树恢复备份并再次重启；
   - 步骤 6：严格要求：以上部署与重启必须在用户明确发出授权后方可执行。
4. **阶段0 状态**：维持 **进行中 / 未通过**，待重启并在真实 GUI 运行态观测到 7 项指标后方可推进阶段0验收结项。

## 40. Host 21 文件整树受控部署独立核验与重启前终态确认（第四十一轮）

### 40.1 授权与部署执行背景
- **用户授权记录**：用户于 2026-10-19 15:06 在群聊明确回复“授权 Host 更新并重启”；
- **执行角色**：项目经理指派 DSH Host工程师为唯一部署执行人，严格按 `docs/host-deploy-manifest.md` 冻结清单执行；
- **QA 介入**：部署完成后，测试与发布负责人立即执行完全独立的机械哈希复验与全仓自动化测试。

### 40.2 QA 独立整树哈希与文件清单复核（100% MATCH）
| 目标路径 | 验证项 | 预期基准 | QA 独立实测值 | 判定 |
| --- | --- | --- | --- | --- |
| `packages/dsh-gamecenter/lib/` | 文件总数 / 孤儿文件 | 21 文件 / 0 孤儿 | 21 文件 / 0 孤儿 | **PASS** |
| `packages/dsh-gamecenter/lib/` | 部署后整树摘要 (前32位) | `CB4DDE0DB452C03C666EC1E05F218BA6` | `CB4DDE0DB452C03C666EC1E05F218BA6` | **PASS (完全对齐)** |
| `packages/dsh-gamecenter/lib/index.js` | 核心入口单文件 SHA256 | `93F30A7B51B8D857CF4B722B56F54E54986F7B520C2E38E76AE23A609BFA5222` | `93F30A7B51B8D857CF4B722B56F54E54986F7B520C2E38E76AE23A609BFA5222` | **PASS** |
| `staging-rollback/lib.bak-host-EB2D9A2B-…` | 持久化回滚备份整树摘要 | `EB2D9A2B9CF2611ED5F45C376A836E89` | `EB2D9A2B9CF2611ED5F45C376A836E89` | **PASS (回滚源完好)** |
| `packages/dsh-gamecenter-client/dist/client.js` | Client 产物 SHA256 | `1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7` | `1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7` | **PASS (未被触碰)** |
| `<PROFILE_DIR>` | Profile 配置与 Junction | package.json `4AA2223B…`，Junction 指向正常 | package.json `4AA2223B…`，软链有效 | **PASS (隔离未动)** |

### 40.3 全工程回归与探针独立重跑
- **类型检查**：`pnpm run typecheck` → **全部通过，退出码 0**；
- **单元与契约测试**：`pnpm run test` → **全工程 192 项全绿，退出码 0**：
  - Client 88/88 PASS
  - Host 94/94 PASS（生产入口 `lib/index.js` 在真实 Context 下装配成功且 `remoteMounted=true` 已成内生断言）
  - Protocol 10/10 PASS
- **网关分派探针**：`node tools/cordis-inject-probe/gateway-dispatch.mjs` → **退出码 0**，四项判定全绿。

### 40.4 终态确认与重启交接
1. **部署状态**：已部署就绪，整树哈希完全吻合，备份源已固化，**具备重启生效条件**；
2. **交接流程**：由 QA 向项目经理报告复核通过；项目经理正式通知用户手动退出并重新打开 DSH 桌面主程序；
3. **阶段0 状态**：在用户完成重启并在真实 GUI 中取得诊断运行态观测数据前，阶段0结论维持 **进行中 / 未通过**。

## 41. 重启后首次 DSH-REAL 实机取证：HTTP 404 彻底根除与 Gateway 结果外层信封偏差定位（第四十二轮）

### 41.1 进程与无障碍树直接取证
- **运行中进程事实（DSH-REAL）**：
  - DSH 桌面主进程已由用户正常重启，新进程 PID 为 **27240**（父进程 `explorer.exe`）；
  - Host 插件子进程 PID 为 **21020**，命令行确实验证加载 `<PROFILE_DIR>`；
- **GUI 弹层无障碍树与屏幕截图读取（windowId 1182972）**：
  - 游戏中心弹层正常打开在前台，诊断表格完整渲染；
  - 截图已采集落盘（`dsh-click-da5201472407.png`，SHA256: `8574ee35c335ac560ce17018cf5f2047c1181ae23672d43b22c294b317600679`）。

### 41.2 实机 7 行诊断状态实际读取结果
| 诊断行 | 界面显示状态 | 界面详情文本 | 对比重启前事实 |
| --- | --- | --- | --- |
| 1. **Remote 挂载 ($mount)** | **正常** | `已挂载 (ctx.remote.gameCenter 就绪)` | 维持正常 |
| 2. **服务可达 (handshake)** | **正常** | `已连接 (代次 generation=0, 状态=running)` | **【重大突破】HTTP 404 彻底消失！** 端点认领与分派全链路连通 |
| 3. **模型目录 (modelCatalog)** | **告警** | `不可用 (failures=0: 服务未就绪)` | **【重大突破】HTTP 404 彻底消失！** 转为业务状态判定 |
| 4. **租约状态 (leaseStatus)** | **跳过** | `跳过 (未收到有效 runtimeToken 凭证)` | 前置代次与凭证保护触发跳过 |
| 5. **暂停闭环 (pause)** | **跳过** | `跳过 (未收到有效 runtimeToken 凭证)` | 同上 |
| 6. **旧代次拒写 (saveAck)** | **跳过** | `跳过 (未收到有效 runtimeToken 凭证)` | 同上 |
| 7. **保存确认 (saveAck)** | **跳过** | `跳过 (未收到有效 runtimeToken 凭证)` | 同上 |

### 41.3 核心突破与新偏差根因技术定位
1. **重大突破已确立**：
   - Host 新候选（`93F30A7B…`）21 文件整树部署在重启后完全生效，实装 Gateway 成功认领并分派了 `gameCenter` 服务；
   - 此前长期阻断的 `HTTP 404: Service 'gameCenter' has no method 'handshake'` **已被彻底修复消除**。
2. **偏差根因深度定位（Gateway 返回值外层信封包装）**：
   - **源码事实**：在实装 Gateway Client 端包装（`dsh-api-gateway/lib/client.browser.js` 第 1833-1836 行）：
     对于 direct invocation 的 RPC 成功调用，统一返回信封格式：
     `{ ok: true, value: <Host真实返回值> }`
   - **Client 侧未解包**：在 `packages/dsh-gamecenter-client/src/bridge/remote-mount.js` 的 `createGameCenterClient` 中：
     直接返回了 Gateway 的原始信封 `result`，未取出内层的 `result.value`；
   - **连锁表现**：
     - `handshake`：返回 `{ ok: true, value: { ok: true, generation: 1, runtimeToken: '...', state: 'running' } }`。Client 端代码直读 `hs.generation` 和 `hs.runtimeToken`，取得 `undefined`，兜底为 `generation=0`，`activeToken = null`；因为 `activeGeneration <= 0 || !activeToken`，防御性保护逻辑将后续 4 项租约操作标记为“跳过”；
     - `modelCatalog`：返回 `{ ok: true, value: { available: true, entries: [], failures: [] } }`。Client 端直读 `cat.available` 为 `undefined`（不等于 true），`cat.failures` 为 `undefined`（长度 0），渲染为 `不可用 (failures=0: 服务未就绪)`。

### 41.4 处置建议与阶段0判定
1. **职责划分**：
   - Host 侧：已无阻塞，404 彻底解决；
   - Client 侧：交由 **界面与运行时工程师** 在 `packages/dsh-gamecenter-client/src/bridge/remote-mount.js` 对 RPC 返回做信封展开（解包 `result.value ?? result`）；
2. **部署友好性**：Client 产物属于直连 bundle，修复后覆盖 `dist/client.js`，通过桌面端 `Ctrl+R` 即可热加载生效，**无需再次重启 DSH 桌面进程**；
3. **阶段0 状态**：维持 **进行中 / 未通过**。404 虽已解决，但完整的租约、暂停与关闭路径仍待 Client 解包适配后实测闭环。

## 42. Client 真实网关信封解包与契约异常强校验独立验收（第四十三轮）

### 42.1 修复代码与契约守卫独立审计
1. **真实网关信封双阶段解包（`remote-mount.js`）**：
   - 严格识别网关外层信封 `{ ok: true, value: <业务结果> }`：采用 `result.ok === true && Object.hasOwn(result, 'value') && Object.keys(result).length === 2` 精准解包；
   - **解包层级与口径约束（响应 PM 裁定）**：解包严格只在 `createGameCenterClient` 这一层针对 `remoteService` direct RPC 的原始返回执行恰好一次，上游 Remote 方法及下游调用方均无二次解包；同时明确“恰好两个键”是当前 DSH 0.2.1-rc.2 实装网关信封实现下的专用判据，不能泛化为通用无遗漏保证；
   - 保持两阶段失败校验：先检验网关级失败（`remoteFailureOf(result)`），解包后再检验内层业务级失败（`remoteFailureOf(unwrapped)`），消除了内层失败被漏判为成功的风险。
2. **根除全部假阳性兜底（`diagnostics.js`）**：
   - `handshake`：彻底消除 `?? 0` 与 `|| 'running'` 兜底，强断言 `ok === true && Number.isInteger(generation) && generation > 0 && typeof runtimeToken === 'string' && state 非空`。任一不符立刻判为 `status: 'fail'` 并呈现 `契约异常: 响应缺少必要业务字段`，绝不伪装成功；
   - `modelCatalog`：彻底消除 `failures=0` 默认文案“服务未就绪”，强断言 `available` 字段存在且为布尔值，缺失直接亮红灯判 `fail`。
3. **3 条新增关键契约负例实测全绿**：
   - 信封顶层 `ok:true` 但内层业务失败 `{ ok:false, errorCode:'AUTH_FAILED' }` → 准确抛出业务错误（PASS）；
   - 握手响应缺少 generation 或 runtimeToken → 严禁标正常，强判 `fail 契约异常`（PASS）；
   - 网关外层错误 `{ ok: false, error: { code: 'gateway/internal' } }` → 准确拦截抛出（PASS）。

### 42.2 QA 独立复验数据（全工程 195/195 全绿）
- **类型检查**：`pnpm run typecheck` → **全部通过，退出码 0**；
- **全量自动化测试**：`pnpm run test` → **195/195 全部真实通过，退出码 0**：
  - Client 包：**91/91 项全通过**（较上轮新增 3 项高阶契约与解包负例）；
  - Host 包：**94/94 项全通过**；
  - Protocol 包：**10/10 项全通过**；
- **网关分派探针**：`node tools/cordis-inject-probe/gateway-dispatch.mjs` → **退出码 0**，wireEnvelopes 确认实测一致；
- **候选与在线产物哈希快照**：
  - **当前在线运行 `dist/client.js`**：保持隔离未动，SHA256: `1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`；
  - **最新已验收加固候选 `staging/client.js`**：大小 **56263 字节**，SHA256:
    `427F79EA2F7CC06C1ED74BAEA665FA0EC41075746846DF6F8DAE9BCDBDE13110`。

### 42.3 部署交接与阶段0判定
1. **候选结论**：Client 加固候选 `427F79EA…` 完全通过静态、单元、集成、防误伤断言与信封负例校验，彻底根除了假阳性与信封未解包缺陷，**具备正式部署资格**；
2. **部署动作与生效约束（向 PM 汇报）**：
   - 范围仅限 Client 单端单文件：备份当前 `dist/client.js`（`1BE7FDA8…`），将 `staging/client.js`（`427F79EA…`）覆盖至 `dist/client.js`；
   - Host 侧与 profile **保持分毫未动**；
   - Client 是文件直连 bundle，部署后在桌面端执行 `Ctrl+R`（页面刷新）即可热加载生效，**完全无需重启 DSH 桌面主进程**；
3. **阶段0 状态**：在用户完成部署刷新并在真实 GUI 中观测到 7 项实测结果前，维持 **进行中 / 未通过**。

## 43. 427 修复版部署独立复验与受控刷新交接（第四十四轮）

### 43.1 部署就位与独立哈希核对（100% MATCH）
- **用户授权记录**：用户于 2026-10-19 16:32 明确回复“授权部署427版本并刷新”；
- **部署执行人**：界面与运行时工程师于 16:35 完成单文件替换；
- **QA 独立复验结果**：
  - 在线生产路径：`packages/dsh-gamecenter-client/dist/client.js`
    - 大小：**56263** 字节
    - SHA-256：`427F79EA2F7CC06C1ED74BAEA665FA0EC41075746846DF6F8DAE9BCDBDE13110`（与已验收候选 100% 一致）；
  - 持久化回滚备份：`packages/dsh-gamecenter-client/staging-rollback/dist-202610191633/client.js`
    - 大小：**54484** 字节
    - SHA-256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`（原样保留，回滚源可靠）；
  - 周边隔离：Host `lib/` 21 文件整树摘要与真实 profile 完好未动。

### 43.2 实机界面刷新交互与交接
- **自动化按键尝试**：针对 DSH 窗口（PID 4708，windowId 1510994）尝试触发 `Ctrl+R`，由于界面存在动态打字及桌宠动画，像素持续变动触发像素保护限制；
- **响应 PM 指示**：严格遵守 PM “工具受限则由 QA 请求用户手动一次，不双刷新” 的规范，不重复盲发自动化按键；
- **交接操作**：请用户在 DSH 桌面主窗口内按下 `Ctrl+R` 执行单次普通页面刷新，重新加载已就位的 427 修复版，打开“游戏中心”查看真实 7 项诊断数据；
- **阶段0 状态**：维持 **进行中 / 未通过**，待用户完成本次刷新后取证实际运行态指标。

## 44. 427 修复版实机加载（DSH-REAL）：7 项诊断全绿！阶段0 核心技术闭环达成（第四十五轮）

### 44.1 运行态实机观察证据（DSH-REAL，windowId 12389096，PID 23336）
- **观察渠道**：DSH 桌面主窗口无障碍树直接读取 + 屏幕截图采样（`dsh-click-4a82c8770256.png`，SHA256: `4b6bc3bc58316786eee662a47c7d1e21e91341e6f0d540c985c699d701e9b511`）；
- **实测时间**：2026-10-19 16:45；
- **运行态数据完整记录（7/7 项全绿通过）**：
  | 序号 | 诊断检查项 | 实测状态 | 界面完整输出详情（真实运行数据） | 契约与安全语义验证结论 |
  | --- | --- | --- | --- | --- |
  | 1 | **Remote 挂载 ($mount)** | **正常** | `已挂载 (ctx.remote.gameCenter 就绪)` | Client 成功向 Gateway 动态挂载 contribution，无死锁、无静默失败 |
  | 2 | **服务可达 (handshake)** | **正常** | `已连接 (代次 generation=3, 状态=running)` | 解包修复完全生效！真实取得代次 3 与有效 runtimeToken，HTTP 404 彻底消失 |
  | 3 | **模型目录 (modelCatalog)** | **正常** | `可用 (12 个模型): neuapi/deepseek-v4.1-flash, neuapi/glm-5.3-flash, neuapi/mimo-v2.6-flash…` | 真实读取到宿主配置的 12 个可用模型！只读脱敏投影生效，零 stream、零付费调用 |
  | 4 | **租约状态 (leaseStatus)** | **正常** | `状态=running, 代次=3, 存档版本=0` | 基于有效 runtimeToken 鉴权成功，正确反查当前运行实例与代次状态 |
  | 5 | **暂停闭环 (pause)** | **正常** | `已进入暂停 (state=pausing, timeoutMs=3000)` | 租约控制状态机正确从 running 推进至 pausing，超时窗口 3000ms 生效 |
  | 6 | **旧代次拒写 (saveAck)** | **正常** | `符合预期: 正确拒绝陈旧代次 [STALE_RUNTIME]` | **【关键安全边界】** 故意传入旧代次/过期凭据，Host 坚决拒绝并返回 `STALE_RUNTIME`！ |
  | 7 | **保存确认 (saveAck)** | **正常** | `已保存确认 (state=paused, revision=1)` | 正确凭证提交增量 revision=1，状态顺利收敛至 `paused` 封存 |

### 44.2 阶段0 验收矩阵（A0-1 ~ A0-7）细化证据映射与真实边界（响应 PM 裁定）
根据 `docs/gamecenter-design.zh-CN.md` §11 及项目经理派工口径，严格区分实机观测（`DSH-REAL`）、单元逻辑（`UNIT`）、源码分析（`STATIC`）与授权挂账（`AUTH-PENDING`），严禁泛化：

| 矩阵项 | 目标要求 | 实机观测事实（DSH-REAL） | 单元/静态/离线支撑（UNIT/STATIC） | 修正后验收结论 |
| --- | --- | --- | --- | --- |
| **A0-1** | 锁定 DSH 版本 | desktop 0.2.1-rc.2 / 332895e0…，运行 PID 23336 / 21020（DSH-REAL） | 声明承诺范围仅限此版本（STATIC） | **通过 (PASS)** |
| **A0-2** | Host 插件加载 | 实装 Cordis 启动装配，注册 `gameCenter` 服务，Gateway 成功认领分派（DSH-REAL） | `packages/dsh-gamecenter` package.json 声明（STATIC） | **通过 (PASS)** |
| **A0-3** | Client 显式装配与入口 | Loader 发现条目 + $mount 动态装配成功，UI 弹层正常渲染（DSH-REAL） | 无装配入口不出现负例仅在单测覆盖（UNIT），实机未测 | **核心装配通过 (PASS)**<br>实机负例未验证 |
| **A0-4** | Remote 往返通信 | 5 个 Direct RPC 方法（handshake, modelCatalog, leaseStatus, pause, saveAck）往返全通（DSH-REAL） | 原门禁中的“流式方法与取消”实机未配置端点，仅在单测与契约守卫覆盖（UNIT） | **核心 RPC 通过 (PASS)**<br>流式/取消待实机验证 |
| **A0-5** | 弹层与焦点共存 | `shell.overlay` list 槽追加渲染成功，未破坏其它已有侧边栏/主视图（DSH-REAL） | “多插件 overlay 同时开启共存”实机未测；Escape 焦点返回仅在单测覆盖（`focus.test.mjs`，UNIT），实机无按键取证 | **部分通过 (PASS)**<br>Escape焦点与多弹层共存未实机验证 |
| **A0-6** | 模型目录只读脱敏 | 真实枚举宿主 12 个可用模型，UI 呈现脱敏项，零 stream 达成（DSH-REAL） | 白名单过滤由代码强断言（UNIT），实机 wire 传输层未抓包；真实模型调用未经授权，标为 **AUTH-PENDING** | **只读目录通过 (PASS)**<br>真实调用 AUTH-PENDING |
| **A0-7** | 控制租约与代次隔离 | 基础流转（running→pausing→paused）、代次 3 凭据通过、旧代次拒写 STALE_RUNTIME 生效（DSH-REAL） | 单次代次=3 不等同多轮严格递增实证；timeoutMs=3000 仅为返回字段非超时实测；租约过期清理、关闭触发 pause、在途取消仅在单测（UNIT） | **核心状态与拒写通过 (PASS)**<br>超时/清理/在途取消未实机验证 |

### 44.3 阶段0 最终对账定论
1. **核心里程碑达成**：无付费核心 Remote 通信链路、网关分派、解包透传、只读模型目录投影及核心陈旧代次拒写安全边界，均已取得真实的 `DSH-REAL` 运行态证据，**无付费核心 Remote 闭环正式通过 (PASS)**；
2. **拒绝过度泛化**：原门禁中关于“流式与取消、多弹层共存/Escape焦点原位返回、实际计时超时/在途请求取消、真实模型计费调用”等项，未在实机取得完整观察证据的，**绝不冒充 DSH-REAL 通过**，分别定性为 `UNIT-ONLY`、`未实机验证` 或 `AUTH-PENDING`；
3. **阶段0 整体状态定论**：**无付费核心 Remote 闭环通过 / 阶段0 完整门禁收敛中**。

### 44.4 阶段0 真实证据链缺口核定与收尾方案（响应 PM 严谨指示）

#### 一、关闭触发停收与代次实测定界（A0-7）
1. **关闭探针缺口核实（不冒充闭环）**：
   - 源码查证：`packages/dsh-gamecenter-client/src/index.js` 第 132-136 行，弹层关闭收敛点 `requestPause` 检查 `lease === null` 时直接返回 `{ kind: 'saved', message: '当前没有运行中的游戏。' }`，并未发起 Host Remote `pause`；
   - 诊断隔离：诊断区 `RemoteDiagnostics` 是独立创建临时探针实例，其第 7 步 `saveAck` 已主动将该探针租约收敛至 `paused`；
   - **结论**：当前实机页面**并没有**一个维持 `running` 状态并与关闭弹层动作直接绑定的端到端探针；此时即使按 Escape 关闭弹层，也无法证明“关闭动作触发了 Host 租约停收”。**确认为 A0-7 的实机探针缺口，不使用 Escape 冒充闭环**。
2. **代次自增观察值定界**：
   - 16:45 观测为 `generation=3`，17:02 观测为 `generation=4`，**客观定性为“记录两次实际观测值递增”**，不夸大定性为“已证明所有情况下严格单调”。

#### 二、流式与取消语义缺口核实（A0-4 / A0-7）
1. **取消机制查证**：
   - 源码查证：实装 Gateway 客户端（`client.browser.js` 第 1828 行 `prepared.signal.throwIfAborted()`），若传入已 abort 的 signal，在客户端 RPC 发出前即被抛出 `cancelledFailure`；
   - **结论**：已 abort 信号只能证明客户端本地请求前取消，无法证明远端 Host 或 Provider 执行中的在途取消；当前实机未暴露长耗时/流式端点，**实机在途取消与流式增量确认为阶段0实机证据缺口**（单元测试已覆盖逻辑，实机挂账）。

#### 三、真实模型调用申请规格核验（A0-6，维持 AUTH-PENDING）
1. **配置只读核对（无探测）**：
   - 查阅 `<PROFILE_DIR>\cordis.patch.yml`：`neuapi` 下已存在 `id: deepseek-v4.1-flash`（最大 context 1000000，maxTokens 128000），模型标识确实存在；
   - 字段兼容性：`maxTokens: 50` 属于 standard openai-completions 规范，适配器可正常透传；
2. **风险与硬约束定界**：
   - 必须关闭一切自动重试；
   - 明确流式首 chunk 包含 metadata/role 而非必定为纯文本增量；
   - 取消操作由 HTTP 连接中断实现，不保证 upstream provider 免计费，亦不假设模型绝对输出固定词；
   - **该项严格维持 AUTH-PENDING，待用户单独明确授权**。

### 44.5 阶段0 最终验收结论（全面收紧）
- **无付费核心 Remote 通信与租约闭环**：**实机验证通过 (PASS)**（包括 $mount 挂载、两端服务可达、7 项诊断全通、代次 3→4 递增观测、12 模型目录只读枚举、旧代次拒写 STALE_RUNTIME 拦截）；
- **阶段0 全量门禁状态**：**未完全闭环 / 核心闭环达成**；关闭触发停收实机探针、在途执行中取消、Escape 焦点原位返回、真实模型调用（AUTH-PENDING）列入收尾清单，不转嫁阶段1，不擅自修改在线产物。









