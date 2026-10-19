# 阶段0 Client 侧事实、装配探针与阻塞（界面与运行时工程师）

建立时间：2026-10-18。唯一设计基线：`docs/gamecenter-design.zh-CN.md`（已全文读取 484 行）。
证据分栏沿用 `docs/phase0-acceptance.md`：`STATIC` / `UNIT` / `MOCK` / `BUILD` / `DSH-REAL` / `AUTH-PENDING`。
脱敏约定（2026-10-19）：文中 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>` 为路径占位符，**不是可直接执行的路径**；摘要值取自脱敏前样本，未重算。

> **本文最高只到 `BUILD` + `UNIT`。阶段0 要求的 `DSH-REAL`（在运行中的 DSH 里真的打开弹层并关闭停收）
> 本轮尚未产出，因此不能宣称阶段0 通过。** §6 说明原因与最小放行条件。

## 1. 目标 DSH 版本（`STATIC`，读自安装包本体）

| 字段 | 值 | 证据 |
| --- | --- | --- |
| `@deepseek-ai/dsh-desktop` | `0.2.1-rc.2` | `app.asar` 根 `package.json` |
| `dshBuildCommit` | `332895e0f7c9d4dbfb29729f5eb367fa263ff986` | 同上 |
| `dshBuildDirty` | `false` | 同上 |
| Client 运行时 | `@deepseek-ai/dsh-desktop-runtime` `0.2.1-rc.2`，hostProtocolVersion 4 | `dsh/desktop-runtime.json` |
| Client 模块系统 | `@deepseek-ai/dsh-client-modules` `0.2.1-rc.2` | 包内 `lib/index.js` + `lib/client.js` |

与架构负责人 `docs/phase0-architecture.md §2` 的结论一致：**实装提交 ≠ 基线引用提交 `687f282e…`**，
本文全部 Client 结论只对 `332895e0…` 有效。

## 2. Client 插件真实装配点（`STATIC`，逐条有源码位置）

| # | 事实 | 源码位置 |
| --- | --- | --- |
| 1 | Host 侧扫描 Loader 已装载条目，读 `package.json` 的 `dsh.client`；`platform !== "web"` 直接跳过 | `dsh-client-modules/lib/index.js` `ClientModuleRegistry.resolveMeta()` |
| 2 | 声明了 `dsh.client` 但 `exports["./client"]` 缺失 → 抛错 `declares dsh.client but exports no "./client" bundle` | 同上 `resolveMeta()` |
| 3 | bundle 经 `/plugins/??<id>/client.js&rev=…` 组合下发，并注入 `window.__DSH_BOOT__` | 同上 `compose()` / `bootInjections()` |
| 4 | 浏览器侧 `ClientEntries.start()` 为每个 entry 建 Cordis fiber，`inject` 未满足则等待 | `dsh-client-modules/lib/client.js` |
| 5 | 模块系统提供 `window.__ModuleLoader__.load({id, factory})` 注册契约 | `lib/client.js` `ClientModuleSystem` |
| 6 | **浏览器静态外部表只提供 11 个名字**：react、react/jsx-runtime、react-dom、react-dom/client、`@deepseek-ai/cordis`、zod、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit` | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 中 `SZ()` |
| 7 | `shell.overlay` 是 **list** 槽：`"shell.overlay": { kind: "list", scope: "root" }` | `dsh-client-ui-layout/lib/client.js` root 注册的 `children` |
| 8 | AppFrame 以 `renderSlot("shell.overlay", {})` 渲染，外层 `data-shell-overlay` 容器 | 同上 `AppFrame` |
| 9 | 侧栏 `sidebar.panellist` 也是 list，条目读取 `options.id / order / label` | `dsh-client-ui-sidebar/lib/client.js` `syncPanels()` |
| 10 | 组件 props = 标准 root props + 命令式 `inject()` 结果 + 槽 owner props；**没声明 children 的注册项拿不到 `renderSlot`** | `dsh-client-ui-renderer/lib/client.js` `standardKit()` / `renderEntry()` |
| 11 | 共享 `Modal` 存在且 props 为 `open/onClose/title/closeLabel/description/children/footer/headless/backdropBlur/...`，导出名在 primitives 里 | 同上 web-frontend 包 `zU` 导出表 `Modal:S_` 与 `S_` 实现 |
| 12 | 外部包进入 Client 的两条路：① 被 Host Loader 装载（profile bundle / `cordis.patch.yml`）；② `dsh plugin` 安装 | `dsh-app-boot/lib/index.js` `loadProfileDirectory()` + `resolveBundleDir()` + `patch insert` |
| 13 | 随包 Client 插件的 `dsh.client` **只有 `platform` 与 `inject`**，从不写 `external`；`inject` 是 Cordis **模块 id**，不是 npm 包名 | `dsh-client-ui-plugin-market/package.json`（实读全文） |
| 14 | 兼容门槛优先读 `engines.dsh`，用 `semver.satisfies(runtime, range, {includePrerelease:true})`；缺失才退回 `peerDependencies` | `dsh-app-boot/lib/index.js` `unmetRequirements()` / `getDshRuntimeVersion()` |

**结论（可作为契约）**：`shell.overlay` 是 list，我们的弹层**作为并列项追加**，不会替换已有 overlay ——
这正是基线 §7 要求的形态，不需要占用 single 位置，也不需要改 DSH 核心。

## 3. 本轮实际产出（文件所有权：`packages/dsh-gamecenter-client/**`、`docs/phase0-client.md`）

```text
packages/dsh-gamecenter-client/
  package.json            # dsh.client{platform:web,inject} + exports["./client"]
  tsconfig.json           # allowJs/checkJs + emitDeclarationOnly（浏览器半按 JS+JSDoc 建模）
  lib/client.js           # 模块注册壳：__ModuleLoader__.load({id, factory}) → ../src/index.js
  src/                    # 浏览器半源码（index / ui / runtime / bridge），类型检查与单元测试共用
  src/types/              # tsc 产出的 .d.ts
  test/*.test.mjs         # 20 项 UNIT
  tools/asar-{probe,grep}.mjs           # 只读访问安装包，不修改安装目录
docs/phase0-client.md
```

### 3.1 能力清单

| 模块 | 内容 | 对应基线 |
| --- | --- | --- |
| `src/runtime/lease.js` | 运行代次、`requestPause` 唯一收敛点、保存确认、暂停超时回落、Bridge 准入 | §8.1 §8.3 §8.4 |
| `src/runtime/resources.js` | 资源清理表（iframe/worker/audio/raf/timer/listener/subscription/port），逆序释放、幂等 | §7 末尾 |
| `src/bridge/host-bridge.js` | 握手校验（`event.source` + 一次性 nonce + 运行实例）、入站信封 Schema/大小校验、滑动窗口频率限制、出站信封 | §6 §7 |
| `src/ui/GameCenterOverlay.js` | 可聚焦 `role="dialog" aria-modal` 弹层；关闭/遮罩/Escape/返回列表**全部**走同一个 `requestPause` | §7 §8.1 |
| `src/index.js` | 真实装配点：`sidebar.panellist` 入口 + `shell.overlay` 并列弹层 | §7 |

### 3.2 已实现的关闭语义（不只是文案）

1. 进入 `Pausing` **立即**清空输入、冻结虚拟时钟（`inputOpen=false`、`clockFrozen=true`）。
2. 保存确认只有**当前代次**才生效；旧代次 `saveAck` 返回 `refused` 且不改状态。
3. 暂停超时（`PAUSE_TIMEOUT_MS = 3000`）后不再等游戏，进入 `recovery-available`，提示文案
   **如实说明最近检查点或“本次没有成功保存过检查点”**。
4. 关闭后在保存确认/超时之后才销毁实例并 `releaseAll()`，资源账本归零。
5. 暂停后任何 Bridge 调用返回 `PAUSED`；代次不符返回 `STALE_RUNTIME`；非白名单返回 `PROTOCOL_INVALID`。

