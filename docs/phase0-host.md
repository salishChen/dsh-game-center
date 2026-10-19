# 阶段0 Host 侧契约、实装证据与阻塞（DSH Host工程师）

建立时间：2026-10-18。唯一设计基线：`docs/gamecenter-design.zh-CN.md`（本轮再次全文读取 484 行）。
证据分栏沿用 `docs/phase0-acceptance.md`：`STATIC` / `UNIT` / `MOCK` / `BUILD` / `DSH-REAL` / `AUTH-PENDING`。
脱敏约定（2026-10-19）：文中 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>` 为路径占位符，**不是可直接执行的路径**；摘要值取自脱敏前样本，未重算。

> **本文最高只到 `BUILD` + `UNIT` + 部分 `STATIC`。`DSH-REAL` 未产出，阶段0 未通过。**
> 特别说明：本文 §2 的所有 DSH 结论都来自**只读读取安装包源码**，不是运行时观测；
> 运行时是否已装配本插件，本轮**没有**验证（见 §6）。

## 1. 版本锁定（与架构/Client 一致）

| 字段 | 值 | 来源 |
| --- | --- | --- |
| `@deepseek-ai/dsh-desktop` | `0.2.1-rc.2` | `resources/runtime/primary-runtime/runtime.json` |
| 构建提交 | `332895e0f7c9d4dbfb29729f5eb367fa263ff986` | 由架构负责人与 Client 工程师从 asar 根 `package.json` 读出 |
| 通道 | `nightly` | `resources/app-update.yml` |
| Node / pnpm（随包运行时） | `24.21.0` / `11.28.5` | `runtime.json` |

**口径**：Host 契约只对 `332895e0…` 有效，不外推到基线引用的 `687f282e…`（两者版本号相同、提交不同）。

## 2. Host 侧真实扩展点（`STATIC`，逐条有源码位置）

| # | 事实 | 源码位置 |
| --- | --- | --- |
| 1 | Host 插件形态是 ESM 模块导出 `apply(ctx)` + `inject` | `dsh-api-remotes/lib/index.js`（`export { API_REMOTE_FORWARDED_EVENTS, apply, inject }`）、`dsh-host-plugin-inventory/lib/index.js` |
| 2 | 业务服务继承 `TypertRemoteService`，`super(ctx, serviceKey, options?)`，构造时写入 `this.typertRemote = bindTypertRemote(this, name, options)` | `dsh-typert-protocol/lib/index.js` |
| 3 | `bindTypertRemote(service, serviceKey, options)`：`namespace = options.namespace ?? serviceKey`，返回**冻结**的 `{service, serviceKey, namespace}` | 同上 |
| 4 | Gateway 用 **SRC 回退**发现未生成描述符的服务：`collectSrcClaims()` 遍历 `ctx.reflect.props` 中 `type === "service"` 的项，读 `typertRemote.namespace` 与 `remoteMethods(original)`，拼出 `<namespace>/<method>` 端点 | `dsh-api-gateway/lib/index.js` |
| 5 | 标记读取器 `remoteMethods(service)` 从**原型**上的带版本描述符取值，版本必须为 `1` | `dsh-typert-protocol/lib/index.js` |
| 6 | `@Remote` 公开函数：`Remote(exportName?: string)` / `Remote(options)` 返回 stage-3 method decorator；`Remote(x, context)` 且 `context === undefined` 时抛 `TypeError` | 同上 `function Remote(methodExportOrOptions, context)` |
| 7 | 支持取消的方法把 `signal: AbortSignal` 声明为**最后一个 Host 参数**；它是 descriptor 元数据，由 Gateway 在业务参数之后注入，**不是 wire 参数** | `dsh-api-gateway/README.zh.md`「支持取消的 Remote 方法」+ `prepareInvocation` 的 `src-json` 参数构造 |
| 8 | 返回形状要求：一元结果须为无损 JSON；`src-json` 编解码只校验 JSON 可表示 | `dsh-api-gateway/README.zh.md`、`dsh-typert-protocol` 的 `isRemoteJsonValue` |
| 9 | `ctx.typertGateway` 是 `TypertGatewayService`（`super(ctx, "typertGateway")`，`static inject = ["typert","remoteAccess"]`） | `dsh-api-gateway/lib/index.js` |
| 10 | **Client 侧装配是显式白名单**：`dsh-api-remotes` 的 Client `apply()` 逐个 `await ctx.remote.$mount(TYPERT_REMOTE$n)`，列表写死在源码里，共 26 个贡献 | `dsh-api-remotes/lib/client.js` 第 23644–23687 行 |
| 11 | `ctx.remote.$mount(contribution)` 校验后 `ctx.typert.remotes.register()` 并安装 `remote.<namespace>` 子服务 | `dsh-api-gateway/lib/types/client/index.js` `$mount` / `mountContribution` / `validateContribution` |
| 12 | `ctx.typert.register()` 只接受**生成的** contribution（`validatePackage` + `validateSchemas` + `localStore.commit`），裸 SRC 服务不进 localStore | `dsh-typert-registry/lib/index.js` |

**由 #10–#12 得出的硬结论**：第三方 Host 服务能被 Host 端 Gateway 的 SRC 模式发现（#4），
但**不会**自动变成 Client 的 `ctx.remote.gameCenter`——Client 侧需要一份生成的
`TypertRemoteContribution` 被显式 `$mount`。这正是基线 §1「不能认为写上 `@Remote` 就会自动出现在所有 Client 中」的源码级证据。

## 3. 本轮交付（文件所有权：`packages/dsh-gamecenter/**`、`docs/phase0-host.md`）

```text
packages/dsh-gamecenter/
  package.json                 # ESM，main/exports → lib（构建产物），dependencies 仅 protocol
  tsconfig.json                # 复用根 tsconfig.base；paths 映射 protocol 源码；lib 含 DOM 仅为 AbortSignal
  src/index.ts                 # Cordis 插件入口：export apply(ctx, options?) / inject = ['llm']
  src/dsh-adapter/context.ts   # DSH 上下文最小结构类型（不用 any，保留 tsc 捕获能力）
  src/dsh-adapter/protocol.ts  # 协议包加载适配 + 命名空间常量（gameCenter）
  src/runtime/lease.ts         # 运行代次与控制租约状态机
  src/ai/model-catalog.ts      # 模型目录只读脱敏投影
  src/remote/game-center-service.ts  # gameCenter Remote 服务 + 接线契约
  test/*.test.mjs              # UNIT 37 项
  tools/probe-*.mjs            # 只读访问 app.asar 的探针（不修改安装目录）
docs/phase0-host.md
```

### 3.1 与 Client 的接线契约（界面与运行时工程师可直接照此接）

命名空间：`gameCenter`（**本项目拟新增**，DSH 中不存在）。服务键 `gameCenter`。

| 方法 | wire 入参 | wire 出参 | 错误语义 |
| --- | --- | --- | --- |
| `handshake` | `{runtimeInstanceId, nonce, gameId, gameVersion, sdkVersion, bridgeVersion}` | `{ok, generation?, tokenDigest?, state?, errorCode?, message?}` | `bridgeVersion≠1` → `PROTOCOL_INVALID`；同存档已有活跃实例 → `STALE_RUNTIME` |
| `pause` | `{generation, reason}` | `{accepted, state?, timeoutMs, error?}` | 旧代次 → `STALE_RUNTIME`；重复暂停幂等接受 |
| `saveAck` | `{generation, revision}` | `{accepted, state?, lastPersistedRevision?, error?}` | 旧代次/已封存 → `STALE_RUNTIME`；未在 pausing → `PROTOCOL_INVALID`；revision 非递增 → `PROTOCOL_INVALID` |
| `leaseStatus` | `{gameId, saveId}` | `{absent:true}` 或 `{state, generation, expiresAt, lastPersistedRevision}` | 无 |
| `modelCatalog` | 无 wire 参数（末尾 `AbortSignal` 由 Gateway 注入） | `{available, entries[], failures[]}` | `available:false` 表示 `ctx.llm` 不可用，**不是**"没有模型" |

关键约定：

1. **`generation` 由 Host 下发**，Client 不得自选，也不得用旧响应的代次继续写入。
2. **`saveAck` 只在 `pausing` 状态被接受**；Client 的暂停流程应为
   `pause()` → 等游戏快照 → `saveAck({generation, revision})` → 销毁实例。
   `accepted:false` 时按 `error.code` 分支：`STALE_RUNTIME` = 自己被顶替（不要再写），
   `PAUSED`/`PROTOCOL_INVALID` = 状态不符（停止等待，按超时回落处理）。
3. **暂停超时 3000ms** 由 Host 在 `pause()` 响应里返回 `timeoutMs`，Client 不要各自硬编码。
4. **`runtimeToken` 原文不跨 wire 下发**，只返回 `tokenDigest`。若后续需要游戏侧凭证，
   必须走独立的一次性通道并在协议评审中增加字段——本轮**不做**，以免在未验证的传输上引入凭据泄露面。

### 3.2 租约状态机（`src/runtime/lease.ts`）

`pending → running → pausing → paused`，异常分支 `pausing → recovery-available`，正常结束 `→ stopped`。

- **单存档单控制者**：同 `(gameId, saveId)` 已有活跃租约时，新实例 `acquire()` 返回 `STALE_RUNTIME`，
  **不顶替**（基线 §8.4「从另一个窗口接管时先暂停旧实例」）。
- **代次严格递增**：`generation <= previous` 一律拒绝。
- **旧代次拒写优先于暂停判定**：`checkWritable()` 先比代次再判封存/状态，
  保证旧代次拿到的是 `STALE_RUNTIME` 而不是笼统 `PAUSED`。
- **超时不伪造成功**：`abandonPause()` 进入 `recovery-available` 且**不产生 revision**。
- **过期检测是惰性 + `sweepExpired()` 显式扫描**，不假装实时；启动对账由调用方驱动。

### 3.3 模型目录只读投影（`src/ai/model-catalog.ts`）

- 只调用 `listProviders()` / `listModels(provider)`，**绝不**调用 `stream()` 或任何探测；
  单测用"若调用 stream 就失败"的哨兵对象验证这一点。
- 目录信息只输出 `inputModalities`，`outputModalities` 恒为空数组——**不从输入推出图像输出**。
- `status` 恒为 `unknown`，`evidence` 为 `dsh-catalog`：没有 adapter 证据就不宣称支持。
- 字段白名单 + 敏感字段负例测试：即使 DSH 模型对象带 `apiKey/baseURL`，投影结果也不包含。

## 4. 实际执行的命令与退出码（本轮）

| # | 命令 | 退出码 | 结论 |
| --- | --- | --- | --- |
| 1 | `read docs/gamecenter-design.zh-CN.md` | 0 | 484 行全文已读 |
| 2 | `read docs/phase0-client.md`、`docs/phase0-architecture.md`、`packages/protocol/src/*.ts` | 0 | 已按他人契约建模，未修改他人文件 |
| 3 | `node tools/asar-grep.mjs` / `probe-*.mjs`（读 asar 内 6 个包） | 0 | §2 全部结论来源 |
| 4 | `npx -y -p typescript@5.7.3 tsc -p packages/dsh-gamecenter/tsconfig.json` | **0** | `BUILD` 通过（strict + exactOptionalPropertyTypes + noImplicitOverride） |
| 5 | `node --test packages/dsh-gamecenter/test/*.test.mjs` | **0** | `UNIT` **37/37 通过**（11 + 10 + 10 + 6） |
| 6 | `node packages/dsh-gamecenter/tools/probe-host-assembly.mjs` | **0** | 汇总 `{STATIC:1, EXPECTED-FAIL:1, NOT-AVAILABLE:1, OK:9}`，见 §5 |
| 7 | `pnpm install --filter '@dsh-gamecenter/host' --offline` | **1** | `ERR_PNPM_NO_OFFLINE_META`（先 `@deepseek-ai/cordis`，后 `esbuild@0.28.2`，属 client 包的 devDependency）；**未绕过**，改用 tsconfig `paths` 解析 protocol |

### 4.1 本轮踩到的两个真实坑（供其他人避让）

1. **Node 直接跑 TS 时相对 import 必须写 `.ts`**：写 `./x.js` 会 `ERR_MODULE_NOT_FOUND`。
   而 `tsc` 又要求开 `allowImportingTsExtensions`。已在 `packages/dsh-gamecenter/tsconfig.json` 同时满足。
2. **`rootDir` 不能指向包里**：`protocol` 走 `paths` 映射进 program 后，`rootDir` 会报 `TS6059`。
   本项目所有包都是 `noEmit`，因此不设 `rootDir`。
3. **PowerShell `Get-Content -Raw | Set-Content` 会破坏 UTF-8 中文源码**（本轮一次文件损坏已重建）。
   改写含中文的源文件只用 edit/write 工具。

## 5. 探针实际输出（原文要点）

```text
[STATIC]       协议包在安装包内 — .../app.asar/dsh/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js
[EXPECTED-FAIL] 直读 asar 内协议包 — ERR_MODULE_NOT_FOUND（Node 不认 asar 虚拟文件系统）
[NOT-AVAILABLE] probeProtocol() — Cannot find package '@deepseek-ai/dsh-typert-protocol'
[OK] apply() 装配 Remote 服务 — remoteMounted=true
[OK] 协议包缺失时降级 — remoteMounted=false
[OK] handshake 下发 generation — generation=1 tokenDigest=noncrypto-fnv1a64:...
[OK] 旧代次 saveAck 被拒 — error=STALE_RUNTIME
[OK] 当前代次 saveAck 接受 — state=paused
[OK] 模型目录在无 ctx.llm 时如实报告不可用 — available=false
```

**这些 `OK` 的含义必须说清楚**：它们证明"本包逻辑正确、装配形状正确、
缺依赖时如实降级"，**不证明** DSH 进程里已经跑起来 `gameCenter` 服务。

## 6. 未验证项与阻塞（交项目经理）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| DSH 进程内装配 Host 插件 | **未验证** | 需要把本包登记进玩家 profile 的 Loader 条目并重启 GUI（配置类变更，须用户批准） |
| `collectSrcClaims()` 实际把本服务认成 5 个端点 | **未验证** | 需要在运行中的 Host 里读 `ctx.reflect.props`，本轮无该通道 |
| Client `ctx.remote.gameCenter` 可调用 | **未验证**，且**已知缺件** | 见 §2 #10–#12：需要一份生成的 `TypertRemoteContribution` 被 `dsh-api-remotes` 显式 `$mount`；本轮**没有**这个产物 |
| 一次真实模型调用 | **未验证 / `AUTH-PENDING`** | 需用户单独授权付费调用；本轮只做只读目录投影 |
| `@Remote` 装饰器在**真实**协议模块下施加成功 | **未验证** | 本轮用假协议模块验证了调用形状；真实模块下的 `remoteMethods()` 读取依赖 stage-3 decorator 语义，须在 DSH 进程内验证 |
| 包构建产物 `lib/` | **不存在** | `main`/`exports` 指向 `lib/index.js`，本轮只做 `noEmit` 类型检查；真实装载前必须有构建步骤（与 Client 的单文件打包同批解决） |

### 6.1 需要项目经理决策的三件事

> **2026-10-18 23:20 更新**：项目经理已定主线为 (b)——验证公开 `ctx.remote.$mount()` 接受外部
> contribution。我接受该决定，并已按此方向交付 Host 侧 descriptor 契约（见 §8）。
> 我此前"本机没有合法办法生成 contribution"的表述**过强**：正确的说法是
> **发行版不带 generator（已独立复核，见 §8.1），但 `$mount` 是公开方法、按形状校验，
> 材质上可以用外部构造的 contribution 满足**。缺 generator 只说明"不能自动生成"，
> 不等于"不能手写对齐"。

## 7. 明确的"不做"承诺

- 不修改 DSH 安装目录、不重启 GUI、不启动替代服务器。
- 不写玩家 profile、不改 ACL、不绕过沙箱。
- 不把 `UNIT`/`BUILD` 说成 `DSH-REAL`。
- 不声称 DSH 日志与 SQLite 有跨存储统一事务；不承诺外部 provider exactly-once。
- 不把 `noncrypto-fnv1a64` 说成密码学摘要（升级点已写在 `src/index.ts` 注释里）。

## 8. Remote 主线 (b)：外部 contribution 的 descriptor 契约（2026-10-18 补）

PM 定主线为 (b) 后，我按只读源码逐条核实了公开 `ctx.remote.$mount()` 的挂载与调用路径。
**代码**：`packages/dsh-gamecenter/src/remote/contribution-shape.ts`；
**测试**：`test/contribution-shape.test.mjs`。

### 8.1 generator 缺失（已独立复核，仍成立）

`node tools/probe-typert-generator.mjs` 退出码 0：asar 内 306 个 `@deepseek-ai/*` 包中，
名字含 typert 的只有 `loader` / `protocol` / `registry`；全包名搜 generator 零命中；
`dsh-api-remotes/lib/client.js` 的挂载列表是硬编码 26 条。
**但**这只说明"不能自动生成"，不说明"不能手写满足形状"。架构与协议负责人独立复核后同样背书。

### 8.2 挂载期真实校验（`validateContribution` → `requireStrictInputs`）

出处 `dsh-api-gateway/lib/client.browser.js` @80241：

```text
function requireStrictInputs(descriptor) {
  for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, endpoint, parameter.wire);
  if (descriptor.uplink !== void 0) requireStrictCodec(descriptor.uplink.codec, ...);
  if (descriptor.invocation.kind === "context") requireStrictCodec(descriptor.invocation.codec, ...);
}
function requireStrictCodec(codec, endpoint, field) {
  if (codec.mode !== "strict") throw new Error(... has no strict codec);
}
```

→ **必须项**：每个 `parameter.codec.mode === "strict"`；`invocation.kind === "direct"`；
`descriptor.scope` **不填**——填了会进入 scoped 路径并要求"唯一 lookup 参数"匹配，
我们是无作用域调用。

> **2026-10-18 23:40 修正（测试与发布负责人指出，我复核后确认自己判宽了）**：
> `requireStrictInputs` 只查 `parameters` / `uplink` / `invocation.codec(context)` 三处，
> **完全不查 `result`**。所以准确边界是「**参数不能用 src-json，result 可以用**」，
> 而我此前写成"`result.mode` 必须是 strict"是错的。
> `result: {mode:'src-json'}` 在 gateway 层放行，在 registry 层的 `validateCodec`
> 也因 `if (codec.mode === "src-json") return;` 放行（registry 的 `validateInvocation`
> 确实会 `validateCodec(descriptor.result, ...)`，但 src-json 直接 return）。
> 已用 3 项新测试锁定这个精确边界（`test/codec-gate.test.mjs`，现 9/9）。
> **注意**：由于 §8.3 说明 `descriptor.result.decode` 缺省时原样返回，
> 本项目仍统一用 `result: {mode:'strict'}`——不是因为必须，而是保持一致、便于日后接 codec。

### 8.3 调用期：参数不经 Client 编码

出处同文件 `invokeUnary` @70089：

```text
const result = await connection.rpc.call("/api", endpoint, { args: prepared.args }, prepared.signal);
... value: descriptor.result.mode === "strict" && descriptor.result.decode !== void 0
      ? descriptor.result.decode(result.value) : result.value
```

源码中**没有** `.encode(` 调用点。含义很重要：

- `codec.mode === "strict"` 在 Client 侧实际是**格式闸门**，不会执行我们写的编解码逻辑；
- `result.decode` 可省略，省略则原样返回 Host 的 JSON；
- 真实参数校验发生在 Host（`validateArguments`），所以 **wire 字段名必须与 Host 形参名一致**。

### 8.4 Host 侧发现顺序（决定 SRC 会不会被用）

出处 `dsh-api-gateway/lib/index.js` @44842 `prepareInvocation` / `resolveDescriptor`：

1. `ctx.typert.local.get(endpoint)` 命中 → 用严格生成描述符；
2. `ctx.typert.local.hasSeen(endpoint)` 为真但已撤回 → 抛 `gateway/definition-unavailable`，
   **禁止 SRC 回退**；
3. 否则 `resolveSrcDescriptor()` 以 SRC 模式接受 `@Remote` 标记的服务。

我们是第 3 条。这是一条真实风险：**若将来某个生成的 contribution 注册了同名端点又被撤回，
我们的 SRC 端点会连带失效**。阶段0 命名空间用 `gameCenter`（单段、自定义），当前不冲突。

### 8.5 取消：descriptor 不填 cancellation，Host 就不会注入 AbortSignal

`prepareInvocation` 中：`if (descriptor.cancellation !== void 0) args.push(signal);`

→ 我的 `modelCatalog` 形参是 `(signal: AbortSignal)`，Client descriptor **必须**声明
`cancellation`，否则 Host 调用时会因少传参数报 `gateway/signature-invalid`。
这条容易漏，已在 `contribution-shape.ts` 固化为必填项并加测试。

### 8.6 给 Client 的五个 descriptor（可直接抄）

```text
namespace: gameCenter          invocation: { kind: 'direct' }
handshake   params: [{name:'input', wire:'input', codec:{mode:'strict'}}]  result: {mode:'strict'}
pause       params: [{name:'input', wire:'input', codec:{mode:'strict'}}]  result: {mode:'strict'}
saveAck     params: [{name:'input', wire:'input', codec:{mode:'strict'}}]  result: {mode:'strict'}
leaseStatus params: [{name:'input', wire:'input', codec:{mode:'strict'}}]  result: {mode:'strict'}
modelCatalog params: []                                    result: {mode:'strict'}
             cancellation: 必填
```

**可执行版本**：`gameCenterDescriptors()` / `createGameCenterContribution()` /
`validateContributionShape()` 在 `src/remote/contribution-shape.ts`，
`validateContributionShape()` 逐条复刻 §8.2 的规则，可在不装载 DSH 的情况下抓出 codec 写错的坑。

### 8.7 本轮证据与仍未验证的部分

- `tsc` exit 0；`node --test` **52/52 通过**（含 9 项 codec/形状测试）。
- **未验证**：真实 DSH 里 `ctx.remote.$mount()` 是否接受这份 contribution（需装载后执行）；
  `installNamespace` 为方法安装的具体可调用形态；真实一次 Host↔Client 调用往返。
- 我不能把 §8 说成"端到端已通"。它是**逐字段核实过的形状契约 + 本地校验器**。

## 9. 真实加载准备（变更单素材，**未执行任何变更**）

本节只做只读核实与方案准备。**没有修改 profile、没有安装进运行中的 DSH、没有重启 GUI、
没有启动替代服务。** 全部命令与结论都可复现，且都不产生付费调用。

### 9.1 profile 装配机制（`STATIC`，逐条有源码行号）

出处均为 `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（只读 asar）。

| # | 事实 | 行号 |
| --- | --- | --- |
| 1 | 装配入口是 `loadProfileDirectory()`，它读 `<profile>/package.json` 的 `dsh.profile.bundles` 数组，逐个当作 bundle 层 | 1015-1016 |
| 2 | 每个 bundle 先 `resolveBundleDir()`：依次在 **DSH 安装锚点**、**profile 的 package.json 锚点** 下解析包目录；解析不到就抛错并提示 `dsh plugin --profile <name> install` | 1020-1021 |
| 3 | **`dsh.bundle` 是硬性必需**：`if (bundle === void 0) throw ... declares no dsh.bundle in its package.json` | 1023-1024 |
| 4 | `dsh.bundle.patch` 必须是字符串路径或字符串路径数组，否则 `dsh.bundle.patch must be a file path or a list of file paths` | 513-519 |
| 5 | 兼容性校验 `evaluatePluginCompatibility(bundleManifest, exemptions)` 失败会抛错，除非该包在豁免表里 | 1025-1026 |
| 6 | 每个 bundle 的 patch 文件按顺序 `flatMap` 成层层叠加，最后再叠 profile 自己的 `cordis.patch.yml` | 1027-1042 |
| 7 | 失败不中断启动：任何 bundle 出错都被收进 `skippedBundles` 并继续，**不会打印** | 1035-1040 |
| 8 | `unmetRequirements()`：**自有 `engines.dsh` 单独决定结果，`peerDependencies` 被完全忽略**；`engines.dsh` 必须在使用方 `package.json` 的**顶层** | 10573 附近 |

### 9.2 由此得出的两个**我方必需改动**（都在我拥有的包内，尚待执行）

对照一个已验证可加载的第三方插件
`~/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-skill-explorer/package.json`：

```text
"dsh": {
  "engines": { "dsh": ">=0.2.0-rc.2" },      <-- engines.dsh 在 dsh 对象内
  "bundle":  { "patch": "./cordis.patch.yml" },
  "client":  { "inject": [...], "platform": "web" }
}
```

**缺口 A（Host 包，我的文件）——已于 §10 补齐，此处保留为历史记录。**

原状：`packages/dsh-gamecenter/package.json` **没有 `dsh` 字段**，缺 `dsh.bundle.patch`。
按 §9.1 #3，它作为 bundle 加载会直接被跳过（且不打印）。
另外 `engines.dsh` 目前在**顶层**，而 #8 读的是 `fields.engines`（package.json 顶层引擎），
两者一致、当前写法可用；为与实装插件一致，已同时放进 `dsh.engines.dsh`。

> **2026-10-19 00:1x 说明**：测试与发布负责人实测时 `dsh.bundle.patch` 与 patch 文件**已经存在**
> （因为我已在 §10 补上），他因此指出我的表述会让人误以为还有两个未修项。
> 他的更正正确。**当时（§9 撰写时）确实两项都缺**，但我没有在补齐后回改本节，
> 这是我的问题——补完前置项却没有同步纠正旧文字，等于给读者留了过期的结论。

**缺口 B（Host 包，我的文件）——已于 §10 补齐。**

原状：`packages/dsh-gamecenter/` **没有 `lib/` 构建产物**，
`package.json` 的 `main`/`exports` 指向 `lib/index.js` 而该目录不存在，
真实装载会 `ERR_MODULE_NOT_FOUND`。`tsconfig.json` 是 `noEmit: true`。

**缺口 C（Client 包）——2026-10-18 23:50 更正：不是缺口，我此前判错了。**

`resolveMeta()`（`dsh-client-modules/lib/index.js` 第 720-750 行）的工作方式是：
它拿 **Loader 已装载条目的模块名**（`loaderName`）去 `locatePkgJson()` 找最近的 `package.json`，
再读该包的 `dsh.client`（第 731-732 行）与 `exports["./client"]`（第 737 行）算出 `clientPath`。

**关键点：Client 侧走的是 Loader 条目，不是 `dsh.profile.bundles`。** 所以：
- Client 包**不需要** `dsh.bundle`，也**不需要**出现在 `dsh.profile.bundles` 里；
- 只要它的 **Host 半**作为 Loader 条目被装载（`name` 能被解析到该包），Client 半就会自动被发现；
- 若声明了 `dsh.client` 却缺 `exports["./client"]`，会抛
  `declares dsh.client but exports no "./client" bundle`（第 738 行）。

因此正确做法是：**只登记 Host 包**，Client 包作为其依赖或同目录包被解析即可。
`dsh.profile.bundles` 里加 `"@dsh-gamecenter/client"` 反而会因为缺 `dsh.bundle` 被跳过（§9.1 #3）。

> 这一条我此前写反了，原因是我把 Host bundle 的规则套到了 Client 上。
> 感谢界面与运行时工程师提供入口信息，使我在真实授权前发现。

**已核实的 Client 入口现状（2026-10-18 23:47 实测）**：

| 字段 | 值 |
| --- | --- |
| `main` | `dist/client.js` |
| `exports["."].default` | `./dist/client.js` |
| `exports["./client"].default` | `./dist/client.js` |
| `dsh.client` | `{"platform":"web","inject":[]}` |
| `dsh.bundle` | **不存在**（按上面结论，Client 不需要） |
| `peerDependencies` | 无 |
| `dist/client.js` | 27281 字节，sha256 前 16 位 `9ceac9e0def38dbf`，首行 `window.__ModuleLoader__.load({`，无顶层 import |

三处入口已由界面与运行时工程师从 `lib/client.js` 改为 `dist/client.js`，
与测试与发布负责人 §8 的阻断级发现一致，我已实测确认改到位。

### 9.3 目标配置文件与现状（敏感值不输出）

| 文件 | 现状用途 | 敏感内容处理 |
| --- | --- | --- |
| `~/.dsh/profiles/desktop/package.json` | `dsh.profile.bundles` 决定加载哪些 bundle（当前 13 条） | 无敏感值 |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 用户 patch 层，169 行 | **含 provider `baseURL` 与 `apiKeyEnv` 等字段名，本文件不复制其值** |
| `~/.dsh/profiles/desktop/cordis.yml` | 空数组，注释明确「改 cordis.patch.yml，不要改这个」 | 无敏感值 |
| `~/.dsh/profiles/desktop/pnpm-workspace.yaml` | `packages: ['.']`、`nodeLinker: hoisted` | 无敏感值 |

另有历史备份 `cordis.patch.yml.bak-final`、`.bak-lanbind`、`.bak2`（23:21 等时间点）。
**这些是用户既有备份，我不会覆盖或删除。**

### 9.4 拟议最小 diff（**未执行**，需用户授权）

思路：两条路，**优先 A**（不改 profile 依赖图）。

**路径 A：profile 本地插件目录（对应既有 `./plugins/lan-webserver/index.mjs` 的先例）**
`cordis.patch.yml` 已用 `insert: [{ id, name: "./plugins/lan-webserver/index.mjs" }]` 加载过本地文件，
说明本地插件不必是 npm 包。但 §9.1 #2 的 `resolveBundleDir` 只针对 `dsh.profile.bundles` 里的
**bundle**；`insert` 里的 `name` 是 Loader 直接 import 的路径。因此路径 A 只适用于 **Host 插件**，
不适合需要 `dsh.client` 装配的 Client bundle。**这条我还没在真实 Host 里验证，属待证明项。**

**路径 B：把两个包作为 bundle 登记（Host + Client 一次性覆盖）**

1. 备份 `package.json` 与 `cordis.patch.yml` 到带时间戳的新文件（不覆盖既有 `.bak*`）。
2. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` **只追加 Host 一项**：
   ```text
   "@dsh-gamecenter/host"
   ```
   **不要**追加 `@dsh-gamecenter/client`：Client 走 Loader 条目自动发现（见 §9.2 缺口 C 更正），
   且它没有 `dsh.bundle`，作为 bundle 会被静默跳过。
3. 让 Host 包可被 `resolveBundleDir` 解析：在 `~/.dsh/profiles/desktop/node_modules/`
   下建指向本仓库 `packages/dsh-gamecenter` 的链接（`nodeLinker: hoisted`，见 §9.1 #2）。
   **注意**：`linkedProfileRoots()` 会把指向 profile 树之外的链接收集为该 profile 的
   额外解析根，因此工作区链接是受支持形态（我读过该函数，**未在真实装载中验证**）。
4. Host 包补 `dsh.bundle.patch`（我的文件）。
5. Host 包补 `lib/` 构建产物（我的文件，需把 `tsconfig` 改成可 emit 或加独立 build 配置）。

**Client 半如何被发现（待验证）**：Client 包的 Host 半 `lib/client.js` 目前是过渡 ESM 壳，
需要有一个 Loader 条目 `name` 能解析到 `@dsh-gamecenter/client` 这个包。
最稳的做法是让 **Host 运行时插件在 `apply()` 里动态 `import('@dsh-gamecenter/client')`**，
或把 Client 包作为 Host 包的依赖写进其 `package.json`。两者我都没在真实装载里验证，
**必须在授权前用一次性的 profile 试验确认**，不能靠推测写进变更单。

**风险**：第 3 步会改动 profile 的 `node_modules`；第 2、3 步组合若任一环失败，
按 §9.1 #7 **该 bundle 会被静默跳过**，界面表现为"什么也没发生"，而不是报错。

### 9.5 成功与失败观察点

**Host 侧（在 DSH 里读，不启服务）**
- 失败但静默：`reportSkippedBundles()` 会把跳过的 bundle 打印到 **stderr**，
  格式 `skipping profile bundle "<name>": <reason>`。这是第一手证据，先看它。
- 插件清单：`ctx.pluginPackages` / `pluginInventory.list()` 应出现 `@dsh-gamecenter/host`，
  且 `fiberPhase === 'active'`（非 `failed`/`pending`）。
- 服务存在：`ctx.get('gameCenter')` 返回对象，且 `typertRemote.namespace === 'gameCenter'`。
- 端点被认领：`ctx.typertGateway.claimsEndpoint('gameCenter/handshake')` 应为 `true`
  （该函数是 SRC 认领的唯一判据，见 §8.4）。

**Client 侧**
- 侧栏出现「游戏中心」，排在「技能中心」（order 30）之后（我方 order 31）。
- console 若出现 `gameCenter: Remote 挂载失败 —— <code>: <message>` 即为 Remote 未挂上。
- 打开弹层应显示模型目录；**只做只读目录读取，不点任何会发模型的按钮**（无付费路径）。

**失败时最小复现命令**（不启动 GUI）：
```text
node -e "const b=require('<DSH_INSTALL>/resources/app.asar.unpacked/../x')"
```
不可用时改用：`node packages/dsh-gamecenter/tools/probe-host-assembly.mjs`
（它会在 `remoteMounted=false` 时如实报告）。

### 9.6 回滚

1. 删除新增的 `package.json` 里那两项 bundle 条目（或用备份覆盖回原文件）。
2. 删除第 3 步建立的 `node_modules` 链接。
3. 重启 GUI 即回到当前状态；**存档与游戏数据不受影响**（本阶段尚未创建任何存档）。
4. 备份文件保留不删，便于二次核对。

### 9.7 GUI 重启影响

- 必须重启一次 GUI：bundle 层只在 Host 启动时装配（§9.1 #1）。
- 重启会中断当前所有会话的流式输出；**不丢失**历史消息（会话日志是持久化的）。
- 重启不影响其它已装插件（`.bak*` 备份与既有 bundles 不动）。
- **无付费模型测试路径**：装载后只做「打开弹层 + 读模型目录 + 看服务是否 active」，
  全程不调用 `stream()`。我已在 `model-catalog.ts` 用哨兵测试守住"绝不调 stream"这条。

### 9.8 本节明确不成立的断言

- 不声称 profile 变更已验证可行：§9.4 的第 3 步（工作区链接作为解析根）我只读了源码，没跑过。
- 不声称 Host 服务会被 Gateway 认领：需要 §9.5 的 `claimsEndpoint` 在真实 Host 里返回 `true`。
- 不声称 Client 能挂载：需要 console 无 `Remote 挂载失败` 且五个方法可调用。

## 10. 加载前置项补齐结果（2026-10-19 00:0x，PM 指派集成）

PM 结束旧冻结窗口、指定我为本轮集成负责人后，本节记录**已实际执行**的补齐动作。
全部是项目内文件，未改 profile、未重启、未启服务、未付费。

### 10.1 已补齐的两项（原先会让真实加载静默失败）

**① Host 包缺 `lib/` 构建产物 —— 已修**

- 新增 `packages/dsh-gamecenter/tsconfig.build.json`：`noEmit: false`、`outDir: lib`、
  `rootDir: src`、`rewriteRelativeImportExtensions: true`。
- `package.json` 新增 `"build": "tsc -p tsconfig.build.json"`。
- 产物：`lib/index.js` + 6 个模块的 `.js`/`.d.ts`/`.js.map`，共 7 个 js。
- **两个真实坑（已解决，记录以免复现）**：
  1. `allowImportingTsExtensions` 与 emit 互斥（TS5096），emit 时须关掉并改用
     `rewriteRelativeImportExtensions`，否则产物里保留 `./x.ts` 导入，Node 无法解析。
  2. 源码里两处 `import type ... from '@dsh-gamecenter/protocol'` 会把 protocol 源码
     拉进 program，触发 `TS6059`（不在 rootDir 下）。因为这两处**只用于类型**、
     运行时不依赖 protocol，已改为本地结构子集（`LeaseErrorCode`、`CatalogCapabilityEntry` 等），
     切断编译依赖。**这是刻意的取舍**：宿主里 Host 包不 import protocol 值，只对形状做约束。
- 验证：`node -e "import('./lib/index.js')"` 实际导入成功，导出 `apply / digestToken / inject`，
  并跑通握手→暂停→旧代次拒写→保存确认全链路（见 `test/build-artifact.test.mjs` 8 项）。

**② Host 包缺 `dsh.bundle.patch` —— 已修**

- 新增 `packages/dsh-gamecenter/cordis.patch.yml`，内容为
  `insert: [{ id: gamecenter-host, name: "@dsh-gamecenter/host" }]`。
- `package.json` 新增 `dsh.bundle.patch` 与 `dsh.engines.dsh`（顶层 `engines.dsh` 保留）。
- 依据：`dsh-app-boot` 第 1023-1024 行缺 `dsh.bundle` 会 throw，被收进 `skippedBundles`
  后**静默跳过**（1035-1040 行）。

### 10.2 Loader 注册 Client 条目的路径（源码级核实 + 隔离验证）

这是 PM 特别要求"不把动态 import 或声明依赖当作已注册证明"的那一点。

**发现链**（`dsh-client-modules/lib/index.js`）：

| 步骤 | 行为 | 行号 |
| --- | --- | --- |
| 1 | `resolveSource(entry)`：取 `loaderName = entry.options.name`，`baseUrl = entry.parent.tree.ctx.baseUrl` | 877-889 |
| 2 | → `resolveMeta()` → `locatePkgJson(loaderName, baseUrl)` | 720-750 |
| 3 | `locatePkgJson`：非路径类 `loaderName` **必须**通过 `exactPackageSpecifier()`，否则直接 return undefined | 764-766 |
| 4 | `exactPackageSpecifier`：`@scope/name` 恰好两段，或裸名不含 `/` 与 `:` | 83-90 |
| 5 | `nearestPackage`：沿模块 URL 向上找最近的 `package.json`，且 `name` 必须等于期望包名 | 793-809 |
| 6 | 命中后读 `dsh.client` 与 `exports["./client"]` 得 `clientPath` | 731-737 |

**结论（关键）**：Client bundle **不是靠被 import 发现的**，而是靠
**某个 Loader 条目的 `name` 能解析到该包**。所以：

- 我的 patch 用 `name: "@dsh-gamecenter/host"` 是**精确包名**，通过第 3-4 步的判定；
- 已写 `tools/check-loader-name.mjs` 隔离验证：判定 PASS，且与 `package.json` 的 `name` 一致，
  并对 `@scope/pkg/sub`、`./plugins/x.mjs`、绝对路径、`lodash/fp` 四种反例确认都**不是**精确包名。

**尚未解决的一项（阻断 Client 装载）**：`@dsh-gamecenter/client` 目前
`main` 与 `exports["."].default` **都指向 `dist/client.js`**，而那是
`window.__ModuleLoader__.load({...})` 形态的浏览器 bundle，**在 Node 里 import 会抛
`ReferenceError: window is not defined`**。它没有真正的 Host 半入口。

**→ 2026-10-19 00:1x 更新：此项由界面与运行时工程师已补齐。**
他新增了 `packages/dsh-gamecenter-client/lib/index.js` 作为 Host 半，
`exports["."]` 指向它、`exports["./client"]` 保持指向 `dist/client.js`。
我实测 `import('./packages/dsh-gamecenter-client/lib/index.js')` **exit 0**，
导出 `apply / default / name`，且在 `window === undefined` 的 Node 环境下可导入。

### 10.2.1 `exports["./remote"]` 路径不匹配（测试与发布负责人发现，已修）

**他报的这条成立**：`package.json` 声明了
`exports["./remote"] = { types: "./lib/remote.d.ts", default: "./lib/remote.js" }`，
但构建产物只有 `lib/remote/` **目录**（`contribution-shape.js`、`game-center-service.js`），
**`lib/remote.js` 与 `lib/remote.d.ts` 从未存在**。任何
`import '@dsh-gamecenter/host/remote'` 都会 `ERR_MODULE_NOT_FOUND`。

**处置**：全局搜索确认**没有任何代码引用 `@dsh-gamecenter/host/remote`**，
该子路径是我早期预留的死导出。已**直接移除**该 export（而不是造一个假的 `remote.js` 转发文件，
因为造文件会让"声明与实际不一致"的问题以另一种形式继续存在）。

**新增守卫**：`test/build-artifact.test.mjs` 增加一项
「exports 的每个子路径都指向真实存在的产物文件」，遍历所有子路径与条件，
缺失即失败。当前 **9/9 通过**。

### 10.3 本轮实测命令与退出码（workdir = `packages/dsh-gamecenter`）

| # | 命令 | 退出码 | 结论 |
| --- | --- | --- | --- |
| 1 | `npx tsc -p tsconfig.build.json` | **0** | `BUILD`：`lib/` 产物生成（7 个 js） |
| 2 | `node -e "import('./lib/index.js')..."` | **0** | 产物可真实导入并跑通全链路 |
| 3 | `npx tsc -p tsconfig.json` | **0** | 类型检查（源码视图） |
| 4 | `node --test test/*.test.mjs` | **0** | `UNIT`：**70/70**（比上轮 61 多 9 项产物守卫） |
| 5 | `node tools/check-loader-name.mjs` | **0** | Loader 名判定 PASS |
| 6 | `node tools/verify-load-prereqs.mjs` | **0** | 端到端前置条件隔离验证 **9/9 PASS**（见 §10.3.1） |
| 7 | `node -e "import('./packages/dsh-gamecenter-client/lib/index.js')"` | **0** | Client Host 半可导入，导出 `apply/default/name` |

### 10.3.1 隔离验证覆盖的九项（`tools/verify-load-prereqs.mjs`）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | Host `dsh.bundle.patch` 已声明且文件存在（1015 bytes） | PASS |
| 2 | Host patch 的 Loader 条目 `name` 是精确包名 | PASS `@dsh-gamecenter/host` |
| 3 | Host `exports["."]` 可被 Node 真实 import | PASS `apply,digestToken,inject` |
| 4 | Host 产物不含 `.ts` 相对导入 | PASS |
| 5 | Host `exports` 每个子路径都指向真实文件 | PASS |
| 6 | Client `exports["."]`（Host 半）可 import 且不依赖 `window` | PASS `apply,default,name` |
| 7 | Client `exports["./client"]` 是 `__ModuleLoader__.load` 形态、无顶层 import（27281 bytes） | PASS |
| 8 | Client `dsh.client.platform === "web"` 且 `exports["./client"]` 存在 | PASS |
| 9 | Client 包名可作为精确 Loader 条目名 | PASS |

**这九项只证明「前置条件在 Node 侧成立」，不是 DSH-REAL。**

## 11. 类型契约漂移已消除（2026-10-19 00:1x）

测试与发布负责人指出「共享协议的本地内联子集造成两套契约」，**成立**。已按 PM 要求
与架构与协议负责人协作解决，不再在 Host 侧内联。

### 11.1 根因与解决路径

| 事实 | 说明 |
| --- | --- |
| 根因 | protocol 原为 `main/types/exports` 全部指向 `src/index.ts`，下游 emit 时触发 TS6059（不在 rootDir）、TS5096（allowImportingTsExtensions 与 emit 互斥） |
| 我的错误处置 | 用内联结构子集绕开，形成 `LeaseErrorCode` / `Catalog*` 两套并行契约 |
| 架构负责人处置 | protocol 改为 `dist` 产物 + 类型声明：`main: ./dist/index.js`、`exports["."].types: ./dist/index.d.ts`，并加 `build` 脚本 |
| 我的后续 | 删除全部内联子集，恢复 `import type ... from '@dsh-gamecenter/protocol'` |

### 11.2 已删除的内联定义

- `src/runtime/lease.ts`：删除 `LeaseErrorCode` 联合类型，改为 `import type { ErrorCode }`。
- `src/ai/model-catalog.ts`：删除 `CatalogModality` / `CatalogCapabilityStatus` /
  `CatalogAIOperation` / `CatalogModelLimits` / `CatalogCapabilityEntry`，
  改为 `import type { Modality, ModelCapabilityEntry, ModelLimits }`。

### 11.3 编译期一致性断言（**形式曾被指出无效，已修正**）

我最初写的断言是：

```ts
type _LeaseRecordSatisfiesProtocol = LeaseRecord extends RuntimeLease ? true : never
const _leaseRecordContract: _LeaseRecordSatisfiesProtocol = true
```

**项目经理与架构与协议负责人同时指出这个形式不成立**，我实测确认他们是对的：

```text
type Cur = B extends A ? true : never   // B 不满足 A 时 Cur = never
const x: Cur = true                     // never 是底类型，可用 `as` 变通，实测不报错
```

我用一份独立文件实测该写法 `tsc` **退出码 0**，即它形同虚设。

**已改为真正会失败的形式**：

```ts
type Assert<T extends true> = T
type _LeaseRecordSatisfiesProtocol = Assert<LeaseRecord extends RuntimeLease ? true : false>
type _ProtocolProjectionExact = Assert<
  Pick<LeaseRecord, keyof RuntimeLease> extends RuntimeLease
    ? RuntimeLease extends Pick<LeaseRecord, keyof RuntimeLease> ? true : false
    : false
>
```

右向那一支（`RuntimeLease extends Pick<...>`）是我额外加的：它保证不会把某个协议字段
悄悄改成不相容类型（否则投影会退化成协议的真子集）。

**并加了一层"更稳妥"的运行时投影**（架构负责人建议）：

```ts
export function projectRuntimeLease(record: LeaseRecord): RuntimeLease
```

返回类型显式标注为 `RuntimeLease`，因此**赋值处**即受协议约束——
即使将来有人删掉上面的类型别名，这里仍会在编译期报错。实测投影只输出协议 6 个字段，
`state` / `lastPersistedRevision` / `tokenDigest` **不泄漏**（已用脚本验证）。

**负例验证（`test/type-assert.test.mjs`，2 项）**：
`tools/assert-negative-check.ts` 里构造两种故意错误的实现——缺 `sealed` 字段、
把 `expiresAt` 放宽成 `string | undefined`——编译它并断言 **tsc 退出码非 0 且恰好 2 条
`TS2344`**。实测输出：

```text
error TS2344: Type 'false' does not satisfy the constraint 'true'.   (×2)
exit code 2
```

若有人把断言改回 `? true : never`，本测试会立刻失败。**这才是"能让错误编译失败"的证据。**

### 11.4 漂移判定的统一口径

采纳项目经理与架构负责人的分层口径：**`LeaseRecord` 持有内部状态（多字段）不算漂移**。
判定标准是**对外投影完整覆盖 `RuntimeLease` 且字段语义不变**，
按投影比对，不按结构全等比对。`projectRuntimeLease()` 就是那个投影入口。

### 11.4 移除 tsconfig 的 protocol 源码映射

`packages/dsh-gamecenter/tsconfig.json` 原先有
`paths: { "@dsh-gamecenter/protocol": ["../protocol/src/index.ts"] }`，
这是早期为绕开源码导出而加。protocol 改为 dist 产物后，该映射会让 tsc 仍去读源码、
重新触发 TS6059。**已删除该 paths**，现在按正常的包解析走 dist 类型声明。

### 11.5 新增守卫

- `test/build-artifact.test.mjs` 新增「产物中无外部包运行时导入」：
  用真实 ESM 语句匹配（不用文本包含）扫描 `lib/**.js`，
  要求所有 import 说明符都来自相对路径或 `node:` 内建。
  这保证 protocol 只能以 `import type` 出现（编译期擦除），
  一旦有人写成值导入，测试立刻失败。
- 独立工具 `tools/check-lib-deps.mjs`：同一检查的命令行版本，退出码可直接用。

### 11.6 本轮实测（workdir = `packages/dsh-gamecenter`）

| 命令 | 退出码 | 结论 |
| --- | --- | --- |
| `npx tsc -p tsconfig.json` | **0** | 类型检查通过；两条一致性断言成立 |
| `npx tsc -p tsconfig.build.json` | **0** | `lib/` 重新产出（7 个 js） |
| `node --test test/*.test.mjs` | **0** | **73/73**（比上轮 70 多 3 项：无外部导入、exports 子路径、patch 不重复登记） |
| `node tools/check-lib-deps.mjs` | **0** | 7 个产物文件零外部运行时导入 |
| `node tools/verify-load-prereqs.mjs` | **1** | **10/11 PASS**，唯一 FAIL 见 §10.4 Client 发现路径 |

### 10.4 Client 发现路径已闭环（锚点方案，2026-10-19 00:2x）

这是装载前最后一项，已按源码核实并解决。

**否决的方案：`disabled: true` 当发现锚点**

界面与运行时工程师建议加一条 `disabled: true` 的 Loader 条目作为锚点，并提醒我先核源码。
核完结论是**不可行**：

| 依据 | 位置 | 后果 |
| --- | --- | --- |
| `if (entry.options.name !== entryName \|\| entry.fiber === void 0 \|\| entry.disabled) continue;` | `dsh-client-modules/lib/index.js` 855 | disabled 条目**直接跳过**，不进 Client source 表 |
| `refresh() { if (this.fiber) return; if (this.disabled) return; ... }` | `cordis-plugin-loader/lib/index.js` 361-365 | disabled 条目**不 init，永远没有 fiber** |
| `if (this.disabled) { this.fiber?.dispose(); return; }` | 同上 373-376 | disabled 还会主动 dispose |

三者叠加：disabled 条目**等于不存在**，装了也不会被 `resolveMeta` 当成源。

**否决的方案 2：给 Client 单独加一条活跃 Loader 条目**

`reconcilePackage`（`dsh-client-modules/lib/index.js` 893-896）规定同一 `packageName`
命中多个 active source 会 **throw** `resolves from multiple active Loader sources`。
所以不能既让 Host 条目解析到 Client、又给 Client 单独加条目。

**曾采用的方案：Host 产物静态导入 Client 包作为发现锚点 —— 后被 §10.5 证伪并已移除**

`nearestPackage`（793-809）是"沿模块 URL 向上找 name 匹配的 package.json"。
当时我据此认为：只要 Host 产物里出现一条解析结果落在 Client 包内的导入，
`locatePkgJson` 就能命中该包 manifest，`resolveMeta` 随后读到 `dsh.client` 与 `exports["./client"]`。

当时的动作（**现已全部撤销，见 §10.5**）：
1. `package.json` 增加 `"@dsh-gamecenter/client": "workspace:*"` 依赖（**保留**，作为解析保险）。
2. `src/index.ts` 顶部加 `import '@dsh-gamecenter/client'`（**已移除**）。
3. `tools/check-lib-deps.mjs` 白名单允许 client（**已清空白名单**）。

### 10.5 锚点方案被证伪与最终修正（2026-10-19 00:4x）

**我原先的判断「Host 产物静态 import Client 包即可让 Client 被发现」是错的。**
测试与发布负责人不用我的探针，而是按 `dsh-client-modules` 源码逐步复刻
`exactPackageSpecifier`(764-766) → `nearestPackage`(793-809) → `resolveMeta`(720-750)，
并用**真实 Loader 条目名**执行，结论是：

| Loader 条目名 | 解析到的包 | `dsh.client` | resolveMeta |
| --- | --- | --- | --- |
| `@dsh-gamecenter/host` | Host 包 | `undefined` | **返回 null** |
| `@dsh-gamecenter/client` | Client 包 | `platform: web` | 发现，`clientPath = dist/client.js` |

**根因**（我重读源码确认）：`locatePkgJson` 第 765 行
`const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName)`
—— `expectedPackageName` **恒等于该 Loader 条目的 name**；第 800 行又要求
`name === expectedPackageName`。所以 name 为 host 的条目**只会**解析出 Host 包。
「Host 能 import Client」与「resolveMeta 会发现 Client」是两件事。

**最终修正**：`cordis.patch.yml` 登记**两条**独立 Loader 条目
（`gamecenter-host` → `@dsh-gamecenter/host`，`gamecenter-client` → `@dsh-gamecenter/client`）。

**同时修正我原先那处误读**：我以为 patch「绝不能加 Client 条目」，理由是
`reconcilePackage`(893-896)。但该函数判的是「**同一 packageName** 命中多个 active source」，
host 与 client 是两个不同包名，**各登记一条完全合法**。正确含义是「每个包各自只能一条」。

**探针自证问题也已修**：`verify-load-prereqs.mjs` 第 11 项原先写
`if (dependsOnClient || hasClientEntry) return ...`，于是输出里明明写着
`patch 含 Client 条目=false` 仍判 PASS。现已改为两条**真断言**：
必须存在 name 为 `@dsh-gamecenter/client` 的条目，且逐条模拟 resolveMeta 能算出真实 `clientPath`。
该脚本的目录定位也改为基于 `import.meta.url`（原先依赖 cwd，从包目录跑会 0/12 ENOENT）。

**变异验证**：删掉 patch 里的 client 条目后，脚本从 **12/12 降为 10/12、exit 1**；
按字节恢复后复跑 12/12、exit 0（哈希一致）。同一约束也进了
`test/build-artifact.test.mjs`（新增 2 项）。

### 10.6 仍不成立的断言

- 不声称真实 DSH 已装载：需要 §9.5 的 stderr 无 `skipping profile bundle` 且
  `ctx.get('gameCenter')` 存在。
- 不声称 `$mount` 会成功、SRC 回退会命中、弹层会渲染。
- **阶段0 仍未通过**，A0-2~A0-7 依旧 BLOCKED。

## 12. 真实加载授权方案（唯一选定路径，**仅准备，未执行**）

本节是交用户批准的具体动作范围。**当前未修改任何 profile 文件、未重启 GUI、未调用模型。**

### 12.1 必须分清的两件事（PM 特别要求）

| | 当前项目 workspace 解析 | 目标 profile 解析 |
| --- | --- | --- |
| 解析根 | `<REPO>\packages\dsh-gamecenter\node_modules\` | `<PROFILE_DIR>\node_modules\` |
| 现状 | **已有** `@dsh-gamecenter/{client,protocol}` 链接 | **完全没有** `@dsh-gamecenter` 目录 |
| 结论 | 项目内能编译、能跑测试 | **不能解析裸包名** |

**实测证据**（`tools/probe-profile-resolution.mjs`，只读）：
用 `createRequire('<profile>/package.json')` 复刻 `packageDirFromAnchor` 的搜索路径，
对三个包名全部**未解析到**。profile 的首个搜索路径是
`<PROFILE_DIR>\node_modules\@dsh-gamecenter\host`（其余为逐级上级目录）。

**因此不能假定 profile 能解析裸包名。** 这是本方案必须包含「建链接」授权动作的原因。

### 12.2 唯一选定路径：profile node_modules 外链（DSH 一等机制）

依据（`dsh-app-boot/lib/index.js`）：
- 第 664 行 `linkedProfileRoots()` 的文档明确：它收集的是
  「Active profile `node_modules` entries **linked outside** the shared profiles tree and the active profile」；
- 第 1535 行 `this.linkedTargets = new Map(resolution.linkedRoots.map(...))`，
  第 1565/1570 行把 linkedRoots 纳入解析与目录迁移跟踪（`MovedDirectories`）。

→ 把本地包以**链接**形式放进 profile 的 `node_modules`，是 DSH 自己支持并跟踪的形态，
不是绕过机制的私有做法。

### 12.3 需要用户批准的具体动作（4 步）

**动作 1：确认并构建仓库侧产物**（在有 DSH 的我方仓库内，可反复执行）

```text
cd <REPO>
pnpm run build            # 先 protocol（dist），再各包
```

必须存在：
- `packages\protocol\dist\index.js`（架构负责人已建）
- `packages\dsh-gamecenter\lib\index.js` 等 7 个 js（我侧）
- `packages\dsh-gamecenter-client\dist\client.js`（Client 侧）
- `packages\dsh-gamecenter\node_modules\@dsh-gamecenter\{client,protocol}`（workspace 链接，由 `pnpm install` 建立）

**动作 2：备份目标 profile 的两个文件**（不改原文件，新建带时间戳副本）

```text
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json"      "$p\package.json.bak-gamecenter-<时间戳>"
Copy-Item "$p\cordis.patch.yml"  "$p\cordis.patch.yml.bak-gamecenter-<时间戳>"
```

注意：profile 里已有用户既有备份（`cordis.patch.yml.bak2`、`.bak-final`、`.bak-lanbind`），
**不覆盖、不删除**。应用前必须**重新读取并记录 `package.json` 当前 sha256**
（本次撰写时为 `788BDECBC37172580EA09276E60FBC89532E880B2ACC17E9A1BD079F38FE0B01`，
但该文件在我读取后被改动过，必须以执行时实测为准）。

**动作 3：建立两个 junction（不触碰其它任何条目）**

```text
$p    = "$env:USERPROFILE\.dsh\profiles\desktop"
$repo = "<REPO>\packages"
New-Item -ItemType Directory -Force -Path "$p\node_modules\@dsh-gamecenter" | Out-Null
New-Item -ItemType Junction -Path "$p\node_modules\@dsh-gamecenter\host"   -Target "$repo\dsh-gamecenter"
New-Item -ItemType Junction -Path "$p\node_modules\@dsh-gamecenter\client" -Target "$repo\dsh-gamecenter-client"
```

用 junction（不需要管理员权限）。`@dsh-gamecenter` 目录是**新建**的，不影响已有 400+ 条目。

**动作 4：在 profile `package.json` 的 `dsh.profile.bundles` 追加一项**

最小 diff（只加一行，不动其它 15 项）：

```diff
       "dsh-auto-continue",
       "@linxin666/dsh-web-all",
       "@deepseek-ai/dsh-experimental-tool-worktree",
-      "@deepseek-ai/dsh-experimental-session-search"
+      "@deepseek-ai/dsh-experimental-session-search",
+      "@dsh-gamecenter/host"
     ]
```

**为什么只加 host、不加 client**：client 包没有 `dsh.bundle`，按 `dsh-app-boot` 第 1023-1024 行
会被 throw 并**静默跳过**。client 的加载入口由 Host 的 patch 提供
（`cordis.patch.yml` 里的 `insert` 两条条目，见 §10.5）。

**明确不做**：**不要在 profile 里执行 `pnpm install`**。我方包的依赖用了 `workspace:*`，
该协议只在项目 workspace 内成立；在 profile 里装会解析失败。用 junction 即可。

### 12.4 隔离验证（已做，`MOCK`/`BUILD`，非 DSH-REAL）

`tools/simulate-profile-link.mjs` 在**临时沙盒**（不碰真实 profile）搭出同样结构并建 junction：

```text
RESOLVE {"@dsh-gamecenter/host":"...\packages\dsh-gamecenter\lib\index.js",
         "@dsh-gamecenter/client":"...\packages\dsh-gamecenter-client\lib\index.js"}
IMPORT-HOST OK exports=apply,digestToken,inject
exit=0
```

证明：裸包名可从「profile 式解析根」解析；Host 包可被 import，
且其内部 `import '@dsh-gamecenter/client'` 能**穿过 junction 按 realpath 解析到**。
沙盒已清理。

**边界**：这只证明 Node 语义成立。DSH 自己的 `linkedTargets`/`MovedDirectories` 介入后
行为如何，仍属 DSH-REAL 未验证。

### 12.5 重启方式与影响

- **必须重启一次 GUI**：bundle 层只在 Host 启动时装配。且 `dsh-app-boot` 第 1547/1550/1553 行
  对解析变更明确抛 `requires a process restart`。
- 方式：**正常退出** DeepSeek Harness（菜单退出，不要强杀），再重新启动。
- 影响：中断当前所有会话的流式输出；**不丢失**历史消息（会话日志持久化）。
  不影响其它已装插件（既有 bundles 与 `.bak*` 不动）。
- **不启动替代服务器、不改安装目录。**

### 12.6 无付费观察步骤（按顺序，全为只读）

1. **启动日志先看 stderr**：`reportSkippedBundles()` 会打印
   `skipping profile bundle "<name>": <reason>`。**出现 `@dsh-gamecenter/host` 即失败**，直接进 §12.7。
2. **插件清单**：`pluginInventory.list()` 里应出现 `@dsh-gamecenter/host`，`fiberPhase === 'active'`
   （不是 `failed`/`pending`）。
3. **服务存在**：`ctx.get('gameCenter')` 返回对象，且 `typertRemote.namespace === 'gameCenter'`。
4. **端点被认领**：`ctx.typertGateway.claimsEndpoint('gameCenter/handshake')` 应为 `true`。
5. **界面**：侧栏出现「游戏中心」，位置在「技能中心」（order 30）之后（我方 order 31）。
6. **Remote 挂载**：浏览器 console **不应**出现
   `gameCenter: Remote 挂载失败 —— <code>: <message>`。
7. **打开弹层只做只读目录读取**。**绝不点击任何会调用模型的按钮**，不调用 `stream()`。
   我方 `model-catalog.ts` 已用哨兵测试守住「目录读取不触发 stream」。

### 12.7 失败停止条件（任一命中即回滚）

| 现象 | 判定 |
| --- | --- |
| stderr 出现 `skipping profile bundle "@dsh-gamecenter/host"` | bundle 未装载 |
| `pluginInventory` 无 host 或 `fiberPhase` 非 `active` | 装载失败 |
| `ctx.get('gameCenter')` 为 undefined | 服务未注册 |
| `claimsEndpoint(...)` 返回 false | SRC 认领失败 |
| 侧栏无「游戏中心」或出现异常/白屏 | Client 未装配 |
| console 出现 `Remote 挂载失败` | `$mount` 失败 |
| 任何其它插件行为异常 | 立即回滚 |

### 12.8 回滚（3 条命令，恢复原状）

```text
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Remove-Item "$p\node_modules\@dsh-gamecenter\host"   -Force
Remove-Item "$p\node_modules\@dsh-gamecenter\client" -Force
Remove-Item "$p\node_modules\@dsh-gamecenter"        -Force   # 仅当为空
Copy-Item "$p\package.json.bak-gamecenter-<时间戳>" "$p\package.json" -Force
```

然后重启 GUI。**存档与游戏数据不受影响**（本阶段尚未创建任何存档）。
备份文件保留不删，便于二次核对。

### 12.9 本节明确不成立的断言

- 不声称真实加载一定成功：§12.4 只证明 Node 语义，DSH 介入后未验证。
- 不声称 `$mount` 会成功、SRC 回退会命中、弹层会渲染、关闭后停收。
- 不声称这次改动不产生副作用：它会改变 profile 的模块解析表并新增两个解析根。
- **阶段0 仍未通过**，A0-2~A0-7 依旧 BLOCKED。本节只是把「授权后要做什么」写清楚。

### 12.10 绑定：独立验收结论与产物摘要（2026-10-19 01:2x）

**独立验收结论**（测试与发布负责人，报告 `docs/phase0-acceptance.md` 第 12 节）：
**可以进入真实加载（变更单可交用户审批执行）；阶段0 本身仍未通过，A0-2~A0-7 保持 BLOCKED。**

**稳定快照**：连续三次采样 S2(01:22:30)、S3(01:23:15)、T1(01:23:54) 一致；
191 文件，`SRC_DIGEST = C54D6FB29E0D3028A847A14D2D49313163420D4D2178D9C08B364D8DC0A4B82B`。

**产物摘要（本方案绑定的版本）**：

| 文件 | SHA256 |
| --- | --- |
| `packages/dsh-gamecenter/cordis.patch.yml` | `9033468FBCBEDDE19CAB03E14623A327BA2AE5B21F82E96E7C083883C566A235` |
| `packages/dsh-gamecenter/lib/index.js` | `36A01FBBEB4DA75A698AD6A1B6E9D6ABA210DBA4ADA6A90EED3E5D164BC9CEE9` |
| `packages/dsh-gamecenter-client/dist/client.js` | `9CEAC9E0DEF38DBF5882DF48CAA4B734F2DE8F1677879CB0998E4A723AE2A610` |
| `packages/protocol/dist/index.js` | `E4C11E5B20F1740F7BFC7EDC57B6CD5AFBE53E8BD13A2EB3D6193F946540AB1D` |

**我侧的独立核对（不只转述）**：四个摘要用 `Get-FileHash` 逐个比对，**全部 MATCH**；
删除 `lib/` 后重新构建，`lib/index.js` 哈希**不变**且仍等于上表值 → 构建确定性成立。
我方所有写入在 **01:17:07 前**结束，早于 S2(01:22:30)，因此本方案确实落在该稳定快照内。

**授权执行时必须复用同一产物**；若任一摘要不匹配，说明代码已变，需重新验收后再执行。

## 13. 验收方两处要求（A/B）的处置（2026-10-19 01:1x）

测试与发布负责人独立验收后提出 A、B 两项，均成立，处置如下。

### 13.1 (B) `test` 脚本漏跑 2 个文件 —— 已修

**问题**：`package.json` 的 `test` 脚本显式列了 6 个文件，而 `test/` 下实为 8 个，
漏掉 `build-artifact.test.mjs` 与 **`type-assert.test.mjs`**。后果是仓库根
`pnpm run test` 只跑 61 项（直接 glob 是 77 项），**恰好跳过守护类型漂移的断言**——
根门禁形同虚设。这条批评完全成立：门禁漏跑最关键的守卫，比没有门禁更危险。

**修法**：改为 glob。

```json
"test": "node --test \"test/*.test.mjs\""
```

**顺带核实的一个事实**：目录形式 `node --test test/` 在 Node 24.19.0 下**不被支持**，
它会尝试把 `test/` 当模块加载并报 `MODULE_NOT_FOUND`、exit 1（实测）。
所以只能用 glob 形式，不能用目录形式。

**实测**：包内 `pnpm run test` **78/78 exit 0**（原 61）；
根 `pnpm run test` **exit 0**，其中 host **78/78**（原 61）、client 64/64；
且根日志里已能看到 `Assert<T extends true> 对不满足协议的类型必须报 TS2344` 这条用例被执行。

### 13.2 (A) 锚点导入是 tsc 校验盲区 —— 已通过**移除该导入**解决

**问题**：测试与发布负责人用对照实验证明，TypeScript 对**仅副作用导入**
不校验模块能否解析（值导入不存在的包 → TS2307 exit 2；仅副作用导入 → exit 0 无报错；
故意类型错误 → TS2322 exit 2，说明 tsc 确实在检查）。
我的锚点正是副作用导入，属覆盖盲区。

**我实测补充**：把锚点改成值导入 `import { name } from '@dsh-gamecenter/client'`，
得到的是 `TS2305: Module '"@dsh-gamecenter/client"' has no exported member 'name'`，exit 2。
即：**模块解析是通的（没有 TS2307），但该包 `exports["."].types` 指向的是浏览器半的声明**
（`src/types/index.d.ts` 导出 `apply/LOCALE_NS/PANEL_ID/inject`），
Host 半 `lib/index.js` 实际导出 `name/apply/default` 且**没有** `lib/index.d.ts`。
这是 Client 包的一处真实缺陷，我已直接告知其负责人。

**我没有改用值导入，而是把该导入整个移除**，理由三条：
1. 锚点对发现**无任何作用**（§10.5 已证：`expectedPackageName` 恒等于 Loader 条目名）；
2. 任何形式的导入都会让 Client 的 Host 半在 **Host 启动时被执行一次**，
   这正是测试与发布负责人指出的真实风险，移除即消除；
3. 既然导入对发现无用，保留它只是误导，且仍需为其维护一条白名单例外。

**处置结果**：
- `src/index.ts` 移除该导入，改为一段说明为什么**不该**有它；
- `tools/check-lib-deps.mjs` 白名单**清空**，现在要求产物**零外部运行时导入**；
- 新增守卫测试「产物不含 `@dsh-gamecenter/client` 导入（发现应由 Loader 条目负责）」；
- `package.json` **保留** `@dsh-gamecenter/client` 依赖，但注释写明它**不是**为了导入，
  而是解析保险：若真实 Loader 给的 `baseUrl` 落在本包目录而非 profile，
  该条目名仍能经本包 `node_modules` 链解析到。**这是待 DSH-REAL 验证的保险，不是已知必需。**

**实测**：`lib/index.js` 现有导入只剩三条相对路径导入；
`check-lib-deps.mjs` 扫描 7 个产物文件 → PASS（零外部导入）。

### 13.3 本轮实测汇总（workdir = `packages/dsh-gamecenter`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc -p tsconfig.json` | **0** | 类型检查 |
| `npx tsc -p tsconfig.build.json` | **0** | `lib/` 重建（7 个 js） |
| `pnpm run test` | **0** | **78/78**（含被漏跑的 build-artifact 与 type-assert） |
| `node tools/check-lib-deps.mjs` | **0** | 零外部运行时导入 |
| `node tools/check-loader-name.mjs` | **0** | 2 条 Loader name 均为精确包名、无重复 |
| `node tools/verify-load-prereqs.mjs` | **0** | **12/12**（根目录与包目录均通过） |
| `node tools/probe-profile-resolution.mjs` | **0** | profile 无法解析三个包名（§12.1） |
| `node tools/simulate-profile-link.mjs` | **0** | 沙盒 junction 方案成立（§12.4） |
| 根 `pnpm run typecheck` / `pnpm run build` / `pnpm run test` | **0 / 0 / 0** | 根门禁全通过 |

### 13.4 流程事实（自我记录）

测试与发布负责人指出：T0(00:41, 187 文件) 与 T1(00:53, 189 文件) 摘要不一致，
原因是**我在其验收窗口内新增了 2 个 tools 文件**（`probe-profile-resolution.mjs`、`simulate-profile-link.mjs`）。
二者是只读探针、不进产物，故不影响结论，但**摘要失效是我造成的**。
以后在他人验收窗口内新增文件必须先告知，否则该轮摘要作废。

### 13.5 仍需说明的边界

- 本轮全部为 `STATIC`/`BUILD`/`UNIT`/`MOCK`，**无任何 DSH-REAL**。
- `.gitignore` 忽略 `dist/`，故 client bundle 与 protocol dist 不在版本库；
  **clean clone 未跑 `pnpm run build` 时，client 的 `exports["./client"]` 指向的
  `dist/client.js` 不存在，DSH 侧会抛 `MissingClientBundleError`**。
  授权动作必须包含「先构建」这一步（§12.3 动作 1）。
- profile 能否解析裸包名**未验证且已证伪（不能假定）**，故 §12.3 动作 3 必须建链接。
- **阶段0 仍未通过**，A0-2~A0-7 依旧 BLOCKED。

## 14. Host 侧缺陷：控制租约按「代次」全局查找，未绑定存档身份（2026-10-19 08:4x）

**这是我实现里的真实缺陷，不是外部问题。** 在做诊断候选联调时，为核实「第二轮诊断是否会撞上一轮租约」而发现。

### 14.1 现象与代码路径

`packages/dsh-gamecenter/src/remote/game-center-service.ts`：

- `saveAck` **第 184 行**：`const lease = this.registry.findByGeneration(input.generation)`
- `pause` **第 207 行**：同样用 `findByGeneration(input.generation)`
- 而 `LeaseRegistry.findByGeneration`（`src/runtime/lease.ts`）是**只按 `generation` 全局遍历**：
  ```ts
  for (const lease of this.bySave.values()) if (lease.generation === generation) return lease
  ```
  它**不校验调用方属于哪个 `gameId` / `saveId`**。

### 14.2 两个后果

**后果 A（诊断会显示错码）**：诊断用固定 `gameId`（`__gamecenter_diag__`）时，
`peekGeneration(gameId)` 按 gameId 累计，故**第二轮** `generation=2`；
它发 `saveAck({generation: 1})` 去找旧代次，`findByGeneration(1)` 会命中**第一轮那条已 `paused`、已封存的租约**，
于是走 `confirmPause(第一轮的 gameId/saveId, 1, 1)` → 状态不是 `pausing` →
返回 **`PROTOCOL_INVALID`**，而**不是**期望的 `STALE_RUNTIME`。
→ 第一轮正确、**第二轮起结论错误**。

**后果 B（跨存档写入，安全相关）**：由于 `gameId`/`saveId` **取自命中的租约而不是请求**，
任何调用方只要给出**别人存档的 generation**，`pause` 就会对**那个存档**执行 `beginPause`。
若对方处于 `running`，即**在未持有该运行实例身份的情况下暂停了别人的存档**。
这直接违反基线 §6「`operationId` 由 Host 组合、小游戏不能伪造别的存档身份」的同类要求。

**根因**：`handshake` 会下发 `tokenDigest`，但**`saveAck`/`pause` 从不校验它**——
运行时身份在签发之后**没有任何绑定**，身份是靠"代次恰好命中"间接推断的。

### 14.3 现在的临时绕开（**不需要改 Host**）

诊断侧**每次运行使用全新的 `gameId`**（例如 `__gamecenter_diag__-<runId>`），则该 gameId 的
`peekGeneration` 恒为 0 → `generation` 恒为 1 → `saveAck({generation: 0})`
在 `findByGeneration(0)` 下**必然** `undefined` → 稳定返回 **`STALE_RUNTIME`**，且不跨轮串扰。
（`generation` 从 1 起，`findByGeneration(0)` 永远无命中。）

### 14.4 阶段0 阻断修复实现（PM 裁决解除“Host 不改”限制，已于 staging 落地）

PM 裁决：跨存档按 generation 全局定位/凭证不校验属阶段0 阻断安全缺陷，不能推到阶段1，
也不能以动态 gameId 绕过后把旧代次隔离报通过。解除限制，在独立 `staging/` 编译修复候选，
**不覆盖在线运行的 `lib/`，不修改真实 profile，不自动重启**。

#### 14.4.1 威胁模型与令牌安全生命周期

1. **威胁边界**：
   - 攻击面 A：恶意/被攻破的小游戏 iframe 通过 Client Bridge 尝试伪造别的存档或运行代次。
   - 攻击面 B：旧代次已暂停/已销毁 iframe 的迟到写入（竞争或网络延迟）。
   - 攻击面 C：不同存档（甚至不同游戏）因代次数值相同而发生全局碰撞和误操作。
2. **信任根与鉴权机制**：
   - Host `handshake` 使用密码学随机（`randomBytes(32).toString('base64url')`）下发一次性 `runtimeToken`。
   - **Host 只存 SHA-256 摘要（`tokenDigest`），不存明文**；Client Bridge 持有凭证，**iframe 不得接触**。
   - `pause` / `saveAck` / `leaseStatus` 必须出示 `runtimeToken`，由 Host 现场求 SHA-256 后在 `byToken` 索引中解析。
   - `gameId` / `saveId` / `generation` **一律从租约权威读取**，绝不采信调用方自报值。
3. **失效与销毁**：
   - 实例一旦封存（`paused`/`stopped`），任何后续写入一律判定为 `STALE_RUNTIME`（`lease-sealed`）。
   - 租约超过 `expiresAt` 一律判定为 `PAUSED`（`lease-expired`）。
   - 凭证缺失或伪造一律判定为 `PROTOCOL_INVALID`（`credential-missing` / `credential-invalid`）。
   - 状态查询对未知凭证统一回 `{absent: true}`，避免元数据探测。

#### 14.4.2 负例测试覆盖（`test/identity-binding.test.mjs`，12/12 全绿）

- `handshake 下发 runtimeToken 原文，且不回传可用于伪造的等价物`
- `凭证缺失 → PROTOCOL_INVALID / credential-missing`
- `凭证错误（伪造）→ PROTOCOL_INVALID / credential-invalid`
- `凭证过期 → PAUSED / lease-expired`
- `【跨存档碰撞】相同 generation 的两个存档互不影响：A 的凭证只能动 A`
- `【第二轮】同一游戏第二次握手的旧凭证必须 STALE_RUNTIME，而不是 PROTOCOL_INVALID`
- `【旧 iframe 迟到 pause】暂停完成后旧凭证再 pause 必须被拒（STALE_RUNTIME）`
- `【代次声明不符】凭证有效但声明的 generation 与租约不符 → STALE_RUNTIME`
- `【其他实例的凭证】不能查询到别人的租约状态`
- `正常幂等确认：正确凭证 + 递增 revision 通过；确认后实例已封存，再写为 STALE_RUNTIME`
- `暂停流程中（pausing）重复 revision 仍被拒且码为 PROTOCOL_INVALID`
- `注册表解析：resolveByToken 对未登记摘要返回 credential-invalid`

#### 14.4.3 独立 Staging 编译与在线部署产物隔离

1. **在线部署产物分毫不动**：
   - `packages/dsh-gamecenter/lib/index.js` 保持 `36A01FBBEB4DA75A698AD6A1B6E9D6ABA210DBA4ADA6A90EED3E5D164BC9CEE9`；
   - 备份留存于 `staging-rollback/lib-202610190850`（21 个文件完整保留）。
2. **Staging 独立候选编译**：
   - 配置：`packages/dsh-gamecenter/tsconfig.staging.json`（`outDir: "staging"`）；
   - 执行：`npx tsc -p tsconfig.staging.json` 退出码 **0**；
   - 候选产物：`packages/dsh-gamecenter/staging/`（7 个 js 模块，`index.js` sha256: `8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`，`remote/game-center-service.js` sha256: `D02DB3F88A202F20E67C611BCF5F234FBC43D94108C3070F06001B28D4AF59FD`）。
   - 产物守卫测试：`test/build-artifact.test.mjs` 纳入 staging 候选端到端凭证绑定逻辑校验，全包测试 **92/92 全绿**。

#### 14.4.4 与 Client 和 QA 的联合部署方案

- **Client 候选**：Client 已适配 `remoteFailureOf` 统一错误形状，并产出 `staging/client.js`，全包测试 **81/81 全绿**。
- **发布授权动作（需用户批准）**：
  1. `Copy-Item packages\dsh-gamecenter\staging\* packages\dsh-gamecenter\lib\ -Recurse -Force`
  2. `Copy-Item packages\dsh-gamecenter-client\staging\client.js packages\dsh-gamecenter-client\dist\client.js -Force`
  3. 正常重启一次 DSH GUI。
- **回滚方案**：
  1. 从 `staging-rollback\lib-202610190850` 还原 Host `lib\`；
  2. 从 `$env:TEMP\gamecenter-deployed-dist-client.js` 还原 Client `dist\client.js`；
  3. 正常重启 GUI。

## 15. 用户明确授权下的双端候选受控部署（2026-10-19 09:45）

用户在 PM 明确提请“备份并部署双端 staging 候选、不改 profile、不调用模型、部署完成后再正常重启”后明确回复“继续”。
由 DSH Host 工程师作为唯一部署执行人，严格按清单执行备份、替换与哈希双向核验。

### 15.1 部署前完整清单与哈希核验

1. **Host Staging 候选清单（21 个构建产物文件，无测试/工具/回滚杂质）**：
   - `index.js`（5310 B）：`8A9138211940E70C0130ABDB54D8D40956DD727829C1AD73962A4E93A9979184`
   - `remote/game-center-service.js`（15517 B）：`D02DB3F88A202F20E67C611BCF5F234FBC43D94108C3070F06001B28D4AF59FD`
   - `runtime/lease.js`（15464 B）：`EEB28A6B5B414A311A02E9BC41014477B860666823291A50A0E5A86C29572914`
   - 其余全部 18 个 `.d.ts` / `.js` / `.js.map` 文件与 QA 第 28 节报告一致。
2. **Client Staging 候选**：
   - `staging/client.js`（46457 B）：`6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`
3. **原在线部署态原件**：
   - Host 原 `lib/index.js`：`36A01FBBEB4DA75A698AD6A1B6E9D6ABA210DBA4ADA6A90EED3E5D164BC9CEE9`
   - Client 原 `dist/client.js`：`1A5B9875F06ADE8B403EE81B23D21C15ACA9455C6064BFB5D35CB5DE3F2BC0BA`

### 15.2 独立不可覆盖回滚备份（已建立并核验）

1. **Host 在线树备份**：
   - 目标路径：`packages/dsh-gamecenter/staging-rollback/lib-deployed-36A01FBB-202610190945`
   - 文件数量：21 个文件完整保留，`index.js` 哈希保持 `36A01FBB…`，所有文件与原 `lib/` 100% 匹配。
2. **Client 在线产物备份**：
   - 目标路径：`packages/dsh-gamecenter-client/staging-rollback/client.js-deployed-1A5B9875-202610190945`
   - 哈希核验：`1A5B9875F06ADE8B403EE81B23D21C15ACA9455C6064BFB5D35CB5DE3F2BC0BA`（与原件一致）。

### 15.3 受控替换与部署后原位核验

1. **Host 产物替换**：
   - 将 `packages/dsh-gamecenter/staging/*` 逐文件复制至 `packages/dsh-gamecenter/lib/*`；
   - 部署后核验：`lib/` 内 21 个文件哈希与 `staging/` 100% 一致，`index.js` 为 `8A913821…`。
2. **Client 产物替换**：
   - 将 `packages/dsh-gamecenter-client/staging/client.js` 复制至 `packages/dsh-gamecenter-client/dist/client.js`；
   - 部署后核验：`dist/client.js` 哈希为 `6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`，大小 46457 字节。
3. **真实 Profile 状态**：
   - `<PROFILE_DIR>\package.json`（`4AA2223B…`）未改动；
   - `<PROFILE_DIR>\cordis.patch.yml`（`83DA47B1…`）未改动；
   - Host / Client 两个 Junction 软链接完好指向仓库。

### 15.4 关键边界与生效说明

- 替换磁盘文件不等于 Host 进程内存重载，当前运行的 DSH 实例（PID 30996）仍在运行旧 Host 内存镜像；
- 未经授权不得擅自刷新或杀进程；
- 交付前未操作运行态诊断界面，不擅自声称已通过；
- 交由测试与发布负责人独立复核，复核确认后由 PM 统一提示用户进行正常 GUI 重启。

## 16. 端点 404 根因排查、标准装饰器重构与生产装配候选（2026-10-19 14:10）

在用户授权刷新后，实机诊断显示 Client `$mount` 成功，但 `/api/gameCenter/handshake` 与 `/api/gameCenter/modelCatalog` 均返回 **HTTP 404**。

### 16.1 404 确凿根因（已双向独立核实并用真实装配复现，exit 0）

1. **缺陷一（生产路径硬编码 null 桩）**：
   - `packages/dsh-gamecenter/src/dsh-adapter/protocol.ts` 中的 `dynamicProtocolLoader.load()` 硬编码无条件 `return null`；
   - 生产环境未传 `options.protocol` 时走入该桩，导致 `defineGameCenterService` 返回 `null`；
   - 历史代码不报错，直接 `apply()` 结束，导致 `GameCenterService` **从未实例化，从不注册服务**，Gateway 扫描不到任何 `@Remote` 标记，端点从未被认领（HTTP 404）。
2. **缺陷二（手搓装饰器阻断）**：
   - `applyRemoteMarkers` 中的 `const decorator = Remote()` 空参调用会抛 `TypeError: typert-protocol: Remote decorator context is missing`；
   - 故仅修掉加载器桩仍会触发该异常。

### 16.2 方案落地与 TypeScript Stage 3 标准装饰器重构

1. **引入精准对齐的依赖**：
   - 根工程与 Host 依赖引入 `@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2`（与 DSH 桌面实装版本 100% 一致，杜绝 0.1.5 版本错配）；
2. **标准装饰器声明**：
   - 废除手搓函数 `applyRemoteMarkers()`；
   - `GameCenterService extends TypertRemoteService`，使用 `@Remote` 标准方法装饰器直接修饰全部 5 个方法；
3. **消除静默降级**：
   - 废除恒返回 null 的占位桩；
   - `apply(ctx)` 默认路径直接装配 `GameCenterService`，Context 缺失或装配失败显式抛错，确保 `remoteMounted: true` 成为硬性保证；
4. **Gateway 认领回归闭环**：
   - 在 `test/adapter-dispatch.test.mjs` 中接入 Gateway 原版 `collectSrcClaims` 算法，断言全部 5 个端点（`gameCenter/handshake`、`gameCenter/leaseStatus`、`gameCenter/modelCatalog`、`gameCenter/pause`、`gameCenter/saveAck`）均被正常认领。

### 16.3 候选产物与验证证据（在线 lib 分毫未动）

1. **Host Staging 候选哈希快照**：
   - `staging/index.js`（4819 B）：`93F30A7B51B8D857CF4B722B56F54E54986F7B520C2E38E76AE23A609BFA5222`
   - `staging/remote/game-center-service.js`（18748 B）：`00D8351F3F78322B771663461843A68B367AF073735E73F2E08920CF93F47221`
   - `staging/runtime/lease.js`（15464 B）：`EEB28A6B5B414A311A02E9BC41014477B860666823291A50A0E5A86C29572914`
2. **测试与类型检查退出码**：
   - `pnpm run typecheck`：**退出码 0**；
   - `pnpm run test`：**退出码 0（全工程 192 项全绿：Client 88/88 + Host 94/94 + Protocol 10/10）**；
   - `check-wire-contract`：**PASS**。
3. **在线态隔离状态**：
   - 当前正在服务的 Host `lib/index.js` 保持 `8A913821…` 未变；
   - Client `dist/client.js` 保持 `1BE7FDA8…` 未变；
   - 桌面 profile 与 Junctions 分毫未动，零外部模型调用。

## 17. 用户授权下的 Host 整树受控部署（2026-10-19 15:15）

用户于 2026-10-19 15:06 在群聊中明确回复“授权 Host 更新并重启”。
由 DSH Host 工程师作为唯一部署执行人，严格按 `docs/host-deploy-manifest.md` 冻结清单完成全量整树部署。

### 17.1 部署前冻结校验（零漂移实据）
- **候选 `staging/` 整树摘要**：`CB4DDE0DB452C03C666EC1E05F218BA6`（MATCH）
- **在线 `lib/` 原始整树摘要**：`EB2D9A2B9CF2611ED5F45C376A836E89`（MATCH）
- **文件数**：staging 21 / lib 21，孤儿文件 0 个，变动文件精确为 9 个。
- **算法确认**：按相对路径升序（正斜杠）、格式 `path:UPPERCASE_SHA256`、以 `\n` 连接后取 UTF-8 SHA-256 前 32 位大写。

### 17.2 独立不覆盖持久备份
- **备份目标**：`packages/dsh-gamecenter/staging-rollback/lib.bak-host-EB2D9A2B-20261019-151517`
- **备份整树摘要复验**：`EB2D9A2B9CF2611ED5F45C376A836E89`（21 个文件 100% 吻合）。

### 17.3 整树替换与部署后原位核验
- **整树覆盖**：将 `staging/` 下全部 21 个构建产物逐文件全量覆盖至 `lib/`；
- **部署后 `lib/` 整树摘要**：`CB4DDE0DB452C03C666EC1E05F218BA6`（与候选清单完全一致）；
- **文件完整性**：总文件数 21，孤儿文件 0；
- **核心入口哈希**：`lib/index.js` 为 `93F30A7B51B8D857CF4B722B56F54E54986F7B520C2E38E76AE23A609BFA5222`；
- **核心服务哈希**：`lib/remote/game-center-service.js` 为 `00D8351F3F78322B771663461843A68B367AF073735E73F2E08920CF93F47221`。

### 17.4 周边未受触碰验证
- Client 在线 `dist/client.js`：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`（未动）；
- 真实 profile `package.json`：`4AA2223BFC0E4C50A0C809D743CC068AE112E61860CFC5B4D9158B06FDBAFA39`（未动）；
- 真实 profile `cordis.patch.yml` 与 Junctions 保持原状。

### 17.5 全工程回归验证
- `pnpm run typecheck`：**退出码 0**；
- `pnpm run test`：**退出码 0（全工程 192 项全绿：Client 88 + Host 94 + Protocol 10）**。

### 17.6 后续交接与边界
- 部署动作已完成，但当前运行的 DSH 进程仍运行旧内存，**严禁自行重启或刷新**；
- 已直接通知 QA 进行独立复核，复核确认后由 PM 统一提示用户进行正常 GUI 重启。



