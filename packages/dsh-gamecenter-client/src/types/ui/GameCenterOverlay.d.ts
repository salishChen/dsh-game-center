/**
 * @typedef {object} OverlayStore
 * @property {boolean} open
 * @property {(next: boolean) => void} set
 * @property {(fn: (open: boolean) => void) => () => void} subscribe
 */
/**
 * @typedef {{kind: string, message: string}} PauseResult
 */
/**
 * 弹层。所有关闭路径（关闭按钮、遮罩、Escape、返回列表）都调用同一个 `close()`，
 * 而 `close()` 里第一件事就是 `requestPause()`。
 *
 * @param {{overlay: OverlayStore, t: (key: string) => string,
 *   requestPause: (reason: string) => Promise<PauseResult>,
 *   onClosed: () => void,
 *   remoteState?: { failure: string | null, mounted: boolean },
 *   getService?: () => any,
 *   makeNonce?: () => string,
 *   runDiagnostics?: any}} props
 */
export function GameCenterOverlay({ overlay, t, requestPause, onClosed, remoteState, getService, makeNonce, runDiagnostics, }: {
    overlay: OverlayStore;
    t: (key: string) => string;
    requestPause: (reason: string) => Promise<PauseResult>;
    onClosed: () => void;
    remoteState?: {
        failure: string | null;
        mounted: boolean;
    };
    getService?: () => any;
    makeNonce?: () => string;
    runDiagnostics?: any;
}): any;
export type OverlayStore = {
    open: boolean;
    set: (next: boolean) => void;
    subscribe: (fn: (open: boolean) => void) => () => void;
};
export type PauseResult = {
    kind: string;
    message: string;
};
