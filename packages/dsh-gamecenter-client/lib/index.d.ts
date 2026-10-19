/**
 * `@dsh-gamecenter/client` 的 **Host 半** 类型声明（对应 `lib/index.js`）。
 *
 * 【为什么单独有一份】
 * 本包有两个完全不同的半：
 *   - 浏览器半：`dist/client.js`，由 `src/index.js` 打包而来，声明在 `src/types/index.d.ts`
 *     （导出 `apply(ctx)`、`LOCALE_NS`、`PANEL_ID`、`inject`、`ClientContext`、`PauseResult`）。
 *   - Host 半：`lib/index.js`，纯 Node 可加载的 no-op 插件，导出 `name` / `apply` / `default`。
 *
 * `exports["."].types` 曾指向 `./src/types/index.d.ts`，那是**浏览器半**的声明。
 * 后果：任何在 Host 侧 `import { name } from '@dsh-gamecenter/client'` 的 TS 代码会报
 * `TS2305: Module '"@dsh-gamecenter/client"' has no exported member 'name'`
 * ——错误码是 TS2305 而不是 TS2307，说明模块解析是通的、只是声明与运行时导出不匹配。
 *
 * 因此本文件是 Host 半的唯一权威声明，`exports["."].types` 必须指向它，
 * `exports["./client"].types` 继续指向浏览器半的 `src/types/index.d.ts`。
 *
 * 【维护约束】
 * 本文件是**手写**的（`tsconfig.json` 的 `declarationDir` 是 `src/types`，不会生成 `lib/`）。
 * 手写声明不会自动跟随 `lib/index.js` 漂移，所以 `test/host-half-types.test.mjs` 会用一份
 * 真实 TS 文件对本包做具名导入并跑 `tsc`，把这个约束固定在测试里。
 */

/** Cordis 插件名（注意与包名不同：包名是 `@dsh-gamecenter/client`）。 */
export declare const name: string;

/**
 * Host 侧空实现：本包在服务端不做任何事，不提供服务、不注册任何东西。
 * Cordis 调用时会传入插件上下文，本实现不读取它。
 * @param ctx 插件上下文（未使用）
 */
export declare function apply(ctx?: unknown): void;

/** 默认导出：对象插件形态，字段与具名导出同源。 */
declare const pluginDefault: {
    name: string;
    apply: (ctx?: unknown) => void;
};

export default pluginDefault;
