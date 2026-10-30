/**
 * 创建主题桥。
 *
 * @param {any} ctx DSH 插件上下文
 * @returns {ThemeBridge}
 */
export function createThemeBridge(ctx: any): ThemeBridge;
export type ThemeBridge = {
    /**
     * 是否拿到 DSH 主题服务
     */
    available: boolean;
    /**
     * 当前主题（拿不到返回 null）
     */
    current: () => "dark" | "light" | null;
    /**
     *   绑定一个下发函数，返回取消订阅函数
     */
    bind: (send: (scheme: "dark" | "light") => boolean) => () => void;
    /**
     * 释放订阅
     */
    dispose: () => void;
};