## 4. 实际执行的命令与退出码（本轮）

| # | 命令 | 退出码 | 结论 |
| --- | --- | --- | --- |
| 1 | `read docs/gamecenter-design.zh-CN.md`（484 行全文） | 0 | 已读 |
| 2 | `node tools/asar-probe.mjs …`（读包里 20+ 个文件） | 0 | 未修改安装目录，仅 `open(...,'r')` |
| 3 | `pnpm install --filter @dsh-gamecenter/{client,protocol} --offline` | 0 | workspace 链接（`offline`，无网络） |
| 4 | `npx -y -p typescript@5.7.3 tsc -p packages/protocol/tsconfig.json` | 0 | 协议包 `dist/` 重新生成 |
| 5 | `npx -y -p typescript@5.7.3 tsc -p tsconfig.json`（client） | 0 | `BUILD`：`allowJs+checkJs` 通过，产出 `src/types/**/*.d.ts` |
| 6 | `node --test test/*.test.mjs` | 0 | `UNIT`：**20/20 通过** |
| 7 | `node tools/asar-grep.mjs …`（装配点与静态外部表定位） | 0 | 见 §2 |
| 8 | `node -e "import('./lib/client.js')"` | **1** | **预期失败**：Node 里没有 `@deepseek-ai/cordis` 外部包，报 `Cannot find package '@deepseek-ai/cordis'` —— 这恰好证明 `lib/client.js` 已在执行 `src/index.js` 顶层的 ESM import，而不是静默空转。该外部包只由 DSH 浏览器静态外部表提供，**不能**在 Node 侧“补依赖”假造通过。 |

### 4.2 第二轮（`cmd /c` 通道复跑 + 清单修正）

按架构负责人给出的 `cmd /c` 通道重跑，结果与首轮一致；并据随包清单更正了我自己的 `package.json`。

| # | 命令（均在 `packages/dsh-gamecenter-client` 下） | 退出码 | 结论 |
| --- | --- | --- | --- |
| 1 | `cmd /c "npx -y -p typescript@5.7.3 tsc -p tsconfig.json"` | 0 | `BUILD` 复现通过 |
| 2 | `cmd /c "node --test <4 个测试文件>"` | 0 | `UNIT`：**22/22 通过**（新增 2 项清单断言） |
| 3 | `node tools/asar-probe.mjs … dsh-client-ui-plugin-market/package.json` | 0 | 见下方 3 条清单事实 |

**清单事实（`STATIC`，来自随包发布的真实插件，不是猜测）**：

1. 随包 Client 插件的 `dsh.client` **只有 `platform` 与 `inject`，从不声明 `external`**。
   更早那版 `external: ["@deepseek-ai/dsh-client-ui-renderer"]` 是我的误写：`inject` 是 **Cordis 模块 id**，
   不是 npm 包名，也不需要 `external` —— 已删除，改为 `inject: []`（本插件不前置依赖其他 client 插件）。
2. `engines.dsh` 是真实判定字段：`dsh-app-boot` 的 `unmetRequirements()` 优先读 `engines.dsh`，
   缺失时才退回 `peerDependencies`；判定用 `semver.satisfies(runtimeVersion, range, {includePrerelease:true})`，
   `runtimeVersion` 取自 `dsh-app-boot` 自身 `package.json.version`（实装 `0.2.1-rc.2`）。
   因此写成 `>=0.2.1-rc.2 <0.3.0`，而非 `^0.2.1-rc.2`（后者在 pre-release 语义下容易被误读）。
3. `peerDependencies` 里 `@deepseek-ai/cordis: ~4.0.5` 与实装 `cordis 4.0.5` 一致；
   **`@dsh-gamecenter/protocol` 这个 workspace 依赖已移除** —— 浏览器 bundle 不能 require 内部包，
   协议常量改由 `src/bridge/host-bridge.js` 本地镜像 + `test/bridge-constants.test.mjs` 同源断言来保证。

### 4.1 会话环境事实（与架构负责人记录一致）

本轮开始时文件策略为 `workspace-write`，`pwsh` 每次调用返回 `[exit code: 3221225794]`（`0xC0000142`）且无输出；
策略切换为 `danger-full-access` 后 shell 恢复并完成上述命令。**任何“shell 不可用”的结论都必须注明当时策略。**

## 5. 证据边界（明确不做承诺）

- `UNIT` 的 20 项**不**证明弹层已在 DSH 内渲染；它们证明状态机、资源账本、握手/信封校验的行为符合基线。
- `BUILD` 的 `tsc` 通过**不**证明可被 DSH 浏览器加载：`react` 与 `@deepseek-ai/cordis/ui` 在本项目内无类型包，
  代码里以 `@ts-expect-error` 显式声明“由 DSH 静态外部表提供”。
- `lib/client.js` 目前是**注册壳 + ESM 相对 import**，不是 DSH 生产用的单文件打包产物；
  真实加载前必须用 DSH 同形打包（IIFE/rolldown 输出）重出 bundle。
- `Modal` 当前**未直接 require**：我们的包不在静态外部表的“预编译产物”范围内，
  直接 `require('@deepseek-ai/dsh-client-ui-primitives')` 会在运行时改名失败的风险；
  阶段0 用等价的无障碍 dialog 语义自绘，阶段1 再评估是否改为打包期 vendor。

## 6. 阻塞与最小放行条件（交项目经理）

### 6.1 阻塞：无法合法完成 `DSH-REAL` 验证

| 阻塞点 | 证据 | 为什么不绕过 |
| --- | --- | --- |
| 外部包需要进入 Client 入口图 | 见 §2 #1/#12：只认 Host Loader 装载的条目 | 需要改用户的 DSH profile（`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`）或在配置里 `insert` 一个 bundle 条目 —— 属于**账号/配置类变更，须用户批准** |
| 运行中的 GUI 不能由我重启 | 会话规则 | 新 bundle 只在 Host 启动时装配；不重启就无法证明真实挂载 |
| 无 DSH 内自动化入口 | 本会话可用的浏览器工具无法访问 `127.0.0.1:3080`（`web_fetch` 拒绝非公网地址） | 需要用户在桌面 GUI 里目视验收，或提供受认可的自动化通道 |

### 6.2 最小放行路径（需项目经理/用户批准其中一条）

1. **配置文件法（推荐，改动最小）**：批准我在 `~/.dsh/profiles/desktop/package.json` 的
   `dsh.profile.bundles` 追加一个指向本仓库的 bundle 条目，并新建 `cordis.patch.yml` 声明
   `insert: [{ id: 'gamecenter-client', name: '@dsh-gamecenter/client' }]`。
2. **插件安装法**：用 DSH 自带插件安装流程把本包装进 profile（会产生包管理器写入，同样需批准）。
3. **只读验收**：由用户在桌面 GUI 手工打开“游戏中心”，记录弹层与关闭行为，作为 `DSH-REAL` 证据。

三种方式都**不改 DSH 安装目录**、不另起服务器、不重启运行中的进程（第 1/2 条需要用户自己重启一次 GUI）。

### 6.5 本轮：单文件打包为何**没有**完成（附已尝试方法与原始错误）

项目经理要求「先完成单文件打包」。**未完成**，阻塞在 esbuild 拿不到。以下是实际执行与原始报错，
不再重复摸索：

| # | 尝试 | 结果 |
| --- | --- | --- |
| 1 | `npx -y esbuild@0.28.2 --version` | `0.28.2`，exit 0 —— **npx 能取到**，但装在临时目录 |
| 2 | `node tools/build-bundle.mjs`（`import { build } from 'esbuild'`） | `ERR_MODULE_NOT_FOUND`，exit 1：npx 的临时安装不在项目 `node_modules`，Node 解析不到 |
| 3 | `pnpm add -D -w esbuild@0.28.2 --offline` | `ERR_PNPM_NO_OFFLINE_META`：本地 pnpm 元数据缓存里没有 esbuild |
| 4 | `pnpm install --offline`（修复锁文件一致性） | 失败于 `peerDependencies.@deepseek-ai/cordis`：本地缓存没有 `@deepseek-ai/cordis` 的元数据 |

