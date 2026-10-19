# 加载试验执行日志（DSH Host工程师）

本文件是**执行记录**，不是设计方案。设计依据见 `docs/phase0-host.md` §12。
授权范围：项目经理按用户 2026-10-19 07:24「继续」批准的本机加载试验——
**备份 profile、建立 host/client 两个 junction、追加唯一 Host bundle、正常退出重启 GUI 一次、失败回滚**。
**不含**：付费调用、DSH 安装目录变更、替代 web 服务、其他配置变更。

> 本日志在每个破坏性步骤**之前**写入，避免会话中断后无法回滚。

> 脱敏约定（2026-10-19）：文中 `<REPO>`、`<PROFILE_DIR>`、`<USER_HOME>`、`<DSH_INSTALL>` 为路径占位符，**不是可直接执行的路径**；原文中的本机绝对路径已按此替换，所有摘要值仍取自脱敏前的原始样本，未重算。

## 0. 执行前基线核对（2026-10-19 07:2x，隔约 6 小时后重验，未沿用旧值）

### 0.1 六产物摘要（QA BIND-C）——全部 MATCH

| 文件 | SHA256（前 16） | 结果 |
| --- | --- | --- |
| `packages/dsh-gamecenter/cordis.patch.yml` | `9033468FBCBEDDE1` | MATCH |
| `packages/dsh-gamecenter/lib/index.js` | `36A01FBBEB4DA75A` | MATCH |
| `packages/dsh-gamecenter-client/dist/client.js` | `9CEAC9E0DEF38DBF` | MATCH |
| `packages/dsh-gamecenter-client/lib/index.js` | `B551CE10B9378E05` | MATCH |
| `packages/dsh-gamecenter-client/lib/index.d.ts` | `547D3803A5B757F3` | MATCH |
| `packages/protocol/dist/index.js` | `E4C11E5B20F1740F` | MATCH |

### 0.2 冻结后无写入（BIND-A/B 的等价证明）

