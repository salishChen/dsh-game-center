# 阶段0 构建链事实与插件入口契约（架构与协议负责人）

更新时间：2026-10-18。本文只记录**本会话实际执行的命令与退出码**。
对象：全部六条研发线。凡本文未列出的命令，不视为“已验证可执行”。

> 脱敏约定（2026-10-19）：文中 `<DSH_INSTALL>` 等为路径占位符，**不是可直接执行的路径**；示例代码中的安装路径已替换，执行前请用自己的安装目录。

## 1. 结论先行

1. 本会话 **pwsh 可用**（文件策略已为 `danger-full-access`）。此前全组报告的 `0xC0000142` 属于**会话级**现象，不是项目缺陷，也不是全员共通的 DSH 缺陷。
2. 真实阻塞不是 shell，而是 **`Start-Process` / `System.Diagnostics.Process` 级子进程创建失败**：`Start-Process` 直接报
   `已添加项。字典中的关键字:“NO_PROXY”所添加的关键字:“no_proxy”`（ArgumentException）。
3. **已证实可用的执行通道**：`cmd /c "<命令>"`，以及由它启动的 `node`、`npx`、子 `powershell.exe`。退出码能正确传播。
4. 因此**编译与单测不是阻塞**；阻塞点收窄为“无法以独立进程直接启动 shell”。

## 2. 已执行命令与退出码

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `node -v; pnpm -v; npm -v; git --version` | 0 | node v24.19.0 / pnpm 11.21.0 / npm 11.17.0 / git 2.55.0.3 |
| 2 | `cmd /c "echo started-ok"` | 0 | 输出 `started-ok` |
| 3 | `cmd /c "node -v"` | 0 | `v24.19.0` |
| 4 | `cmd /c "node -e \"require('fs');console.log('inline-ok')\""` | 0 | `inline-ok` |
| 5 | `cmd /c "echo ... & exit /b 3"` | 3（`$LASTEXITCODE`=3） | 退出码正确传播，可作验收证据 |
| 6 | `& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "node -v"` | 0 | `v24.19.0` + `child-pwsh-ok` |
| 7 | `Start-Process cmd.exe ...` | 失败 | ArgumentException：`NO_PROXY` / `no_proxy` 字典键冲突 |
| 8 | `npx -y -p typescript@5.7.3 tsc -p packages/protocol/tsconfig.json` | 0 | protocol 包编译通过（BUILD） |
| 9 | `node --test packages/protocol/test/contract.test.mjs` | 0 | 10/10 通过（UNIT） |
| 10 | `npx -y -p tsx@4.20.6 tsx --version` | 0 | `tsx v4.20.6`，可作 TS 直接运行通道 |
| 11 | `npx -y -p esbuild@0.28.2 esbuild --version` | 0 | `0.28.2`，可作 Client 浏览器端打包通道 |

### 2.1 环境根因（附带证据）

`[Environment]::GetEnvironmentVariables().Keys` 按大小写归并后统计，存在**重复键**：

```
NO_PROXY   2
HTTPS_PROXY 2
HTTP_PROXY  2
```

即同一变量的两种大小写形态同时存在。.NET 在构造不区分大小写的字典时抛 `ArgumentException`，
于是依赖 `ProcessStartInfo.Environment` 的 `Start-Process`、以及以 `-NoProfile` 独立方式启 shell 的路径全部失败。
这是**会话环境问题**，处置建议：由持有会话设置的成员统一环境变量大小写，或在会话启动时去重。
**任何成员都不得为此修改系统注册表/用户环境变量而绕过沙箱**，本条只作诊断记录。

## 3. 对六条线的直接可用结论

- **编译/测试**：`cmd /c "npx -y -p typescript@<ver> tsc ..."` 与 `node --test` 均可跑；`tsx` 可直接执行 `.ts` 探针；`esbuild` 可打浏览器端产物。
- **禁止**：把“`Start-Process` 失败”写成“项目无法构建”，也**禁止**把“命令能跑”写成“DSH 集成通过”。
- 证据分栏不变：上述全部属于 `BUILD` / `UNIT`，**不是** `DSH-REAL`。

## 4. 版本口径统一（三种版本号，勿混用）