**根因**：本项目从未真正安装过任何 npm 依赖（只有 workspace 链接），本地没有任何 registry 元数据缓存；
而联网安装属于对包管理器/网络的写入，未获批准，我不自行执行。

**同时发现一个真实的装配缺陷（重要）**：`peerDependencies: {"@deepseek-ai/cordis": "~4.0.5"}`
会让 `pnpm install` 去解析一个**并不存在的 registry 包**（`@deepseek-ai/*` 随 DSH 发行版提供，不在公共 registry）。
已从 Client 包移除该 `peerDependencies`，改用 DSH 自己认的 `engines.dsh` 表达兼容范围。
这与实装随包插件的做法一致：它们的 `peerDependencies` 只写 `@deepseek-ai/cordis`，但那是**官方 monorepo 内部**的写法，
外部第三方包不应照抄。

**打包产物已就绪的部分**（不含 esbuild 也能验证的部分）：

- `tools/build-bundle.mjs`：按实装产物形态（`window.__ModuleLoader__.load({id, factory:(require)=>{...}})`）
  + 11 项静态外部表白名单作为 `external` 配置好，**一旦有 esbuild 即可产出**。
- `test/bundle-shape.test.mjs`：对 `dist/client.js` 做结构强断言（顶层不得有 ESM、注册调用恰好一次、
  `require("react")` / `require("@deepseek-ai/cordis/ui")` 必须保留、cordis 不得内联）；
  `dist/client.js` 不存在时**明确 skip 并打印原因**，不伪通过。
- `lib/client.js` 已明确标注为「过渡期 ESM 壳，不是生产产物」，并有测试守住这个事实。

**放行所需**：批准一次联网 `pnpm add -D -w esbuild@0.28.2`（仅 devDependency，不改运行时代码），
或提供离线 tarball；随后 `node tools/build-bundle.mjs` 即可产出 `dist/client.js`。

## 6.6 弹层无障碍：本轮补上的可断言证据

| 约定 | 实现 | 测试 |
| --- | --- | --- |
| Escape 只关最上层，且 `preventDefault` 不连动 DSH 全局快捷键 | `src/ui/focus.js` `pushEscapeLayer()` | `test/focus.test.mjs` ① |
| 出栈幂等，最后一个弹层关闭后移除全局监听 | 同上 | ② |
| 输入法组字中（`isComposing` / keyCode 229）Escape 不关闭 | 同上 | ③ |
| 关闭后焦点回到打开前元素 | `captureFocusReturn()` | ④ |
| 原元素已移除时退回触发元素，不把焦点丢给 body | `isFocusable()` | ⑤⑥ |
| 关闭按钮 / 遮罩 / 返回列表 / Escape 共用同一个 `close()` → `requestPause()` | `GameCenterOverlay.close()` | 与 `runtime-lease.test.mjs` 的「每条关闭路径都归一」互补 |

**这些是 `UNIT`**：用最小 DOM 替身验证 focus.js 的真实逻辑，**不是**浏览器里的实测。
浏览器内仍需用户目视确认（见 §6.1）。

## 6.7 当前证据计数

| 分栏 | 内容 | 状态 |
| --- | --- | --- |
| `BUILD` | `tsc -p tsconfig.json`（allowJs+checkJs） | exit 0 |
| `UNIT` | 6 个测试文件 | **32/32 通过** || `BUILD`（打包产物） | `dist/client.js` | **未产出**（缺 esbuild，见 §6.5） |
| `DSH-REAL` | 弹层真实打开/关闭 | **未产出** |

### 6.3 需要其他负责人的输入

- DSH Host 工程师：Host 侧 `GameCenterService` 的 Remote 命名空间名与 `generation` 下发方式，
  决定了 `beginRuntime()` / `onSaveAck()` 的接法；请在 Host 探针报告中给出确切的 `ctx.remote.<ns>` 形状。
- 测试与发布负责人：验收证据需要区分 `BUILD` 与 `DSH-REAL`，否则“32/32 通过”会被误读为阶段0 通过。

### 6.4 已回复架构负责人的四项包配置（本轮）

| 项 | Client 包答复 |
| --- | --- |
| 包名 | `@dsh-gamecenter/client`（`exports["./client"]` → `./lib/client.js`；`.` 同指，便于 `cordis.patch.yml` 用包名装载） |
| 运行形态与 engines | 浏览器 Cordis 插件（`dsh.client.platform="web"`，`inject: []`）；`engines.dsh: ">=0.2.1-rc.2 <0.3.0"`；`peerDependencies: {"@deepseek-ai/cordis": "~4.0.5"}`；**无 `engines.node`**（该字段对浏览器半无判定意义） |
| 外部依赖 | 构建期无；运行时只依赖 DSH 静态外部表里的 `react`、`react/jsx-runtime`、`@deepseek-ai/cordis`（及 `@deepseek-ai/cordis/ui`）。**不依赖任何 `@dsh-gamecenter/*` 内部包** |
| 构建产物 | **已产出 `dist/client.js`**（esbuild IIFE + factory 壳）。结构断言见 `test/bundle-shape.test.mjs`。`lib/client.js` 仍保留为过渡期 ESM 壳，不得用于真实装载。 |

## 7. 单文件打包：已完成（`BUILD`）

架构与协议负责人把 `esbuild@0.28.2` 装到项目根后，我复现了构建：

| 命令（workdir = `packages/dsh-gamecenter-client`） | 退出码 | 输出 |
| --- | --- | --- |
| `node tools/build-bundle.mjs` | 0 | `built dist\client.js (18343 chars)` |
| `node --test test/bundle-shape.test.mjs` | 0 | 3/3 通过 |

**产物结构（实读 `dist/client.js`）**：

```js
window.__ModuleLoader__.load({
	id: "@dsh-gamecenter/client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		… // esbuild IIFE
		exports.apply = __dshGameCenterClient__.apply;
		exports.inject = [];
		return module.exports;
	}
});
```

外部依赖确认**留在 require 里**（未内联）：

```text
var import_ui2 = __require("@deepseek-ai/cordis/ui");
var import_ui  = __require("@deepseek-ai/cordis/ui");
var import_react = __require("react");
```

> 注意：文件大小与架构负责人报告的 18765 字节略有差异（我这次 18343 字符），是 UTF-8 字节数与字符数
> 的区别，不是两次构建不同。

## 8. 【更正 Host 工程师的一条判断】`ctx.remote.$mount()` 不是私有入口

Host 工程师报告「Client 侧 `ctx.remote.$mount()` 是唯一入口，而 `dsh-api-remotes` 的 Client `apply()`
把 26 个贡献写死在源码里，所以本机没有合法办法为 `gameCenter` 生成 contribution」。前半句与我的实读**不一致**：

| 事实 | 证据（只读 asar） |
| --- | --- |
| `$mount` **不是** `dsh-api-remotes` 的成员，而是 **`@deepseek-ai/dsh-api-gateway` 的 Client 服务方法** | `dsh-api-gateway/lib/client.browser.js`：`async $mount(contribution) { … }` |
| 它是**公开方法**，任何注入了 `remote` 服务的插件都可以调用 | 同上；`dsh-api-remotes` 的 `inject = ["remote"]`，其 `apply()` 只是 `for (const contribution of [...26个]) disposers.push(await ctx.remote.$mount(contribution))` 的**调用方之一** |
| `$mount` 内部走 `mountContribution(callerCtx, contribution)` → `callerCtx.typert.remotes.register(contribution)` → 按 `descriptor.namespace` 分组 `installNamespace()` | `dsh-api-gateway/lib/client.browser.js` `mountContribution()` |
| 校验只针对**形状**，不要求「必须由官方生成器产出」 | 同上 `validateContribution()`：重复 `namespace+method` 报错、`requireStrictInputs(descriptor)`、`invocation.kind === "direct"` / `scopedProjection()` |
| `contribution` 只需 `{ package, descriptors[] }`，`descriptors[]` 每项含 `namespace` / `method` / `invocation` | 同上；`$mount` 里用 `contribution.package` 做诊断串 |

