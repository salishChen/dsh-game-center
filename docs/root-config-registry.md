# 根配置与构建工具链登记（架构与协议负责人唯一维护）

更新时间：2026-10-18。本文件登记根工程配置、devDependency 与实测退出码。
任何成员不得自行修改根 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `tsconfig.base.json`；需要新依赖请在群里报出包名、精确版本、用途与是否 devDependency。

## 1. 已安装的根 devDependencies（固定精确版本）

| 包 | 版本 | 用途 | 安装方式 |
| --- | --- | --- | --- |
| `esbuild` | `0.28.2` | Client 浏览器端单文件打包（`packages/dsh-gamecenter-client/tools/build-bundle.mjs`） | `pnpm add -D -w esbuild@0.28.2 --ignore-scripts` |
| `typescript` | `5.7.3` | 三个包的 `typecheck` / 协议包编译 | `pnpm add -D -w typescript@5.7.3 --ignore-scripts` |

安装策略核查结论：

- registry = `https://registry.npmmirror.com`（来自用户 npm 全局配置，**未修改**）。
- `npm config get ignore-scripts` = `false`，因此安装时显式追加 `--ignore-scripts`，**不放行任何包安装脚本**。
- 未做全局安装、未改 registry / 代理 / 系统配置、未改用户 profile。
- 安装输出含 `✓ Lockfile passes supply-chain policies`。
- `pnpm` 11.21.0 提示可升级到 12.14.0，**未升级**。

