/**
 * DSH 客户端插件上下文（只声明本插件用到的成员，避免引入 cordis 类型包）。
 * @typedef {object} ClientContext
 * @property {any} slots
 * @property {any} locale
 * @property {any} [remote]
 * @property {any} [theme] DSH 主题服务（`ctx.provide('theme')` 注入，v3 主题通道）
 * @property {(name: string) => any} [get]
 * @property {any} [reflect]
 * @property {(fn: () => void | (() => void), label: string) => void} effect
 */
/**
 * @typedef {object} PauseResult
 * @property {string} kind
 * @property {string} message
 */
/**
 * @param {ClientContext} ctx
 */
export function apply(ctx: ClientContext): void;
export const LOCALE_NS: "gamecenter";
export const PANEL_ID: "gamecenter";
/** 本插件需要 Client 侧的 `remote` 服务（`ctx.remote.$mount` 由 dsh-api-gateway 提供）。 */
export const inject: string[];
/**
 * DSH 客户端插件上下文（只声明本插件用到的成员，避免引入 cordis 类型包）。
 */
export type ClientContext = {
    slots: any;
    locale: any;
    remote?: any;
    /**
     * DSH 主题服务（`ctx.provide('theme')` 注入，v3 主题通道）
     */
    theme?: any;
    get?: (name: string) => any;
    reflect?: any;
    effect: (fn: () => void | (() => void), label: string) => void;
};
export type PauseResult = {
    kind: string;
    message: string;
};