**结论**：`dsh-typert-generator` 缺失**确实**意味着没法「用官方生成器一键产出」，但这**不等于**没有合法路径。
我们自己的 Client 插件只要 `inject` 到 `remote`，就可以 `await ctx.remote.$mount(<自建 contribution>)`
挂载 `gameCenter` 命名空间。这条路**没有逆向私有 API**，用的是公开服务方法。

**但必须如实标注不确定性**（我没有把这条当成已通过）：

1. `descriptor` 的**完整字段集**我尚未逐字段核实（`requireStrictInputs` 的具体要求、`invocation` 的 `kind` 取值域、
   `scopedProjection` 触发条件）。缺少这些，手写 descriptor 仍是**未验证**的。
2. 这条路要求 `dsh-api-gateway` 的 Client 半已在 composition 里（实装默认有，`immediately: true`），
   且我们插件 `inject` 得到 `remote` 服务 —— 这需要真实装配才成立。
3. 因此 §9 的三个选项里，我**倾向 (b) 自建 contribution 走公开 `$mount`**，但先要补齐 descriptor 形状核实；
   在补齐之前，(c) 自有 Bridge 通道仍是唯一**已验证可行**的低成本路径。

## 9. 给项目经理的选择（Remote 接线形态）

| 选项 | 代价 | 风险 | 我的评估 |
| --- | --- | --- | --- |
| (a) 向上游要 generator | 等发行版 | 阶段0 无法推进 | Host 工程师已确认不可行（不随发行版提供） |
| (b) 自写 `TypertRemoteContribution` 走公开 `ctx.remote.$mount()` | 需补齐 descriptor 字段集核实（约半天） | 形状随版本漂移；无官方 schema 文档 | **有证据支持可行**，但未验证，不冒充已完成 |
| (c) 阶段0 走自有 Bridge 通道，放弃 `ctx.remote.gameCenter` | 最低 | 偏离基线「用 Typert Remote 暴露服务」的假设 | 唯一已验证可行的兜底 |

**我的建议**：阶段0 用 (c) 拿到 `DSH-REAL`（弹层能开、关闭能停收），同时并行做 (b) 的形状核实；
若 (b) 核实通过，阶段1 再切到 Remote 形态。这样阶段0 不被 Remote 形态卡死。

## 10. 【已更正】方案 (b)：我原先的否决结论是错的

> **⚠️ 本节整体作废，保留作为自查记录。** 我先前用 `probe-remote-shape.mjs` 判定
> 「gateway 读 `descriptors`、registry 读 `invocations`，形状不兼容」，**该判定错误**。
> 错误原因与更正后的结论见 §11。保留原文是为了让复核者看清错在哪，
> 不是为了维持结论。**当前有效结论以 §11 为准。**

项目经理已定 (b) 为 Remote 主线。我按要求先逐字段核实，**结论是 (b) 目前不成立**，
证据来自 `tools/probe-remote-shape.mjs`（只读 asar，exit 0，可复现）。

### 10.1 探针输出（原样）

```text
=== 1. dsh-api-gateway/lib/client.browser.js ===
mountContribution 找到: true
  读取 contribution.* : descriptors
validateContribution 找到: true
  读取 contribution.* : descriptors
  读取 descriptor.*   : namespace

=== 2. dsh-typert-registry/lib/client.browser.js ===
remotes.register 找到: true
  读取 contribution.* : invocations
  validatePackage 读取 contribution.* : invocations
  validateSchemas 读取 contribution.* : invocations

=== 3. 结构差异判定 ===
gateway 需要: descriptors
registry 需要: invocations
仅 registry 要求: invocations
判定: 形状不兼容 —— 手写 contribution 必须额外提供 invocations
```

> 探针用「抽取函数体 + 取该变量实际读取的属性」而非文本搜词，符合架构负责人那条纪律
> （证据要指出「哪个文件的哪个结构」）。§10.2 是人工逐行复核，防止正则漏掉解构赋值。

### 10.2 人工复核（逐条）

| # | 事实 | 位置 |
| --- | --- | --- |
| 1 | `$mount(contribution)` 只校验重复挂载，调 `mountContribution(callerCtx, contribution)` | `dsh-api-gateway/lib/client.browser.js` |
| 2 | `mountContribution` 第一行 `this.validateContribution(contribution)`，随后 `callerCtx.typert.remotes.register(contribution)`，**同一个 contribution 对象被传给两套不同校验** | 同上 |
| 3 | `remotes.register(contribution)` 首行 `this.validatePackage(contribution)` → 要求 `contribution.package`（`validateSegment`）与 `contribution.face` ∈ `{"host","client"}`，并读 `contribution.model` | `dsh-typert-registry/lib/client.browser.js` |
| 4 | 同函数再调 `validateSchemas(contribution)` → 遍历 `contribution.schemas`，每个须有 `name` 与 `create()` 工厂 | 同上 |
| 5 | 同函数读 `contribution.invocations` → `this.localStore.validate(invocations)` 并 `commit(owner, invocations)` | 同上 |
| 6 | codec 必须 `codec.mode === "strict"`，否则抛 `has no strict codec` | `dsh-api-gateway` `requireStrictCodec()` |
| 7 | `isTypertRemoteMethod()` 还要求 `result.mode === "strict"`，且 `input`/`invoke` 均为函数 | `dsh-typert-protocol/lib/index.js` |

### 10.3 判定

**(b) 不能直接成立，原因是同一个对象要同时满足两套互不相同的形状**：

- gateway 侧要 `descriptors[]`（每项 `namespace` / `method` / `invocation` / `parameters[].codec` 等）；
- registry 侧要 `package` + `face` + `model` + `schemas[]` + `invocations`；
- 而 registry 的这条路径**只读 `invocations`，完全忽略 `descriptors`**（探针已证明），
  所以只填 `descriptors` 必然在 `remotes.register()` 阶段失败。

**要手写一份能过两道关的 contribution，等于自己重实现 Typert 的 codec/zod 运行时**
（`codec.mode==="strict"`、`schema.create()` 工厂、`result.decode/encode`）。这不是「补几个字段」，
而是逆向一套没有公开 schema 的中间表示；随版本漂移风险高。

**因此我给项目经理的修正建议**：

1. **(b) 降级为不可行（本版本）**，理由不是「generator 缺失」，而是上面的**形状不兼容 + 双重校验**，
   有可复现探针。
2. 我此前说 (c) 是「唯一已验证可行」——**现在撤回这句话的措辞**：我没有完整 Host 通道的运行证据，
   (c) 只是「成本最低、且不依赖未验证逆向」的备选，**不降低阶段0 Remote 门禁**。
3. 阶段0 若要在本版本拿到 Remote 形态，唯一干净路径是**向上游要 `dsh-typert-generator`**
   （或等价官方 contribution 构造助手）。这属于发行版能力问题，需要项目经理向用户/上游提出。

### 10.4 已同步给协作方的输入请求

已直接向 DSH Host工程师 与 架构与协议负责人 各发一条（不重复派工）：

- Host：要 `gameCenter` 五方法的权威 descriptor 实例 `JSON.stringify`、`AbortSignal` 位置、取消语义；
- 架构：独立复核 §10.3 的两道形状要求，以及 `typert.remotes.register` 是否还有我漏掉的注入点。

## 11. 【更正】§10 的否决结论作废 —— 错在抓错了类