## 2. 实测命令与退出码

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm add -D -w esbuild@0.28.2 --ignore-scripts` | 0 | `+ esbuild 0.28.2`，lockfile 更新 |
| 2 | `pnpm add -D -w typescript@5.7.3 --ignore-scripts` | 0 | `+ typescript 5.7.3` |
| 3 | `node -e "import('esbuild')…"`（项目根解析） | 0 | `esbuild-version=0.28.2`，解析到 `node_modules/.pnpm/esbuild@0.28.2/…` |
| 4 | `node tools/build-bundle.mjs`（Client 包内） | 0 | `built dist\client.js (18343 chars)`，产物 18765 字节 |
| 5 | `node --test test/bundle-shape.test.mjs`（Client） | 0 | 3/3 通过：产物满足 DSH 模块系统结构契约、外部依赖保留为 `require`、过渡期壳被测试守住 |
| 6 | `pnpm -C packages/protocol exec tsc -p tsconfig.json --noEmit` | 0 | 协议包类型检查通过 |
| 7 | `pnpm -C packages/dsh-gamecenter-client exec tsc -p tsconfig.json --noEmit` | 0 | Client 类型检查通过 |
| 8 | `pnpm -C packages/dsh-gamecenter exec tsc -p tsconfig.json --noEmit` | **2**（首次） | 首次观测失败：`src/index.ts(27,57): error TS2307: Cannot find module './remote/game-center-service.ts'`。**已于同日晚些时候复跑为 0**，见 §2.1 |
| 9 | `node --test packages/protocol/test/contract.test.mjs` | 0 | 10/10 通过 |
| 10 | `node --test packages/dsh-gamecenter-client/test/*.test.mjs` | 0 | 32/32 通过 |

**以上全部属于 `BUILD` / `UNIT`，没有一项是 `DSH-REAL`。**

### 2.1 撤回：第 8 条 TS2307 是文件时序，不是缺文件

Host 工程师重建 `packages/dsh-gamecenter/src/remote/game-center-service.ts`（PowerShell `-Raw` 破坏编码后重建）期间存在约一分钟窗口，我的 tsc 恰好落在窗口内。
复跑结果（2026-10-18 晚间，三条命令均 `exit 0`）：

| 包 | tsc | 单测 |
| --- | --- | --- |
| protocol | 0 | 10/10，exit 0 |
| dsh-gamecenter-client | 0 | 32/32，exit 0 |
| dsh-gamecenter | 0 | 37/37，exit 0 |

`packages/dsh-gamecenter-client/dist/client.js` 当前存在（构建产物）。
**教训**：跨包并行开发期间，类型检查失败必须先核对文件 `LastWriteTime` 与对方写入窗口，再判定为缺文件/缺陷。

## 3. 交给界面与运行时工程师的结论

- esbuild 已可从 `packages/dsh-gamecenter-client` 解析（`pnpm -C packages/dsh-gamecenter-client exec node tools/build-bundle.mjs` 或直接 `node tools/build-bundle.mjs` 均可）。
- 你的 `devDependencies: {"esbuild": "0.28.2"}` 保留在包内无害（pnpm 会复用同一份 store 实例）；根上已有同版本，不会产生双份二进制。
- `dist/client.js` 已产出并被 `bundle-shape.test.mjs` 断言；请把它标为**已构建产物**，而 `lib/client.js` 仍是过渡期壳，不能拿去当生产入口。
- `dist/` 在本仓库被 `.gitignore` 忽略；如果阶段0 需要用产物做 DSH 装配，需要决定是临时取消忽略还是通过安装步骤生成——这条由你与 Host 工程师商定后告诉我，我改 `.gitignore`。

## 4. 交给 DSH Host 工程师的阻塞（已撤回首条，保留依赖语义两条结论）

~~`packages/dsh-gamecenter` 的 `tsc` 退出码 2，缺文件 `src/remote/game-center-service.ts`。~~
**撤回**：是并行写入窗口造成的假象，复跑 `exit 0`，见 §2.1。我不会改你的包内文件。

以下两条是**依赖语义**结论，与缺陷无关，仍然成立：

1. **`peerDependencies` 与 registry 事实**
   - `@deepseek-ai/cordis` → registry 上**存在**（`npm view` = 4.0.5）。
   - `@deepseek-ai/dsh-typert-protocol` → registry 上**存在**（已发布 `0.2.1-rc.2`）。
   - 但两者在本项目 `node_modules` 中**都解析不到**（`MODULE_NOT_FOUND`），因为本项目没有安装它们。
   - 结论（**修正我先前的措辞**）：这两个包并没有被下架，`@deepseek-ai/*` 也**不是**“只随发行版提供、registry 上没有”。Host 工程师在 23:20 前后已完成 peer 声明调整，当前取值请以其包内 `package.json` 为准。
   - 仍然成立的部分：`peerDependenciesMeta.optional: true` 只表示“不装不报错”，**不等于**“运行时可解析”；不能把 peer 声明当成装配已通过的证据。

2. **`engines.dsh` 的真实语义**
   - `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }` 只是给 DSH 插件管理器看的声明字段；
   - 它**不解析**任何 `@deepseek-ai/*` 运行时依赖，也**不保证**这些模块在宿主里能 `import` 成功（宿主提供 vs 本包解析是两回事）。
   - 因此 Client 侧移除 `@deepseek-ai/cordis` peer 的做法在“避免 pnpm 去公共 registry 解析”这一目标是成立的，但**不能**据此声称“运行时依赖问题已解决”。

## 5. 协议包产物边界（2026-10-19 变更，已生效）

**决定**：`@dsh-gamecenter/protocol` 从「只导出 TS 源码」改为「可重复构建的 ESM dist + 类型声明」。这是 PM 交办的依赖边界修复，也是 Host 侧类型漂移的根因。

### 5.1 变更内容

| 文件 | 变更 |
| --- | --- |
| `packages/protocol/tsconfig.build.json` | **新增**：`extends ./tsconfig.json`，`noEmit:false`、`declaration:true`、`rootDir:src`、`outDir:dist` |
| `packages/protocol/package.json` | `main`/`types`/`exports["."]` 改为指向 `./dist/index.js` 与 `./dist/index.d.ts`；新增 `build` 脚本；`test` 改为先 `tsc -p tsconfig.build.json` 再跑单测；`files` 增加 `dist` |
| `package.json`（根） | `build`/`typecheck`/`test` 都改为**串行**：先 `--filter @dsh-gamecenter/protocol`，再 `--filter=!@dsh-gamecenter/protocol` |
| `packages/protocol/dist/` | **整体删除后重建**（此前是 `emitDeclarationOnly` 残留，`.js` 缺失且 mtime 混杂），现为干净的 JS + d.ts + map |

保留不变：`"./schemas/*"` 仍直接映射到 `schemas/` 目录；`"./package.json"` 保留；零运行时依赖不变。

### 5.2 实测证据（workdir 均为仓库根，除非注明）

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm -C packages/protocol exec tsc -p tsconfig.build.json` | 0 | 清空 dist 后重建：10 个 `.js` + 10 个 `.d.ts` |
| 2 | `pnpm -C packages/protocol test` | 0 | 10/10 通过 |
| 3 | `pnpm -C packages/protocol run typecheck` | 0 | 通过 |
| 4 | `pnpm install --ignore-scripts --offline` | 0 | 补齐工作区软链：`packages/*/node_modules/@dsh-gamecenter/protocol → ../../protocol` |
| 5 | 从 `packages/dsh-gamecenter` 解析 `@dsh-gamecenter/protocol` | 0 | 解析到 `packages/protocol/dist/index.js`（不再是 src） |
| 6 | 从 `packages/dsh-gamecenter` 运行时 `import('@dsh-gamecenter/protocol')` | 0 | `exports: 36`、`errorCodes: 13`、`buildCommit` 前 8 位 `332895e0` |
| 7 | 解析 `@dsh-gamecenter/protocol/schemas/manifest.v1.json` | 0 | 指向 `packages/protocol/schemas/manifest.v1.json` |
| 8 | 根 `pnpm run typecheck`（protocol 先行） | 0 | host + client 均 Done |
| 9 | 根 `pnpm run test`（protocol build 先行） | 0 | host 61/61、client 57/57，protocol 10/10 |

**注意**：第 5–7 条必须从**下游包目录**执行才有效。在仓库根直接 `node -e "import('@dsh-gamecenter/protocol')"` 会 `ERR_MODULE_NOT_FOUND`，因为根 `package.json` 没有依赖该包，根 `node_modules` 下也没有它的软链。这不是缺陷，是 pnpm 工作区的正常隔离。

### 5.3 给 Host 工程师的解锁（可直接执行，不需再问我）

1. 删除 `packages/dsh-gamecenter/tsconfig.json` 里的 `paths` 映射 `"@dsh-gamecenter/protocol": ["../protocol/src/index.ts"]`——它已无必要，且会绕开 dist。
2. 移除 `src/**` 内的内联类型子集（`LeaseErrorCode`、`Catalog*` 系列等），恢复 `import type { ... } from '@dsh-gamecenter/protocol'`。
3. 若加编译期一致性断言，用**真正会失败**的形式，不要用 `type X = A extends B ? true : never`（never 不报错）：

```ts
type Assert<T extends true> = T
// 对外投影必须与权威协议完整一致：多一个少一个字段都会在这里编译失败
type _LeaseProjectionMatchesProtocol = Assert<
  LeaseRecord['state'] extends RuntimeLease['state'] ? true : false
>
```

   更严格的做法是把**投影函数**的返回类型直接标注为 `Pick<RuntimeLease, ...>`，让 tsc 在赋值处报错，而不是靠断言。
4. **内部记录多字段不等于漂移**（PM 已明确）：`LeaseRecord` 可以持有 `lastPersistedRevision`、`tokenDigest` 等内部状态；判定标准是**对外投影**是否覆盖且不超过 `RuntimeLease` 的字段语义。给测试负责人的验收口径也应按投影比对，而不是按结构全等比对。

### 5.4 给 Client 工程师的影响

- Client 包 `dependencies` 里若引用了 protocol，现在解析到 `dist`，`tsc -p tsconfig.json`（`allowJs`/`checkJs`/`emitDeclarationOnly`）照常通过，实测 exit 0。
- Client 的 `dist/client.js` 由 esbuild 打包时，protocol 现在有真实 `.js` 产物，**不会再被内联失败**；若希望它保持外部依赖，请在 `STATIC_EXTERNALS` 里确认是否需要加入 `@dsh-gamecenter/protocol`。这条我没动，由你决定。
- 改动后 Client 全套 **57/57 通过**，退出码 0。

### 5.5 仍需注意

- `build/**` 未纳入 `.gitignore` 变更范围：`dist/` 本来就被忽略，因此 protocol 的 `dist` 也不会进版本库。**任何人 clone 后必须先 `pnpm run build`**，否则下游编译失败。这是当前取舍，若要改成提交产物请告知我。

## 6. 仍待决定（项目经理 / 用户）

1. 项目根 `git init` + 首次提交：目前仍无版本锚点。
2. `.gitignore` 是否放开 `dist/`（影响能否把构建产物纳入版本与装配）。
3. `@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol` 是否要作为**根 devDependency** 安装，以便在宿主之外做类型检查与单测。这会引入官方包到本项目依赖树，需要你明确批准——我未擅自安装。