- `packages/**`（排除 `node_modules`）自冻结时间 `2026-10-19 01:36:51` 之后**无任何写入**。
- 5 个根配置（`.gitignore`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json`）同期间**无写入**。
- `packages/**` 文件数 = **180**，与 QA BIND-A 声明的 180 一致。

> 说明：我未复现 QA 的摘要算法（文件排序与分隔符细节属其实现），
> 因此用「冻结后零写入 + 文件数一致」作为等价证明，并**如实标注这是等价证明而非同一算法复算**。

### 0.3 构建确定性

`pnpm run build` **exit 0**；构建后上述六产物摘要**全部保持 MATCH**（重建不改内容）。

### 0.4 目标 profile 基线（改动前）

| 项目 | 值 |
| --- | --- |
| profile 目录 | `<PROFILE_DIR>` |
| `package.json` SHA256 | `788BDECBC37172580EA09276E60FBC89532E880B2ACC17E9A1BD079F38FE0B01` |
| `cordis.patch.yml` SHA256 | `F7411138A112DFA4612D2ECBF33112C669D6A68AA6CF195FE8A15A491B003432` |
| `node_modules\@dsh-gamecenter` 是否存在 | **否** |
| `dsh.profile.bundles` 条数 | **15**（末条 `@deepseek-ai/dsh-experimental-session-search`） |
| 是否已含 `@dsh-gamecenter/host` | **否** |

**既有备份（不得覆盖）**：`cordis.patch.yml.bak-final`(4571B)、`.bak-lanbind`(4540B)、`.bak2`(4232B)。

## 1. 将执行的步骤与回滚

### 步骤 A：备份（不覆盖既有 `.bak*`）

```text
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json"     "$p\package.json.bak-gamecenter-2026101907"
Copy-Item "$p\cordis.patch.yml" "$p\cordis.patch.yml.bak-gamecenter-2026101907"
```

备份后记录两文件的**绝对路径与 SHA256**（见下方「实际执行记录」）。
`cordis.patch.yml` **仅备份、不改动**。

### 步骤 B：建立两个 junction（新建目录，不动已有 ~400 条目）

```text
New-Item -ItemType Directory -Force -Path "$p\node_modules\@dsh-gamecenter" | Out-Null
New-Item -ItemType Junction -Path "$p\node_modules\@dsh-gamecenter\host"   -Target "<REPO>\packages\dsh-gamecenter"
New-Item -ItemType Junction -Path "$p\node_modules\@dsh-gamecenter\client" -Target "<REPO>\packages\dsh-gamecenter-client"
```

### 步骤 C：最小编辑 `package.json`，仅在 `dsh.profile.bundles` **追加一行**

```diff
       "@deepseek-ai/dsh-experimental-session-search",
+      "@dsh-gamecenter/host"
     ]
```

其余 15 条与全部 `dependencies` **不动**。

### 步骤 D：正常退出并重启 GUI 一次（**不由我执行，见 §2**）

### 回滚（任意失败时）

```text
Remove-Item "$p\node_modules\@dsh-gamecenter\host"   -Force   # junction，只删链接本身
Remove-Item "$p\node_modules\@dsh-gamecenter\client" -Force
Remove-Item "$p\node_modules\@dsh-gamecenter"        -Force   # 仅当为空
Copy-Item "$p\package.json.bak-gamecenter-2026101907" "$p\package.json" -Force
```

**只移除我新建的那两个 junction，绝不递归其目标目录**（目标在仓库内，删目标会毁掉源码）。
回滚后重启 GUI 即回原状。存档与游戏数据不受影响（本阶段尚无存档）。

## 2. 为什么重启不由我执行

本会话运行在**被重启的那个 DSH 应用内部**（GUI `http://127.0.0.1:3080`）。
一旦退出该应用，本会话即终止，**我无法在应用关闭后继续执行回滚或观察日志**。
按项目经理要求「若无法可靠安排本应用关闭后的重启/回滚……先完成非中断步骤并明确请求用户手动重启」，
因此：**A/B/C 三步由我执行；重启由用户手动完成。**

**重启方式**：正常退出（菜单退出，**不要强杀进程**），再重新启动 DeepSeek Harness。
改动的解析在下次启动才生效，所以不重启不会产生任何影响。

## 3. 重启后的观察点（由测试与发布负责人取证）

1. **stderr**：不应出现 `skipping profile bundle "@dsh-gamecenter/host"`。出现即失败。
2. 插件清单 `pluginInventory.list()`：应含 `@dsh-gamecenter/host`，`fiberPhase === 'active'`。
3. `ctx.get('gameCenter')` 存在，`typertRemote.namespace === 'gameCenter'`。
4. `ctx.typertGateway.claimsEndpoint('gameCenter/handshake')` 为 `true`。
5. 侧栏出现「游戏中心」，位于「技能中心」（order 30）之后（我方 order 31）。
6. console **不应**出现 `gameCenter: Remote 挂载失败 —— <code>: <message>`。
7. **只读模型目录，绝不点击任何会调用模型的按钮**（不得调用 `stream`）。

## 4. 实际执行记录（2026-10-19 07:24–07:3x）

### A. 备份 —— 已完成

| # | 绝对路径 | SHA256 | 大小 |
| --- | --- | --- | --- |
| A1 | `<PROFILE_DIR>\package.json.bak-gamecenter-2026101907` | `788BDECBC37172580EA09276E60FBC89532E880B2ACC17E9A1BD079F38FE0B01` | 1007 |
| A2 | `<PROFILE_DIR>\cordis.patch.yml.bak-gamecenter-2026101907` | `F7411138A112DFA4612D2ECBF33112C669D6A68AA6CF195FE8A15A491B003432` | 4572 |

- 两个备份与源文件哈希**逐一比对相等**（True / True）。
- 既有 3 个备份**未被覆盖**：`cordis.patch.yml.bak-final`(4571B)、`.bak-lanbind`(4540B)、`.bak2`(4232B)。

### B. 两个 junction —— 已完成

| 链接 | 类型 | 目标 | 校验 |
| --- | --- | --- | --- |
| `<profile>\node_modules\@dsh-gamecenter\host` | **Junction** | `<REPO>\packages\dsh-gamecenter` | 目标含 `package.json`，`name=@dsh-gamecenter/host` |
| `<profile>\node_modules\@dsh-gamecenter\client` | **Junction** | `<REPO>\packages\dsh-gamecenter-client` | 目标含 `package.json`，`name=@dsh-gamecenter/client` |

`@dsh-gamecenter` 目录为**新建**，未触碰既有 ~400 条目。

**Node 从 profile 解析实测**（`createRequire('<profile>/package.json')`）：

```text
@dsh-gamecenter/host   -> ...\packages\dsh-gamecenter\lib\index.js
@dsh-gamecenter/client -> ...\packages\dsh-gamecenter-client\lib\index.js
```

→ 执行前「profile 无法解析裸包名」已**转为可解析**，与 §12.4 的沙盒推演一致。

### C. `package.json` 最小编辑 —— 已完成

**逐行差异**（`Compare-Object`，`<` 备份 / `>` 现在）：

```text
>         "@deepseek-ai/dsh-experimental-session-search",
>         "@dsh-gamecenter/host"
<         "@deepseek-ai/dsh-experimental-session-search"
```

仅此一处：上一行加逗号 + 新增一行。其余 15 条 bundle 与全部 `dependencies` 未动。

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| 字节数 | 1007 | 1039（+32，恰为新增行 `(8空格)"@dsh-gamecenter/host"` 30 + 逗号 1 + 换行 1） |
| bundles | 15 | **16** |
| SHA256 | `788BDECB…B01` | `4AA2223BFC0E4C50A0C809D743CC068AE112E61860CFC5B4D9158B06FDBAFA39` |
| 换行 / BOM | LF / 无 | LF / 无（保持不变） |

`cordis.patch.yml` **仅备份、未改动**：SHA256 仍为 `F7411138…3432`。

### D. 改后状态复核（9 项全通过，exit 0）

bundles 含 host（16 条）、两个 junction 可解析、Node 可解析两个包名、
`cordis.patch.yml` 未改、备份存在且等于改前、既有 `bak-final` 未被覆盖。

### E. 仓库绑定完整性（执行后复核）

| 绑定 | 结果 |
| --- | --- |
| BIND-C 六产物摘要 | **全部 MATCH**（构建前后一致，证明构建确定性） |
| BIND-A `packages/**` | 文件数仍 **180**，与绑定一致；`src/**`、`tools/**` 自冻结后**无写入** |
| BIND-B 根配置 5 文件 | 自冻结后**无写入** |

> **必须如实说明的一处**：我在执行前按授权跑了 `pnpm run build`，
> 它**刷新了 `lib/`、`dist/` 下构建产物的 mtime**（07:25:48–49），
> 但**内容未变**——六个绑定产物 SHA256 全部保持一致、文件总数 180 不变。
> 因此 BIND-A/BIND-C 的**内容绑定仍成立**；若 QA 按 mtime 判定会看到变化，
> 那是本次授权构建所致，不是漂移。建议 QA 用内容摘要重算 BIND-A 确认。

### F. 未执行：重启（交用户手动完成）

**我不执行重启**，原因见 §2（本会话运行在被重启的应用内部，退出即会话终止，
无法在应用关闭后执行回滚或取证）。**当前 profile 已改好、等待一次正常重启。**

**用户请这样操作**：菜单正常退出 DeepSeek Harness（**不要强杀进程**）→ 重新启动。
配置在下次启动才生效，因此**在重启前一切照旧，随时可不重启并回滚**。

**若启动异常，回滚三步**（只删我建的 junction，绝不递归其目标）：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Remove-Item "$p\node_modules\@dsh-gamecenter\host"   -Force
Remove-Item "$p\node_modules\@dsh-gamecenter\client" -Force
Remove-Item "$p\node_modules\@dsh-gamecenter"        -Force   # 仅当为空
Copy-Item "$p\package.json.bak-gamecenter-2026101907" "$p\package.json" -Force
```

### G. DSH-REAL 状态

**截至本记录，DSH-REAL 仍为零条。** A/B/C 只是让下次启动具备加载条件；
真正的 `DSH-REAL` 证据必须在**重启后**按 §3 的七个观察点采集。
因此 **阶段0 仍未通过，A0-2~A0-7 依旧 BLOCKED**。

## 5. 取证通道调查（2026-10-19 07:3x，回应 QA 指出的「观察点 ① 拿不到证据」）

QA 的结论**成立**，我把机制查到了源码级，并纠正一处：**他建议的「重定向启动」也拿不到 ①**。

### 5.1 机制（`app.asar/lib/main.js`，Electron 主进程）

桌面 Host 是**子进程**，启动参数来自实读的运行进程（PID 32684）：

```text
DeepSeek Harness.exe --expose-internals ...dsh-desktop-host\lib\index.js ...
  ...\dsh  <PROFILE_DIR>  ...\primary-runtime ...
```

→ **运行中的 profile 确实是 `desktop`**，A/B/C 改对了目标。
（另：`~/.dsh/desktop-launcher/launcher.ps1` 走的是 `dsh web` + 浏览器，**不是**当前运行的形态，
不要按那个脚本判断 profile。）

子进程启动的 stdio 配置：

```js
stdio: ["ignore", "pipe", "pipe", "ipc"]     // @148150
child.stderr?.on("data", (chunk) => {        // @148187
  this.stderr = (this.stderr + chunk).slice(-65536)
})
child.stdout?.pipe(process.stdout)           // @148227
```

关键事实：
- 子进程 **stderr 被 pipe 进内存**（滚动 64KB 缓冲），**永不转发**；
- `process.stderr` 在 `main.js` 中**命中 0 次**（我用脚本统计，非目测）；
- 只有子进程 **stdout** 被 `pipe(process.stdout)` 转发；
- 该缓冲唯一消费点是子进程 **非零退出**时拼进错误信息（`@149418`/`@149456`），
  上游注释写着「a Host exit error already carries a 64 KiB stderr tail in its message」。

### 5.2 由此得出两条结论

1. **观察点 ① 在「启动成功但 bundle 被静默跳过」这条路径上结构性不可得**——QA 判断正确。
2. **「从终端重定向启动」（QA 方案甲）对 ① 无效**：重定向只能拿到 Electron 主进程的
   stdout（内含子进程 stdout），而 `skipping profile bundle` 走的是**子进程 stderr**，从不转发。
   方案甲只会改变启动方式、换来一条拿不到目标的通道，**故不采纳**。

**唯一能拿到 ① 的情形**：子进程**非零退出**（例如装载期硬失败），
此时 64KB stderr 尾巴会出现在 GUI 的错误提示里——那属于「失败时的诊断线索」，不是成功路径的证据。

### 5.3 替代门禁：把「静默跳过」变成可枚举、可排除

既然拿不到「跳过原因」，我改为**证明跳过条件不成立**。`dsh-app-boot` 会让 bundle 被静默跳过的
条件只有四个，我逐条在当前实装文件上核对（只读，脚本放 `%TEMP%`，不写仓库）：

| 条件 | 依据 | Host bundle 实测 |
| --- | --- | --- |
| ① `resolveBundleDir` 解析不到包目录 | `:1020-1021` | **PASS**，解析到 `packages\dsh-gamecenter` |
| ② 缺 `dsh.bundle` | `:1023-1024` throw | **PASS**，存在 `{patch:"./cordis.patch.yml"}` |
| ③ `engines.dsh` 不满足运行时 | `unmetRequirements` | **PASS**，`>=0.2.1-rc.2 <0.3.0` vs 运行时 `0.2.1-rc.2`（下界相等，includePrerelease 成立） |
| ④ patch 声明形状非法 / 文件缺失 | `:513-519`、`bundlePatchPaths` | **PASS**，`["./cordis.patch.yml"]`，3032B，含两条 Loader 条目 |

→ **四项跳过条件均不成立，Host bundle 不应被静默跳过。**
（Client 包「缺 dsh.bundle」是**预期**：它只作 Loader 条目，不进 `dsh.profile.bundles`。）

### 5.4 因此重启后的门禁改为「正向信号优先」

1. **主门禁（正向）**：`ctx.get('gameCenter')` 存在且 `typertRemote.namespace === 'gameCenter'`；
   `ctx.typertGateway.claimsEndpoint('gameCenter/handshake') === true`。
   这两项**只有在插件真的被装载并执行 `apply()` 后才会为真**——足以区分「装载成功」与「未装载」。
2. **界面**：侧栏出现「游戏中心」且在「技能中心」之后；console 无 `Remote 挂载失败`。
3. **① 降级为失败诊断项**：仅当应用**启动失败**时，从 GUI 错误提示读取 64KB stderr 尾巴。

### 5.5 残留风险（必须写明）

- 以上是**排除法 + 正向信号**，等价于「若四项条件都不成立，则跳过概率极低」，
  **不是**「已证明不会有其它跳过路径」。`dsh-app-boot` 之外是否还有别的跳过点，我未穷举。
- 若重启后主门禁全为假且应用正常启动，则说明存在我未覆盖的跳过/失败路径，
  届时只能靠新增诊断手段（需另申请）定位。

### 5.6 取证责任人

**我与会话内其它 Bot 都运行在这个将被重启的应用里**：应用一关，本会话即终止。
因此**重启后的取证必须在重启后新建的会话里进行**（由 @测试与发布负责人 或用户发起），
读的是已落盘的 `docs/phase0-execution-log.md` 与运行态查询，**不能依赖本会话续接**。
回滚不依赖重启：配置在下次启动才生效，重启前随时可回滚（命令见 §F）。

## 6. 观察点 ① 的取证通道已解决（2026-10-19 07:4x）

§5 的结论「① 不可得」是**针对 GUI 启动路径**成立的。但我随后找到一条**不需要重启、
不启服务、不动 profile** 的通道：用 **实装同版本的 `dsh-app-boot`** 在真实 profile 上
**重放装载路径**，直接读出 `layers` 与 `skippedBundles`。

### 6.1 方法（关键）：Electron 二进制当 Node 用

`<DSH_INSTALL>\DeepSeek Harness.exe` 在 `ELECTRON_RUN_AS_NODE=1` 下
是纯 Node **24.21.0**（与 `runtime.json` 声明一致），且 **Electron 的 fs 支持读 `app.asar` 内部**——
普通 `node.exe` 做不到（会 `ERR_MODULE_NOT_FOUND`），这是之前一直没能直读的原因。

实测探针结果：
```text
node 版本: 24.21.0      electron 版本: 44.7.0
OK  .../app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot  (dir)
name: @deepseek-ai/dsh-app-boot   version: 0.2.1-rc.2      ← 与实装版本一致
require 成功，导出数: 59
是否含 loadProfileDirectory: true
是否含 reportSkippedBundles: true
```

### 6.2 实测结论（对真实 profile 调用实装 `loadProfileDirectory`）

```text
=== 装载成功的 bundle 层（layers）=== 共 16 层
  OK  @deepseek-ai/dsh-base
  OK  @deepseek-ai/dsh-web-app
  OK  @deepseek-ai/dsh-experimental-auto-review
  OK  dsh-free-search
  OK  @linxin666/dsh-client-ui-skill-explorer
  OK  dsh-agent-plugins-market
  OK  dsh-click
  OK  dsh-pet
  OK  ds-bot
  OK  dsh-mnemon
  OK  dsh-turn-eraser
  OK  dsh-auto-continue
  OK  @linxin666/dsh-web-all
  OK  @deepseek-ai/dsh-experimental-tool-worktree
  OK  @deepseek-ai/dsh-experimental-session-search
  OK  @dsh-gamecenter/host          ← 我们这一层

=== 被静默跳过的 bundle（skippedBundles）=== （空）

@dsh-gamecenter/host 在 layers 中: true
@dsh-gamecenter/host 在 skippedBundles 中: false
  patchPaths: ["<PROFILE_DIR>\node_modules\@dsh-gamecenter\host\cordis.patch.yml"]
  该层解析出的 insert 条目: gamecenter-host=@dsh-gamecenter/host, gamecenter-client=@dsh-gamecenter/client
  用户 patch 层 …\desktop\cordis.patch.yml 解析条目数: 16

=== profile 未被写入校验 === PASS 所有受监控 profile 文件哈希未变
```

**三项实测结论**：
1. **Host bundle 进入 layers、未被跳过** —— ① 所担心的「静默跳过」在真实输入上**已排除**（用实装代码测，不是推断）。
2. **junction 在真实装载路径上确实生效** —— `patchPaths` 指向
   `…\profiles\desktop\node_modules\@dsh-gamecenter\host\cordis.patch.yml`，
   即 profile 经我们新建的 junction 解析到了仓库内文件。
3. **两条 Loader 条目确实由我们的 patch 产出** —— `gamecenter-host` 与 `gamecenter-client`
   都出现在解析结果里；即 Client 的发现入口已具备。

### 6.3 复现方式（QA 可独立复跑）

**可用的调用方式（实测 exit 0）**：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$s = "$env:TEMP\dsh-boot-replay.cjs"
cmd /c "`"<DSH_INSTALL>\DeepSeek Harness.exe`" `"$s`" > `"$env:TEMP\br.out`" 2> `"$env:TEMP\br.err`""
$LASTEXITCODE   # 实测 0
```

> **踩坑记录 1（锚点必须选对，否则结论会错）**：
> `installAnchor` 必须用 **`app.asar/dsh/package.json`**（dsh 运行时包的锚点），
> **不能**用桌面外壳锚点 `app.asar/package.json`。
> 测试与发布负责人独立复跑时实测：用外壳锚点会得到 `layers=12、skipped=4`
> （`@deepseek-ai/dsh-web-app` 报 `0.1.5-rc.2` 与 `dsh 0.2.1-rc.2` 不兼容，另三个解析不到），
> 而正确锚点下是 `layers=16、skipped=0`。
> 后者才是桌面 Host 子进程的真实解析锚点（见 §5.1 的 PID 32684 命令行）。
> **用错锚点会把 `skipped=4` 误读成"有 bundle 被跳过"。** 这一条由 QA 独立复现查出并补充。

> **踩坑记录 2**：不要用 `Start-Process ... -RedirectStandardOutput/-RedirectStandardError`，
> 本机会因环境变量 `NO_PROXY` 与 `no_proxy` 大小写重键而抛
> `已添加项。字典中的关键字:“NO_PROXY”所添加的关键字:“no_proxy”`，进程根本不会启动。
> 用 `cmd /c` 重定向绕开。

**实测输出（解析为键=值，便于机器核对）**：

```text
layers=16 skipped=0
host_in_layers=true
host_in_skipped=false
layer_order_last=@dsh-gamecenter/host
patch_path_via_junction=<PROFILE_DIR>\node_modules\@dsh-gamecenter\host\cordis.patch.yml
insert_entries=gamecenter-host=@dsh-gamecenter/host,gamecenter-client=@dsh-gamecenter/client
profile_files_changed=0
restored_ok=true
VERDICT=PASS
EXIT_CODE=0
```

脚本要点（只读，不写任何文件）：

```js
const ASAR = '<DSH_INSTALL>/resources/app.asar'
const APPBOOT = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-app-boot`
const installAnchor = `${ASAR}/dsh/package.json`
const profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const { loadProfileDirectory } = require(APPBOOT)
const result = loadProfileDirectory('dsh', profileDir, installAnchor)
// 读 result.layers（装载层）与 result.skippedBundles（跳过项），并校验 profile 文件哈希前后一致
```

### 6.4 证据等级与边界（不得夸大）

- **这比 STATIC 强**：用的是**实装同版本（0.2.1-rc.2）**的 `dsh-app-boot`，输入是**真实 profile**，
  结果是**运行时函数的实际返回值**，不是我的复刻或推断。
- **但它仍不等于完整 DSH-REAL**：它是我在**独立进程**里重放的装载路径，
  **不是 GUI 进程自己启动时观测到的**。因此仍**未**证明：
  ①Loader 是否真的把两条条目挂载成插件（fiber 是否 active）；
  ②`ctx.remote.$mount()` 是否接受 contribution；
  ③侧栏/弹层是否真实渲染；④关闭后是否拒请求。
- 我把它记作 **`DSH-BOOT-REPLAY`（实装代码重放）**，与 `DSH-REAL`（运行中的 GUI 实测）分开记，
  不拿它冒充 `DSH-REAL`。
- **因此阶段0 仍未通过，A0-2~A0-7 依旧 BLOCKED**；但 ① 这一项的取证缺口**已关闭**。

### 6.5 副作用核查

- 脚本不调用 `process.exit` 之外的任何写操作；未启服务、未加载 GUI、未改 `DSH` 安装目录。
- 运行前后监控的 5 个 profile 文件（`package.json`、`cordis.patch.yml`、`cordis.yml`、
  `pnpm-lock.yaml`、`pnpm-workspace.yaml`）**哈希全部未变**。
- 运行前后仓库六产物摘要在 §4.E 已核，本轮**未写入 `packages/**`**。
- 临时脚本存放于 `%TEMP%`，**不在仓库内**，故不影响 BIND-A 绑定。

## 7. 三项正向信号的可观测性（回应 QA 的直接提问）

QA 问：重启后由谁、用什么命令或界面求值
①`ctx.get('gameCenter')` ②`typertRemote.namespace === 'gameCenter'`
③`claimsEndpoint('gameCenter/handshake')`。**逐项核实结论如下。**

### 7.1 我这边也没有直接求值通道（已实测）

- **HTTP 通道被鉴权挡住**：网关确实把已认领端点挂在 `/api` 上（`connection.rpc.intercept("/api", ...)`），
  我实测 `POST http://127.0.0.1:3080/api` 带 `{"endpoint":"gameCenter/handshake","args":{}}` →
  **401 `unauthorized`**；加同源头（`Origin`/`Referer`/`Sec-Fetch-Site`）仍 **401**；
  连 `GET /` 与 `GET /api/unknown-endpoint` 也都是 **401**。
  → GUI 表面需要浏览器那一侧的已认证会话，我**没有**该凭据，故无法用 HTTP 区分「已认领 / 未认领」。
- **进程内省不可得**：那三项是**运行中 Host 进程内部**的 Cordis 状态；我只有文件与 shell 工具，
  对该进程没有 introspection 通道。
- 结论：**①②③ 我都无法直接求值**。不编造通道，也不把它们记成"通过"。

### 7.2 可执行的通道与「由此可推出什么」

| 信号 | 可执行通道 | 证据性质 |
| --- | --- | --- |
| bundle 是否装载、两条 Loader 条目是否产出 | **§6 的 `DSH-BOOT-REPLAY`**（已做，exit 0） | 实装代码重放，**直接测得** |
| 插件是否被挂载且 fiber 为 active | GUI 插件清单/插件管理界面（`dsh-client-ui-settings-plugin-inventory`、`dsh-client-ui-plugin-manager`）截图 | 界面**直接观察** |
| 侧栏「游戏中心」位置、弹层是否渲染 | GUI 目视 | 界面**直接观察** |
| 弹层内模型目录能否取到 | GUI，且**只读**、不触发 `stream` | 界面**直接观察** |
| ①`ctx.get('gameCenter')` | 无直接通道 | **推断**：`apply()` 构造服务是无条件的，fiber=active 说明 `apply()` 未抛错 ⇒ 服务已注册 |
| ②`typertRemote.namespace === 'gameCenter'` | 无直接通道 | **推断**：构造时 `super(ctx,'gameCenter',{namespace:'gameCenter'})` 为常量，服务存在即绑定成立 |
| ③`claimsEndpoint(...)` | 无直接通道 | **推断**：若弹层的模型目录**经 Remote 成功取回**，说明该端点被认领且 Host 服务可达（`$mount` 也被接受） |

### 7.3 给验收的口径建议

- 把 ①②③ 在报告里写成 **`无法直接求值（derived）`**，并附上 §7.2 的推断链，
  **不要写成「通过」**；只有 UI 侧那几项写成直接观察。
- 「弹层能只读取到模型目录」是本轮**信息量最大**的单条证据：它一条同时覆盖
  `$mount` 是否接受 contribution、端点是否被认领、Host 服务是否可达。
- 若重启后应用正常启动、bundle 已在 layers（§6）、但 UI 无入口且 Remote 取不到目录，
  则属**我未覆盖的失败路径**，需另申请诊断手段（如临时加日志，但那会改动 `packages/**`，
  必须重新走验收绑定）。

### 7.4 一条**存在但未使用**的通道：认证后直查 `/api`（需用户授权，暂不采用）

我查到 401 的鉴权机制（`dsh-client-connection/lib/index.js`）：

```text
API_PATH      = "/api"
CONNECT_PATH  = "/connect"                     ← “Launch-token exchange route for API clients”
TOKEN_QUERY   = "token"
COOKIE_PREFIX = "dsh-auth-"
AUTH_RECORD_KEY = credentialKey("client-connection", "browser-session")
```

也就是说：`/api` 用 `dsh-auth-*` cookie 认证，而该会话密钥存放于**凭据记录**；
另有一条 `/connect` 启动令牌交换路由供 API 客户端换取 cookie。

**若用这条通道**，就能对 `/api` 发起真实 RPC，从而**直接测得** `claimsEndpoint`
（未认领 → 404 / 已认领 → 分发）与 Host 服务可达——把 §7.2 中三项 `derived` 降为实测。

**但我没有采用，理由**：
1. 它需要**读取/使用属于用户会话的凭据**，属账号权限范围，按团队规则须用户单独授权；
2. 该凭据能代表用户的已认证会话，收益（把三项从推断变实测）与风险（动用会话密钥）不成比例；
3. 用户只需做 4 项目视检查即可覆盖同样结论（见 §7.2 的界面通道）。

**结论**：这是一个**已知可用但未动用**的通道，记录在此供后续判断；
未经用户明确授权，不使用会话凭据，也不把它当作已获取的通道。

## 8. 重启后现状与「占位界面的边界」（2026-10-19 08:0x）

### 8.1 已确认的重启事实

- Host 子进程 **PID 30996，启动 07:59:56**，命令行带 `<PROFILE_DIR>`
  → 本次确实以改过的 profile 启动（QA 亦独立确认）。
- **用户报告**（不是我直接观测）：游戏中心弹层可见；关闭后**可以重新打开**。
- 这两条说明 **bundle 已加载、Client 已被发现并执行**——§6 的 `DSH-BOOT-REPLAY`
  预测在实际启动中兑现（Client 半的装配入口生效）。

### 8.2 已核实：Host 的 `inject: ['llm']` 是对的

实装 `dsh-llm` 用 `super(ctx, "llm")` 注册服务键，且含 `listProviders`/`listModels`/
`resolveModelInfo`（`lib/index.js` 与 `lib/types/index.js` 均命中）。
→ 我声明的 `inject: ['llm']` **与服务键一致**，不会因注入未满足而拖延。
（另：`dsh-api-remotes` 转发事件含 `llm/adapters-updated`，命名空间一致。）

### 8.3 已确认的缺口：现有弹层**只是占位，不能证明 Remote**

| 证据 | 位置 | 含义 |
| --- | --- | --- |
| 弹层文案只有一句静态说明 | `GameCenterOverlay.js:124`「阶段0 探针：验证 DSH 内可打开弹层…」 | 界面**没有任何** Remote / 模型目录内容 |
| 挂载结果只进 console | `index.js:200-225`：`remoteState.failure = ...` 后仅 `console.warn` | **UI 从不渲染**挂载成功或失败 |

→ 用户看到弹层，只能证明 **UI 装配成功**；`$mount` 是否成功、Host 服务是否可达、
`modelCatalog` 能否取回，**仍是未知**。**不把占位弹层当 Remote 成功。**

### 8.4 结论：Host 侧**不需要改动**，缺口在 Client 的可观察面

现有五个 Remote 方法已足够覆盖诊断（无需新增 Host 方法、**无需重建 `lib/`**，
因此不打断 QA 当前测量、也不影响已加载的 junction）：

| 诊断项 | 用什么 | 期望 |
| --- | --- | --- |
| Remote 是否挂上 | Client 侧 `$mount` 返回值 | `ok:true`；失败显示 `code: message` |
| Host 服务可达 + 端点被认领 | `handshake({runtimeInstanceId, nonce, gameId, gameVersion, sdkVersion, bridgeVersion:1})` | `{ok:true, generation, tokenDigest, state:'running'}` |
| 只读模型目录 | `modelCatalog()`（**无 wire 参数**，Host 注入 signal） | `{available:true, entries:[…], failures:[]}`；**不调 `stream`** |
| 租约状态 | `leaseStatus({gameId, saveId})` | `{state,generation,expiresAt,lastPersistedRevision}` 或 `{absent:true}` |
| 暂停闭环 | `pause({generation, reason})` | `{accepted:true, state:'pausing', timeoutMs:3000}` |
| 旧代次拒写 | `saveAck({generation: generation-1, revision:1})` | `{accepted:false, error:{code:'STALE_RUNTIME'}}` |
| 当前代次保存确认 | `saveAck({generation, revision:1})` | `{accepted:true, state:'paused', lastPersistedRevision:1}` |

**边界**：`saveId` 由 Host 以 `runtimeInstanceId` 生成，上表必须用**同一个** `runtimeInstanceId`
贯通；重复 handshake 会产生新运行实例，诊断区应复用而非每次新建。

### 8.5 用户可做的独立交叉验证（我看不到 GUI，只能请用户看）

实装 UI 有内置插件清单与插件管理两个页面（只读查看）：

- 设置 → **内置插件列表界面**（`dsh-client-ui-settings-plugin-inventory`）：
  「在设置中查看全局插件和各 Agent 预设使用的插件」
- **插件管理界面**（`dsh-client-ui-plugin-manager`）：「查看和安装插件包，并进行启用、停用和重试」

→ 若其中出现 `@dsh-gamecenter/host` 且为启用/活跃，即**直接证明 Host bundle 装载并挂载**，
正好补上我无法观测的 `fiberPhase`。若**没有**它，则说明 Host 半未挂载——
这与「Client 弹层能开」并不矛盾：弹层只依赖 Client 包，两件事必须分开看。

## 10. 超时预算与取消隔离闭环及最终候选验收（第三十六轮）

- **PM 提示风险核实**：针对单项 3s 与全局 4s 倒挂、缺乏 AbortSignal 导致后台远程写调用残留及代次串扰问题，界面与运行时工程师进行了全流程闭环加固。
- **加固落地**：
  1. 全局超时放宽至 15000ms（15 秒），单项 RPC 保持 3000ms（3 秒），彻底消除正常累积步进被误杀风险；
  2. `RemoteDiagnostics` 组件在重试前及卸载时调用 `abortPreviousRun()` 派发 `AbortSignal`；
  3. `callWithTimeout` 监听 `signal.onabort`，立刻以 `ABORTED` 中断并清理定时器；
  4. `runRemoteDiagnostics` 每步严格检查 `signal?.aborted`，中止后严禁发起后续步骤，杜绝迟到写调用；
  5. `test/diagnostics-ui.test.mjs` 新增快速重试旧轮次中止、组件卸载立刻中止等 3 项生命周期负例。
- **独立 QA 验收**：
  - 全工程测试：Client 85/85，Host 92/92，Protocol 10/10，共 187 项全绿；
  - `pnpm run typecheck` 退出码 0；
  - 产物摘要：`staging/client.js` sha256 为 `D5804E1DEDDA8C4489F36D49124AD2ECE893466631526844FA8A41D04FA8BB06`（54357 字节）；
  - 在线 `dist/client.js`（`6559EA1C…`）、Host `lib/`（`8A913821…`）及 profile 严格未动；
  - 判定：候选具备可部署性，交 PM 起草单端变更单。阶段0仍维持未通过。

## 11. 真实 Host 延迟握手/迟到完成与不可撤销风险边界实测（第三十七轮）

- **结论修正**：撤回“彻底阻断迟到写入”的不准确结论。核实 Remote 传输层未给写 RPC 声明 cancellation，已发送至 Host 的请求无法强行撤销；本地 abort 仅阻断 Client 后续步骤发起。
- **集成测试验证（`test/real-host-staging-joint.test.mjs`）**：
  - 模拟 Host 60ms 延迟 handshake，Round 1 在 15ms abort，Round 2 随后以固定 `DIAG_GAME_ID` 正常完成 7 项全绿；
  - 证实 Host 侧按独立 `saveId` 和 `runtimeToken` 精准隔离，Round 1 迟到握手绝不污染 Round 2；
  - 证实最大残留仅为 1 个孤儿 `running` LeaseRecord，待 TTL（30s）后由 Host 侧定时 sweeper 自动回收；
  - 全工程测试增至 188 项全绿（Client 86, Host 92, Protocol 10），退出码 0。

## 12. Cordis 注入拦截根因闭环与全新候选验收（第三十九轮）

- **实机运行态事实**：用户刷新并点击重测后，界面成功呈现错误 `cannot get property "remote.gameCenter" without inject`。
- **架构根因与修复**：架构负责人证实点号服务名不能直接通过属性链访问，且严禁加入 `inject`（会导致自等候死锁）；最小合法修复为改走 `ctx.get('remote.gameCenter')`。
- **独立 QA 验收**：
  - 全工程测试增至 190 项全绿（Client 88/88，Host 92/92，Protocol 10/10），退出码 0；
  - `pnpm run typecheck` 退出码 0；
  - 真实 Cordis 探针三组对照全部 PASS；
  - 产物摘要：`packages/dsh-gamecenter-client/staging/client.js` sha256 为 `1BE7FDA8703A89233C32DF6FC8F04C28814CCC49BF77CCC6635D54A0F3BBF8B7`（54484 字节）；
  - 在线 `dist/client.js`（`D5804E1D…`）与 Host `lib/` 保持隔离未动。




