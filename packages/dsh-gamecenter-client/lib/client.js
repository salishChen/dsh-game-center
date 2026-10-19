/**
 * Client 插件浏览器半的**过渡期**注册壳（阶段0 占位）。
 *
 * ⚠️ 这个文件不是 DSH 生产形态，仅用于阶段性自检：
 *   - 它由 `import { apply } from '../src/index.js'` 直接引用 ESM 源码，
 *     需要 Node/浏览器原生 ESM 解析，DSH 的 factory 契约下不一定成立。
 *   - DSH 生产形态是 `dist/client.js`：esbuild 单文件 IIFE + `require()` 外部依赖，
 *     由 `tools/build-bundle.mjs` 生成，`package.json` 的 `dshGameCenter.bundle` 指向它。
 *
 * 真实加载前必须切成 dist 产物（见 docs/phase0-client.md §6.5）。
 */

import { apply } from '../src/index.js';

/** 与 package.json 的 name 一致；模块系统按该 id 去重与解析依赖。 */
const ID = '@dsh-gamecenter/client';

/** 把插件导出透出给 Cordis fiber（对象插件形态：{ apply, inject }）。 */
export { apply };

if (typeof window !== 'undefined' && typeof window.__ModuleLoader__?.load === 'function') {
  window.__ModuleLoader__.load({
    id: ID,
    factory: () => ({ apply }),
  });
}
