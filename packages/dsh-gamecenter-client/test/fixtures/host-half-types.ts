/**
 * 守卫夹具：证明 `@dsh-gamecenter/client` 的 **Host 半** 声明真的能用。
 *
 * 本文件由 `test/host-half-types.test.mjs` 用真实 `tsc` 编译。
 * 它不是一个"能跑"的程序，而是一次**声明解析**探测：若 `exports["."].types`
 * 指向浏览器半（`src/types/index.d.ts`，导出 `apply(ctx)`/`LOCALE_NS`/`PANEL_ID`/`inject`），
 * 下面的具名导入 `name` 会报 TS2305，默认导入会报 TS1192。
 *
 * 三种导入形态都覆盖，因为三种都可能被人用来接入：
 *   1. 具名 `name` —— Host 工程师实际遇到的那一条
 *   2. 具名 `apply` —— 需要签名是"可省略参数"，否则 Cordis 风格调用会被拒
 *   3. 默认导出 —— 对象插件形态 `{ name, apply }`
 */

import pluginDefault, { apply, name } from '@dsh-gamecenter/client';

/** 1. 具名 `name` 必须是 string（浏览器半没有这个导出，缺了会 TS2305）。 */
const pluginName: string = name;

/** 2. `apply` 必须可以不传参调用，也可以接收 Cordis 传入的上下文。 */
const applyWithoutCtx: () => void = apply;
const applyWithCtx: (ctx?: unknown) => void = apply;

/** 3. 默认导出必须是对象插件形态，且字段与具名导出同源。 */
const defaultPlugin: { name: string; apply: (ctx?: unknown) => void } = pluginDefault;

export { pluginName, applyWithoutCtx, applyWithCtx, defaultPlugin };