DSH Host工程师 交付了 `packages/dsh-gamecenter/src/remote/contribution-shape.ts` 与
`test/contribution-shape.test.mjs`，结论与我的 §10 冲突。我自己重核，**是我错**。

### 11.1 我错在哪里

`tools/probe-remote-shape.mjs` 里的 `extractFunction(registryBundle, 'register(contribution)')`
用**第一个匹配**定位函数，结果抓到的是 `TypertRegistry.register(contribution)`
（包面/schema 注册，读 `invocations`），而 `ctx.typert.remotes` 实际返回的是
**`RemoteStore.view()`**，其 `register` 签名是 `register(ctx, contribution)`。

这违反了组内纪律「证据必须指出**哪个文件的哪个结构**」——我加了「哪个文件」，
但**没验证「哪个类的哪个方法」**。这也正是 DSH Host工程师 提醒过的同一类错误（字符串/首个匹配 ≠ 实现）。

### 11.2 更正后的实测（`tools/probe-remote-store.mjs`，只读，exit 0）

```text
=== typert.remotes 的真实来源 ===
get remotes() 体: get remotes() { return this.remoteStore.view(this.ctx); }

=== RemoteStore.view() 暴露的 register ===
确认 register 签名: register(ctx, contribution) → true

=== RemoteStore.register(ctx, contribution) 实际读取的字段 ===
contribution 读取: descriptors, package
是否读 invocations: false
是否读 descriptors : true
是否读 schemas     : false
是否读 face        : false

=== 对照：TypertRegistry.register(contribution)（另一条分支，与 remotes 无关）===
contribution 读取: invocations
说明: 这是包面/schema 注册，不是 ctx.typert.remotes.register 的实现。
```

**结论翻转为**：gateway 与 `typert.remotes` **两侧都只要求 `{ package, descriptors[] }`**，
**形状是兼容的**。我 §10 说的「同一个对象要满足两套互不相同的形状」**不成立**。

### 11.3 顺带核实 Host 工程师的另一条关键论断

| 论断 | 我的独立核实 | 结果 |
| --- | --- | --- |
| Client 调用期不 encode 参数 | `dsh-api-gateway/lib/client.browser.js` 全文 `.encode(` **0 命中**；实际调用点 `await connection.rpc.call("/api", endpoint, { args: prepared.args }, prepared.signal)` | **成立** |
| `result.decode` 可省略 | 同处：`descriptor.result.mode === "strict" && descriptor.result.decode !== void 0 ? descriptor.result.decode(...) : …` | **成立**（decode 缺省时原样返回） |
| codec 必须 `mode:"strict"` | `requireStrictCodec()` 抛 `has no strict codec` | 成立（§10.2 #6 本来就对） |
| `cancellation` 必须声明才有 AbortSignal | Host 工程师出示 `prepareInvocation` 的 `if (descriptor.cancellation !== void 0) args.push(signal)` | 采信（Host 侧源码，我未逐行复核） |

### 11.4 修正后的方案状态

- **(b) 恢复为可行候选**，形状要求就是 Host 工程师那份 `WireContribution`：
  `{ package, descriptors[] }`，descriptor 含 `namespace` / `method` / `invocation:{kind:'direct'}` /
  `parameters[].codec:{mode:'strict'}` / `result:{mode:'strict'}`；
  `modelCatalog` 额外填 `cancellation`；**不要填 `scope`**（填了会走 scoped 路径并要求唯一 lookup 参数）。
- **仍未验证的**：真实 `$mount` 调用、装载后 `ctx.remote.gameCenter.*` 能否真的调到 Host。
  上面全部是 `STATIC` + 探针，不是 `DSH-REAL`。
- 我 §10.3 里「向上游要 generator 是唯一干净路径」**同样收回**：generator 缺失只意味着不能自动生成，
  不意味着不能手写。

### 11.5 教训（写给自己的，也建议全组）

探针结论必须同时锚定**文件 + 类 + 方法**三级；只锚到文件级时，同一个 bundle 里的同名方法会让你抓到错的那个。
我这条错误直接导致向项目经理交了一份错误的否决建议，这是实打实的教训。

## 12. 方案 (b) 已实现：Client 侧挂载 + 本地契约测试

### 12.1 交付文件（`packages/dsh-gamecenter-client/**`，未碰他人文件）

| 文件 | 内容 |
| --- | --- |
| `src/bridge/remote-mount.js` | `createGameCenterContribution()` 五个 descriptor、`validateContributionShape()`（复刻 `requireStrictInputs`）、`mountGameCenterRemote(ctx)`（调公开 `ctx.remote.$mount`）、`createGameCenterClient()` 五方法包装 |
| `src/index.js` | `export const inject = ['remote']`；新增 `gamecenter: remote $mount` effect，挂载失败**不阻塞 UI**（弹层可开，但记录 `MOUNT_*` 原因） |
| `tools/probe-remote-store.mjs` | 更正后的只读探针，锚定「类 + 方法」 |
| `test/remote-mount.test.mjs` | 10 项：形状、cancellation、负数例、MOCK 端到端、卸载重挂、缺服务、抛错透传 |

### 12.2 contribution 形状（与 Host 侧 `contribution-shape.ts` 同源）

```js
{ package: '@dsh-gamecenter/client', descriptors: [
  { namespace:'gameCenter', method:'handshake',  invocation:{kind:'direct'},
    parameters:[{name:'input',wire:'input',source:'json',codec:{mode:'strict'}}],
    result:{mode:'strict'} },
  … pause / saveAck / leaseStatus 同上 …
  { namespace:'gameCenter', method:'modelCatalog', invocation:{kind:'direct'},
    parameters:[], result:{mode:'strict'}, cancellation:{signal:'abort'} },
]}
```

关键点（每条都有源码出处，见 §10.2 / §11.3）：

- `codec.mode` 与 `result.mode` 必须 `"strict"`；
- **不填 `scope`**（填了走 scoped 路径并要求唯一 lookup 参数）；
- `modelCatalog` 无业务参数，但**必须声明 `cancellation`**，否则 Host 少传 AbortSignal；
- 参数不经 Client 编码，**wire 字段名必须与 Host 形参名一致**（最容易踩的坑）。

### 12.3 测试与构建（本轮实测）

| 命令（workdir = `packages/dsh-gamecenter-client`） | 退出码 | 结果 |
| --- | --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | 0 | `BUILD` |
| `node --test <7 个测试文件>` | 0 | **UNIT/MOCK 42/42 通过** |
| `node tools/build-bundle.mjs` | 0 | `built dist\client.js (23226 chars)` |
| `node tools/probe-remote-store.mjs` | 0 | §11.2 输出 |

`dist/client.js` 已确认含 `gameCenter` 挂载逻辑，且 `__require("@deepseek-ai/cordis/ui")`、
`__require("react")` 仍保留为外部依赖。

### 12.4 仍未验证（不得声称通过）

1. **真实 `$mount` 调用**：MOCK 复刻的是校验规则，不是 DSH 进程行为。
2. **装载后 `ctx.remote.gameCenter.*` 是否真的连到 Host 侧 `@Remote` 方法**。
3. Host 侧 `resolveDescriptor` 的 SRC 回退（Host 工程师 §8.4 提到的 `hasSeen` 风险）。
4. 弹层真实渲染与关闭停收。

→ 全部需要先把 `dist/client.js` 装进 profile 并重启 GUI，属**须用户批准**的配置变更。

## 13. 【第二次更正】descriptor 还有第二道闸门：`id` / `service` / codec 字段

架构与协议负责人独立复核后指出，`typert` 侧 `validateInvocation` 比我实现时认定的更严。
我按「文件 + 类 + 方法」三级重核（`tools/probe-typert-rules.mjs`，只读，exit 0），**他是对的，我上一版漏字段**。

### 13.1 实测（探针原样输出）

