/**
 * `@dsh-gamecenter/client` 的 **Host 半入口**（Node 侧可解析的最小模块）。
 *
 * 【为什么需要它】
 * `@deepseek-ai/dsh-client-modules` 的 `resolveMeta()` 发现 Client bundle 的方式不是
 * "被 import"，而是：某个 Loader 条目的 `name` 必须是**精确包名**
 * （`exactPackageSpecifier` 要求 `@scope/name` 恰好两段），然后
 * `locatePkgJson()` 用 `internal.resolveSync(loaderName, baseUrl)` 解析到模块 URL，
 * 再 `nearestPackage()` 沿该 URL 向上找 `name` 相符的 `package.json`，
 * 读其中的 `dsh.client` 与 `exports["./client"]` 得出浏览器 bundle 路径。
 *
 * 若 `exports["."]` 指向 `dist/client.js`（`window.__ModuleLoader__.load(...)` 形态），
 * Node 在解析这个 Loader 条目时就会执行/求值它并抛 `ReferenceError: window is not defined`。
 * 因此必须有这个**纯 Node 可加载**的入口，让包名能在 Host 侧解析成功。
 *
 * 【该模块做什么】
 * 服务端**没有**任何事要做：`gameCenter` 服务的实现与 `@Remote` 声明在
 * `@dsh-gamecenter/host` 包里；Client 半只在浏览器里工作。
 * 所以这里只导出一个 no-op 的 `apply`，让 Cordis 能把它当作合法的空插件挂上
 * （仅当有人误把本包登记成 Loader 条目时才会用到），不提供任何服务、不注册任何东西。
 *
 * 【不做什么】
 * 不 import 任何 `@deepseek-ai/*` 包（Node 侧未必能解析），不访问 `window`/`document`，
 * 不做任何副作用。
 */

/** Cordis 插件名（与包名一致，便于诊断）。 */
export const name = 'game-center-client';

/**
 * Host 侧空实现：本包在服务端无行为。
 * @returns {void}
 */
export function apply() {}

export default { name, apply };