| 项 | 来源 | 值 |
| --- | --- | --- |
| 桌面发行版版本 | `resources/runtime/primary-runtime/runtime.json` | `0.2.1-rc.2` |
| 桌面宿主包含的 dsh 主包 | `app.asar` 根 `package.json`（node 直读） | `@deepseek-ai/dsh-desktop` `0.2.1-rc.2` |
| 构建提交（兼容承诺唯一锚点） | 同上 `dshBuildCommit` | `332895e0f7c9d4dbfb29729f5eb367fa263ff986`，`dirty=false` |
| 运行时清单记录的工具链 | `runtime.json` | node 24.21.0 / pnpm 11.28.5 / python 3.12.14（**清单记录，非本会话实测**） |
| 本会话实测工具链 | 命令 1 | node v24.19.0 / pnpm 11.21.0（**与清单不同，勿互相引用**） |
| 设计基线引用提交 | 基线 §1 | `687f282e8625c6b8d11ff58211a90524be2e4317`（GitHub API 核对：该提交 message 为 `release: next version dsh@0.2.1-rc.2`） |

**契约口径**：阶段0 证据只锚定 `332895e0…`；`687f282e…` 只作为设计依据；两者差异清单仍未产出。

## 5. asar 读取方法（Host / Client 工程师可直接用）

`app.asar\dsh\` 作为目录不可遍历，但 asar 是“16 字节头 + JSON 目录表 + 数据段”的简单格式，用 node `fs` 即可只读取出任意文件字节：

```js
const fs = require('fs')
const f = '<DSH_INSTALL>\\resources\\app.asar'   // 占位符，非可直接执行路径
const fd = fs.openSync(f, 'r')
const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0)
const headerSize = b.readUInt32LE(12)               // JSON 目录表字节数
const h = Buffer.alloc(headerSize); fs.readSync(fd, h, 0, headerSize, 16)
const root = JSON.parse(h.toString('utf8').replace(/\0+$/, ''))
const read = (entry) => {                            // entry = root.files[...]
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, 16 + headerSize + Number(entry.offset))
  return buf.toString('utf8')
}
// 例：root.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-api-remotes']
```

已用它确认：`app.asar` 内 `dsh/node_modules/@deepseek-ai` 有 **306** 个包，含 `dsh-api-remotes`、`dsh-api-gateway`、`dsh-client-ui-slots`、`dsh-client-ui-layout`、`dsh-client-ui-primitives`、`dsh-llm`、`dsh-web-app`。
**这只证明包存在于归档，不证明任一扩展点在运行时可用。**

## 6. 包配置契约（我唯一维护根工程）

已落地：

- `/package.json`：私有工作区根，`packageManager: pnpm@11.21.0`，`engines.node >= 20`。
- `/pnpm-workspace.yaml`：`packages/*`。
- `/tsconfig.base.json`：ES2022 + NodeNext + `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`。
- `/packages/protocol/**`：`@dsh-gamecenter/protocol`，零运行时依赖，`src` 与 `schemas` 为唯一契约来源。

各包 `package.json` / `tsconfig.json` 的**新建请求**请在群里报出下列四项，我统一落盘，避免各写一套：

```text
1) 包名（建议 @dsh-gamecenter/<host|client|sdk|capability-image|publisher>）
2) 运行形态（host 插件 / client 浏览器插件 / 库 / 脚本）与 DSH 版本范围（默认 engines: @deepseek-ai/dsh >=0.2.0-rc.2）
3) 需要的外部依赖（含 @deepseek-ai/* 具体包名与版本），是否允许 peerDependencies
4) 是否需要构建产物（tsc / esbuild），以及 dist 的入口文件名
```

**当前允许直接开工的包**（我可以立刻落盘配置）：`dsh-gamecenter`（Host 探针）、`dsh-gamecenter-client`（Client 探针）。
两者都只依赖 `@dsh-gamecenter/protocol` + 各自 `@deepseek-ai/*` peer 依赖，不引入其他内部包。

## 7. 插件入口字段：等源码，不猜

- Host 插件入口字段（`dsh.bundle.patch`、`dsh.client`、`dsh.engines` 等）参考的是**第三方插件**（`@linxin666/*`、`ds-bot`）已发布的 `package.json`，属于 `STATIC` 依据，**不是**官方文档结论。
- Client 端要验证“不写装配是否真的不出现”，这是负例证据，必须来自**真实 DSH 运行**，无法用静态阅读替代。
- 因此：Host/Client 探针代码可以写，但**不得**在未观察前写“已接入”。
- 建议双方共用 §5 的方法取 `dsh-web-app` / `dsh-api-remotes` / `dsh-client-ui-slots` 入口源码，谁取谁签名，避免重复读同一份归档。

## 8. 仍需项目经理/用户决定

1. 会话环境变量重复键是否由持有会话设置的一方统一修复（当前已绕过，不影响构建与测试）。
2. 项目根 `git init` + 首次提交是否授权——它是本项目唯一的版本锚点。
3. 真实模型 `ctx.llm.stream` 调用属付费，需用户单独授权，我这边**未调用**。