```text
=== A. typert validateInvocation 读取的 descriptor 字段 ===
cancellation, id, implementation, invocation, method, mode, namespace, parameters, result, scope, service, uplink

=== B. typert validateCodec 的放行规则 ===
function validateCodec(codec, subject) {
  if (codec.mode === "src-json") return;
  validateNonempty(`${subject} type symbol`, codec.typeSymbol);
  if (typeof codec.create !== "function") throw new Error(`typert: ${subject} strict codec has no create() factory`);
}

=== C. gateway requireStrictCodec 的放行规则 ===
function requireStrictCodec(codec, endpoint, field) {
  if (codec.mode !== "strict") throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`);
}

=== D. RemoteStore.register 是否调用 descriptors.validate ===
register(ctx, contribution) { … this.descriptors.validate(contribution.descriptors); … }
```

### 13.2 我上一版缺了什么

| # | 缺口 | 后果 |
| --- | --- | --- |
| 1 | 没有 `descriptor.id` | `validateNonempty("invocation id", id)` 直接抛 |
| 2 | 没有 `descriptor.service` | `validateSegment("invocation service key", service)` 直接抛 |
| 3 | `codec` 只有 `{mode:'strict'}`，没有 `typeSymbol` / `create` | `validateCodec` 对 strict 要求两者，会抛 |
| 4 | `cancellation` 写成 `{signal:'abort'}` | typert 要求 `cancellation.parameter === "signal"` |

我 §12.3 那轮 42/42 通过，是因为 `remote-mount.test.mjs` 里的假校验**只复刻了网关那道**，没复刻 typert 这道——
正是架构负责人提醒的「手抄规则抄错 → 测试自证」。已修。

### 13.3 两道的 codec 要求**互斥**，必须用「strict + 最小实现」

| 闸门 | 规则 | 冲突点 |
| --- | --- | --- |
| 网关 `requireStrictCodec` | 只认 `mode === "strict"` | 用 `src-json` 会被拒 |
| typert `validateCodec` | `src-json` 直接放行；`strict` 要求 `typeSymbol` 非空 + `create` 是函数 | 用 `src-json` 能过 typert，但**过不了网关** |

**结论**：架构负责人建议的 `src-json` **单独看是对的**（成本更低），但它过不了网关那道，
所以本项目实际采用 **`strict` + 最小 `typeSymbol` + 恒等 `create()`**，两头都过。
由于网关 client 全文无 `.encode(` 调用点，`create()` 不会被执行，给恒等函数是安全的。

### 13.4 修正后的 descriptor（已实现）

```js
{
  id: '@dsh-gamecenter/client#gameCenter.handshake',   // typert 要求，全局唯一
  service: 'dsh-gamecenter',                            // typert 要求
  namespace: 'gameCenter',
  method: 'handshake',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json',
                 codec: { mode: 'strict', typeSymbol: '@dsh-gamecenter/client#handshake.input', create() {} } }],
  result: { mode: 'strict', typeSymbol: '@dsh-gamecenter/client#handshake.result', create() {} },
}
// modelCatalog 另加 cancellation: { parameter: 'signal' }
```

### 13.5 本轮实测

| 命令（workdir = `packages/dsh-gamecenter-client`） | 退出码 | 结果 |
| --- | --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | 0 | `BUILD` |
| `node --test <7 个测试文件>` | 0 | **UNIT/MOCK 46/46 通过** |
| `node tools/build-bundle.mjs` | 0 | `built dist\client.js (25727 chars)` |

新增 4 项测试专门守这次漏掉的字段（缺 `id`、缺 `service`、strict 缺 `create()`、`cancellation.parameter` 不是 `signal`）。

### 13.6 真正的门禁在 Host 侧（已确认，非我能修）

架构负责人同时核实：Client 手写 contribution 只让方法**出现在 Client 上**；
Host 侧 `claimsEndpoint()` 只认 `ctx.typert.local` 里的严格定义，或 `collectSrcClaims()` 扫到的
`typertRemote.namespace` + `remoteMethods` 标记，否则 `resolveSrcDescriptor()` 抛
`gateway/invocation-unavailable`（多 Service 导出同一 endpoint 时是 `gateway/ambiguous-endpoint`）。

**这条已转给 DSH Host工程师**：Host 必须真的用 `@Remote` 声明并让 `typertRemote.namespace` 绑到
`gameCenter`，否则 Client 侧形状再对也调不通。

## 14. 【第三次修正】mock 多验了 `result.mode`；`src-json` 确认走不通

测试与发布负责人与 DSH Host工程师 各自独立核出我这边的两处问题，我逐条复核，**两条都成立**。

### 14.1 我的 mock 比真实更严（测试自证的第二处）

`dsh-api-gateway/lib/client.browser.js` @80241 `requireStrictInputs` 全文只查三处：

```js
function requireStrictInputs(descriptor) {
  const endpoint = endpointOf(descriptor);
  for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, endpoint, parameter.wire);
  if (descriptor.uplink !== void 0) requireStrictCodec(descriptor.uplink.codec, endpoint, "uplink");
  if (descriptor.invocation.kind === "context") requireStrictCodec(descriptor.invocation.codec, ...);
}
```

**它不校验 `result.mode`。** 我上一版 mock 和 `validateContributionShape()` 都多验了这条，
会让本地校验比真实更严 —— 真实能过的形状被我判成不合格，同样会误导。

已改：`gatewayValidate()` 删掉 result 判定；`validateContributionShape()` 把 result 交给
typert 的 `validateCodec` 管（接受 `strict` 或 `src-json`），不再由网关语义约束。

### 14.2 `src-json` 确认在本版本走不通（顺序决定结果）

Host 工程师点出关键：`mountContribution` 里 `validateContribution` **先于**
`typert.remotes.register` 执行。`validateCodec` 里 `if (codec.mode === "src-json") return;`
本身没错，但**走不到那里** —— 网关的 `requireStrictCodec` 已经先抛 `has no strict codec`。

已加测试 `src-json 在 gateway 层就被拒，走不到 registry（顺序决定结果）` 固定这条。

### 14.3 我的 descriptor 实际带了 `typeSymbol` / `create`（已逐条验证）

Host 工程师提醒的坑我没踩。实跑取值确认：

```text
handshake  id=true service=dsh-gamecenter resultMode=strict resultTypeSymbol=string resultCreate=function paramTypeSymbol=string
pause      id=true …（同上）
saveAck    id=true …（同上）
leaseStatus id=true …（同上）
modelCatalog id=true … paramTypeSymbol=n/a（无参数）
```

并新增测试 `参数 codec 只写 {mode:"strict"} 能过 gateway，但会在 registry 报 typeSymbol`
—— 把「gateway 只查 mode、registry 才查 typeSymbol/create」这两层的分工固定下来。

### 14.4 本轮实测

| 命令（workdir = `packages/dsh-gamecenter-client`） | 退出码 | 结果 |
| --- | --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | 0 | `BUILD` |
| `node --test <7 个测试文件>` | 0 | **UNIT/MOCK 51/51 通过** |
| `node tools/build-bundle.mjs` | 0 | `built dist\client.js (26078 chars)` |
| `node --test packages/dsh-gamecenter/test/codec-gate.test.mjs`（Host 的独立复刻） | 0 | 6/6 通过，与我结论一致 |

### 14.5 教训（累计三条，都是同一类错误）

1. 探针要锚到「文件 + 类 + 方法」三级，否则会抓到 bundle 里同名的另一个方法（§11）。
2. 手抄的 mock 规则必须逐条对照源码，抄得多（比真实严）和抄得少（比真实松）**都**会让测试自证（§13、§14.1）。
3. 校验的**先后顺序**是结论的一部分：两条规则单独看都对，顺序不同结果就相反（§14.2）。

## 15. 入口位置：放在「技能中心」相邻（用户要求）

用户要求：游戏中心入口放在现有「技能中心」附近，保留技能中心，不替换、不遮挡。

### 15.1 「技能中心」到底是谁（证据链，全部只读）

| # | 事实 | 证据位置 |
| --- | --- | --- |
| 1 | 「技能中心」**不是** DSH 官方包 | 扫遍 asar 内 97 个 client bundle，`sidebar.panellist` 里只有 plugin-manager 与 schedule 两项 |
| 2 | 它是 profile 里的第三方插件 `@linxin666/dsh-client-ui-skill-explorer` v0.4.6 | `<PROFILE_DIR>\package.json` 的 `dsh.profile.bundles` |
| 3 | 面板 id 与排序：`SKILL_EXPLORER_PANEL_ID = "skill-explorer"`、`PANEL_ORDER = 30` | 该包 `lib/client.js` |
| 4 | 它注册进 `sidebar.panellist`，locale `"entry.label": "技能中心"` | 同上 |
| 5 | 侧栏按 order 升序排列：`order: options.order ?? 0` → `.sort((a, b) => a.order - b.order)` | DSH `dsh-client-ui-sidebar/lib/client.js` `syncPanels()` |

> 我先前误判「sidebar.panellist 里只有插件管理和任务管理」，是因为只扫了 DSH 自身 asar；
> 技能中心在用户 profile 的第三方插件里。这条纠正已记入本节。

### 15.2 当前实际占位与本次改动

| order | 插件 | 面板 id |
| --- | --- | --- |
| 0 | `dsh-client-ui-plugin-manager` | （插件管理面板） |
| 10 | `dsh-client-ui-schedule` | （任务管理面板） |
| **30** | **`@linxin666/dsh-client-ui-skill-explorer`（技能中心）** | `skill-explorer` |
| **31** | **`@dsh-gamecenter/client`（游戏中心，本次）** | `gamecenter` |

改动只有一处：`src/index.js` 的 `order: 100 → 31`。仍然是 `sidebar.panellist` 的**独立一项**，
不替换、不遮挡技能中心，也不需要另放到别处。排序规则保证它紧邻技能中心之后。

### 15.3 本轮实测（同时给两个退出码，按测试负责人要求）

| 命令（workdir = `packages/dsh-gamecenter-client`） | 退出码 |
| --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | **0** |
| `node --test <7 个测试文件>` | **0**（51/51 通过） |
| `node tools/build-bundle.mjs` | **0**（`dist/client.js` 26077 chars） |

产物核验：`dist/client.js` 内确认为 `order: 31`。

### 15.4 快照（供独立验收绑定）

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| `src/index.js` | len=9374 mtime=23:25:13 sha256=B68BB5AF1903 | **len=10254 mtime=23:32:33 sha256=C7E259A4A9AF** |
| `src/bridge/remote-mount.js` | len=14499 mtime=23:29:14 sha256=16116B3BBF2D | 未改动 |
| `dist/client.js` | len=26768 mtime=23:30:41 sha256=8DA62767B730 | **len=26767 mtime=23:32:47 sha256=6518CD8E02B4** |

### 15.5 仍未验证

侧栏里这两项的真实渲染顺序、技能中心是否被遮挡，**必须装进 profile 并重启 GUI 才能看见**，
属 `DSH-REAL`，须用户批准。本节只证明「按排序规则应当相邻」，不证明「界面上确实相邻」。

### 15.6 新增只读探针

- `tools/probe-skill-entry.mjs`：在 asar 内按插件找 skill 相关插槽注册
- `tools/probe-ui-entries.mjs`：全量列出 `sidebar.panellist` / `main` / `shell.overlay` 等插槽的所有注册项（slot / id / order / label / 所属包）

## 16. `service` 字段：是命名不一致，**不是**阻断缺陷

DSH Host工程师 提示 Client descriptor 的 `service` 与 Host 侧服务键不同。我独立核实后确认：
**它不阻断调用**，但为消除歧义已改成与 Host 同名。

### 16.1 为什么不过 wire（三条独立证据）

| # | 事实 | 位置 |
| --- | --- | --- |
| 1 | 调用期 Host 用的是**自己 SRC 生成的** descriptor：`receiverContext.get(descriptor.service)` | `dsh-api-gateway/lib/index.js` `prepareInvocation` |
| 2 | 那个 descriptor 来自 `srcDescriptor()` 的 `service: binding.serviceKey`，即 Host 侧真实 Cordis 服务键 | 同上 `srcDescriptor()` |
| 3 | Client 上线只发 `connection.rpc.call("/api", endpoint, { args: prepared.args }, prepared.signal)` ——**`service` 不在 wire 载荷里** | `dsh-api-gateway/lib/client.browser.js` `invokeUnary` |

另有 typert `validateInvocation` 对 `service` 只查非空，不查它等于哪个真实服务键。

### 16.2 已做的改动（只是消除歧义）

`SERVICE_KEY` 由 `'dsh-gamecenter'` → `'gameCenter'`，与 Host 侧
`packages/dsh-gamecenter/src/dsh-adapter/protocol.ts` 的 `SERVICE_KEY = 'gameCenter'` 同名。
**改前改后都能挂载、都能调用**，这是可读性与对账正确性的改进，不是修 bug。

### 16.3 cancellation 判据已结案（Host 侧精确位置）

| 事实 | 位置 |
| --- | --- |
| `if (descriptor.cancellation !== void 0) args.push(signal);` | `dsh-api-gateway/lib/index.js` `prepareInvocation` |
| 配套 `const signal = methodSignal(...)` | 同上 |

→ `{parameter:'signal'}` 只要非空即触发注入。本项目 `modelCatalog` 填、其余四个不填，
与 Host 侧形参（`modelCatalog(signal: AbortSignal)`，其余四方法首参是 input）一致。
**测试负责人要的这条行号已拿到。**

### 16.4 本轮快照（双退出码）

| 命令 | 退出码 |
| --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | **0** |
| `node --test <7 个测试文件>` | **0**（51/51） |
| `node tools/build-bundle.mjs` | **0**（26073 chars） |

| 文件 | len | mtime | sha256(前12) |
| --- | --- | --- | --- |
| `src/index.js` | 10254 | 23:32:33 | `C7E259A4A9AF` |
| `src/bridge/remote-mount.js` | 15509 | 23:33:34 | `DEB75F43B00E` |
| `dist/client.js` | 26763 | 23:33:58 | `284FAB1A8AB0` |

## 17. 【第四次修正】mock 有三处抄得**过松**

测试与发布负责人逐行核对我手抄的三段校验，指出三处比真实**宽松**（前三次都是抄紧或抓错目标，
这次是抄松 —— 松比紧更危险：会让真实会失败的形状通过本地检查）。我逐条复核源码，**三条都成立**。

### 17.1 三处偏差（源码为准）

| # | 我上一版的写法 | 真实规则 | 后果 |
| --- | --- | --- | --- |
| 1 | `scope` 用 `.find()` 判断「存在任一 lookup」 | `scopedProjection()`：`lookupParameters.length === 1` 才选中，且 `selected.wire === scope.wire` 且 `selected.lookup === scope.context` | 两个 lookup / wire 不匹配 / context 不匹配，真实全拒、我全放行 |
| 2 | 只查「非空字符串」 | `validateWireName()`：`value === "." \|\| value === ".." \|\| !/^[A-Za-z0-9_$.-]+$/.test(value)` 即拒 | `有中文`、`a b`、`.`、`..`、`a/b` 真实拒、我放行 |
| 3 | `service` 只查非空 | `validateSegment()`：`length === 0 \|\| includes("#")` 即拒 | `a#b` 真实拒、我放行 |

