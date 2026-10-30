/**
 * 游戏中心页面：把游戏库作为主内容区页面呈现，诊断弹窗按需打开。
 *
 * @param {any} props
 * @returns {any}
 */
export function GameCenterPage(props: any): any;
export type OverlayStore = {
    open: boolean;
    set: (next: boolean) => void;
    subscribe: (fn: (open: boolean) => () => void) => () => void;
};
