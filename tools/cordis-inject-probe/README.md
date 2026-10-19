# Cordis 注入守卫探针（架构与协议负责人）

目的：用**本机已安装 DSH 的真实 Cordis 实现**复现并定位
`cannot get property "remote.gameCenter" without inject`，不依赖任何手写 mock。

数据来源（只读，不修改安装目录）：
`<DSH_INSTALL>\resources\app.asar`（占位符，非可直接执行路径）
→ `dsh/node_modules/@deepseek-ai/{cordis,cosmokit}`、`@standard-schema/spec`
→ 实测版本 `@deepseek-ai/dsh-desktop 0.2.1-rc.2` / `dshBuildCommit 332895e0…`。

## 用法

```powershell
# 1. 从 asar 释放真实 Cordis 到临时目录（只读 asar，不写安装目录）
node tools/cordis-inject-probe/extract-cordis.mjs

# 2. 用真实 Cordis 跑三组对照，退出码 0 表示全部符合预期
node tools/cordis-inject-probe/repro-inject-guard.mjs

# 3. 校验真实 GUI 加载的浏览器产物是否同样支持 ctx.get（Node 侧通过不等于浏览器侧通过）
node tools/cordis-inject-probe/verify-browser-cordis.mjs
```

## 为什么第 3 步不能省

运行中的 GUI 加载的是 `dsh-web-frontend/dist/assets/index-*.js`（压缩产物），
与 Node 侧的 `@deepseek-ai/cordis` 是**两份不同的产物**。
只在 Node 侧验证 `ctx.get` 可用，不能推出真实 GUI 里也可用。

第 3 步校验是**静态特征匹配**（`STATIC`），不是运行观察；但它能排掉"浏览器构建里根本没这个 API"这一类致命偏差。

实测（`index-CN7NIWNw.js`，921071 字符）四项全部 PASS：

| 特征 | 结论 |
| --- | --- |
| `mixin("reflect",["get",...])` | 存在，`ctx.get` 是 accessor |
| `get(name, strict=true)` 直接读服务表 | 存在，不查 inject |
| `_getImpl` 的 `fiber.state !== 2` 严格检查 | 存在 |
| `_refresh` 在任一 inject 缺失时置 INACTIVE | 存在（死锁机制同 Node 侧） |


## 三组对照与实测结果

| 组 | 场景 | 预期 | 实测 |
| --- | --- | --- | --- |
| A | `inject: ['remote']`，读 `ctx.remote.gameCenter` | 抛 `cannot get property "remote.gameCenter" without inject` | 一致（复现用户实机错误） |
| B | `inject: ['remote']`，读 `ctx.get('remote.gameCenter')` / `ctx.reflect.get(...)` | 读到服务，且实例自有 getter 方法可调用 | 一致（两条路径都返回 `{ok:true, namespace:'gameCenter'}`，调用计数递增） |
| C | `inject: ['remote', 'remote.gameCenter']` | `apply` 永不执行（自等候死锁） | 一致（等待 120ms 后 `applyRan:false`） |

实测输出（退出码 0）：

```
A ctx.remote.gameCenter（inject 只有 remote）: {"ok":false,"message":"cannot get property \"remote.gameCenter\" without inject"}
B ctx.get("remote.gameCenter"): {"viaGet":{"ok":true,...},"viaReflect":{"ok":true,...},"traceableWrapped":true,"viaDottedOK":false}
C inject 含 remote.gameCenter 时 apply 是否执行: {"applyRan":false}
A 复现实机报错   : PASS
B ctx.get 放行    : PASS
C 自等候死锁      : PASS
```

## 源码坐标（实装 0.2.1-rc.2 / 332895e0…）

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `@deepseek-ai/cordis/lib/index.js` `ReflectService.handler.get`（约 676 行） | `const error = new Error(\`cannot get property "${prop}" without inject\`)` —— 报错原文 |
| 2 | 同上（约 682–694 行） | 只沿 `fiber.store` **祖先链**查找；找不到且 `prop in fiber.inject` 为假时继续上溯，到无 runtime 的根 fiber 抛错 |
| 3 | 同上 `_checkImpl`（约 1306 行） | 只为 `fiber.inject` 里的名字填充 `_store`，来源是**根级** `reflect.store` |
| 4 | 同上 `_refresh`（约 1317 行） | 只要有一个 inject 未就绪，epoch 置 `INACTIVE` |
| 5 | 同上 `_setEpoch`（约 1330 行） | 仅在 `INACTIVE → 有值` 时触发 reload（即 apply） |
| 6 | 同上 `get(name, strict=true)`（约 756 行） | 注释原文：**Read a service from the store without the inject requirement.** 即 `ctx.get` 是官方放行读法 |
| 7 | 同上 `mixin("reflect", ["get", ...])`（约 736 行） | 把 `get` 作为 accessor 挂到所有 ctx 上 |
| 8 | `@deepseek-ai/dsh-api-remotes/lib/client.js`（23639 / 23675 行） | 官方消费者的唯一写法：`const inject = ["remote"]` + `await ctx.remote.$mount(contribution)`，**从不声明点号命名空间** |
| 9 | `@deepseek-ai/dsh-api-gateway/lib/client.browser.js` `createNamespace` | `await fiber` 后才返回，命名空间服务在其 fiber 内同步 `provide`，故 `$mount` 成功后服务已 active（满足第 6 条的 `strict` 检查） |

## 结论

1. 读取已挂载的动态命名空间，**不能**用 `ctx.remote.<namespace>` 点号形式，因为该名字不在 `inject` 中。
2. **也不能**把它写进 `inject`：那会在 `_refresh` 里永远等不到（服务正是本插件自己挂载的），造成 `apply` 永不执行的死锁（第 4、5、6 条）。
3. 正确读法是 `ctx.get('remote.gameCenter')`（或等价的 `ctx.reflect.get(...)`），它是 Cordis 文档化的“无需 inject 的服务读取”，不是绕过保护。
4. 需要 `ctx.remote.$mount` 时，`inject` 只需 `"remote"`。