### 17.2 已修（`src/` 与 `test/` 同步）

- `validateContributionShape()` 新增 `checkWireName()` / `checkSegment()`，`namespace`/`method`/`parameter.name`/`parameter.wire` 全部按字符集校验，`service` 按 `#` 校验。
- `test/remote-mount.test.mjs` 的 `typertValidateWireName()` / `typertValidateSegment()` 按源码逐字复刻。
- 新增 3 条守卫测试（对应上述三处），**并附一个反向对照**：`id` 含 `#` 是**合法**的，
  因为 `id` 只过 `validateNonempty`、不校验字符集。这条是测试负责人自己也一度误判过的点。

### 17.3 当前实现没有踩到这三处

我按新规则重跑当前 5 个 descriptor：`namespace`/`method`/`service` 全是代码常量，
且本项目不使用 `scope`，所以**违规为零**。这是「mock 不够严，但实现恰好没踩到」，
不是「实现本来就对」—— 守卫测试的价值在于防止以后改命名或加 `scope` 时被放过。

### 17.4 双退出码与快照（编辑已停）

| 命令（workdir = `packages/dsh-gamecenter-client`） | 退出码 |
| --- | --- |
| `npx -p typescript@5.7.3 tsc -p tsconfig.json` | **0** |
| `node --test <7 个测试文件>` | **0**（54/54） |
| `node tools/build-bundle.mjs` | **0**（26563 chars） |

| 文件 | len | mtime | sha256(前12) |
| --- | --- | --- | --- |
| `src/index.js` | 10254 | 23:32:33 | `C7E259A4A9AF`（本轮未改） |
| `src/bridge/remote-mount.js` | 16416 | 23:34:55 | `32A5582905D6` |
| `dist/client.js` | 27281 | 23:35:35 | `9CEAC9E0DEF3` |

### 17.5 第五次教训

手抄校验规则的四种失败形态我都踩过：抓错目标（§11）、抄漏字段（§13）、抄紧（§14.1）、**抄松（§17）**。
其中**抄松最危险**：它让本地检查比真实更宽松，真实会挂的形状在本地全绿。
以后凡属手抄，一律「逐行对着函数体抄，并给每条规则配一个会失败的负例」。

## 18. 最小无付费诊断区加固与独立 Staging 候选

为实现在 DSH 内真实观测 Remote 连通性，并解决实机运行中点击无响应与挂起风险，完成以下加固：
1. **异构错误形状适配**（`src/bridge/remote-mount.js`）：支持 Host 侧 `ok: false`（带 `errorCode`）与 `accepted: false`（带嵌套 `error.code`），杜绝旧代次拒绝被误判为成功；
2. **凭据安全与固定 `gameId`**（`src/bridge/diagnostics.js`）：探针使用固定 `DIAG_GAME_ID`（`__gamecenter_diag__`），凭据 `runtimeToken` 仅 Bridge 内存持有，严禁外泄至 UI、日志或 iframe；
3. **单项 RPC 3000ms 超时与 Abort 取消**：所有远程调用使用 `callWithTimeout`（3000ms），重测与组件卸载时立即触发 `abort()` 阻断后续步骤向 Host 发起写请求；
4. **组件级 15s 全局超时与全异常捕获**（`src/ui/RemoteDiagnostics.js`）：消除超时预算倒挂，全局 try...catch 捕获异常呈现于界面；
5. **独立 Staging 输出**：产物统一构建至 `staging/client.js`，绝不污染在线服务文件。

## 19. 用户授权单文件部署记录（2026-10-19 12:35）

用户于 2026-10-19 12:34:55 明确回复「授权更新并刷新」。作为唯一执行人完成 Client 单文件部署：

### 19.1 哈希校验与部署执行
1. **候选哈希核验（完全一致）**：
   - 路径：`packages/dsh-gamecenter-client/staging/client.js`
   - 大小：`54357` 字节
   - SHA256：`D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`
2. **在线旧产物核验与备份**：
   - 原始大小：`46457` 字节
   - 原始 SHA256：`6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`
   - 备份绝对路径：`packages/dsh-gamecenter-client/staging-rollback/dist-202610191235/client.js`
   - 备份 SHA256：`6559EA1CDEAE637A90B5484314E59D60B5CBCDDAE08E57F7E17B8F976FC18713`（校验 100% 吻合）
3. **单文件覆盖替换**：
   - 动作：`Copy-Item staging\client.js dist\client.js -Force`（PowerShell exit 0）
   - 替换后 `dist/client.js` SHA256：`D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`（与候选一致）

### 19.2 未改动范围声明
- `packages/dsh-gamecenter/lib/index.js`（`8A913821…`）分毫未动；
- 真实 profile `<PROFILE_DIR>\package.json`（`4AA2223B…`）分毫未动；
- 未调用任何付费模型，未重启 GUI 进程。

### 19.3 回滚办法
若需要回滚，执行：
`Copy-Item staging-rollback\dist-202610191235\client.js dist\client.js -Force`
即可瞬间精确还原到部署前状态。

## 20. 用户授权单文件部署记录（2026-10-19 13:25 修复 Cordis 注入）

用户于 2026-10-19 13:22 明确回复「授权更新并刷新」。作为唯一执行人完成 Client 单文件部署（彻底修复 `cannot get property "remote.gameCenter" without inject`）：

### 20.1 哈希核验与部署执行
1. **候选哈希核验（完全一致）**：
   - 路径：`packages/dsh-gamecenter-client/staging/client.js`
   - 大小：`54484` 字节
   - SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`
2. **在线旧产物核验与持久备份**：
   - 原始大小：`54357` 字节
   - 原始 SHA256：`D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`
   - 持久备份绝对路径：`packages/dsh-gamecenter-client/staging-rollback/dist-202610191325/client.js`
   - 备份 SHA256：`D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`（100% 完全匹配）
3. **单文件覆盖替换**：
   - 动作：`Copy-Item staging\client.js dist\client.js -Force`（PowerShell exit 0）
   - 替换后 `dist/client.js` SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`（与候选一致）

### 20.2 未改动范围声明
- `packages/dsh-gamecenter/lib/index.js`（`8A913821…`）分毫未动；
- 真实 profile `<PROFILE_DIR>\package.json`（`4AA2223B…`）分毫未动；
- 未调用任何付费模型，未擅自刷新界面或重启 GUI 进程。

### 20.3 回滚办法
若需要回滚，执行：
`Copy-Item staging-rollback\dist-202610191325\client.js dist\client.js -Force`
即可瞬间还原到部署前状态。

## 21. 用户授权单文件部署记录（2026-10-19 16:33 部署 427 修复解包与假阳性版本）

用户于 2026-10-19 16:32 明确回复「授权部署427版本并刷新」。作为唯一执行人完成 Client 单文件部署（彻底解包 Gateway `{ok:true, value}` 信封并消除一切假阳性兜底）：

### 21.1 哈希核验与部署执行
1. **候选哈希核验（完全一致）**：
   - 路径：`packages/dsh-gamecenter-client/staging/client.js`
   - 大小：`56263` 字节
   - SHA256：`427F79EA2F7CC06C1ED74BAEA665FA0EC41075746846DF6F8DAE9BCDBDE13110`
2. **在线旧产物核验与持久备份**：
   - 原始大小：`54484` 字节
   - 原始 SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`
   - 持久备份绝对路径：`packages/dsh-gamecenter-client/staging-rollback/dist-202610191633/client.js`
   - 备份 SHA256：`1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`（100% 完全匹配）
3. **单文件覆盖替换**：
   - 动作：`Copy-Item staging\client.js dist\client.js -Force`（PowerShell exit 0）
   - 替换后 `dist/client.js` SHA256：`427F79EA2F7CC06C1ED74BAEA665FA0EC41075746846DF6F8DAE9BCDBDE13110`（与候选一致）

### 21.2 未改动范围声明
- `packages/dsh-gamecenter/lib/index.js`（`93F30A7B…`）分毫未动；
- 真实 profile `<PROFILE_DIR>\package.json`（`4AA2223B…`）分毫未动；
- 未调用任何付费模型，未擅自刷新界面或重启 GUI 进程。

### 21.3 回滚办法
若需要回滚，执行：
`Copy-Item staging-rollback\dist-202610191633\client.js dist\client.js -Force`
即可瞬间精确还原到 1BE7 版本。



