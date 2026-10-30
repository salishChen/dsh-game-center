/**
 * 创建游戏会话控制器。
 *
 * @param {object} deps
 * @param {(reason: string) => Promise<{kind: string, message: string}>} deps.requestPause
 *   插件作用域的暂停入口（内部完成 requestPause → checkpoint 落盘确认 → saveAck 封存）。
 * @param {() => any} [deps.getService]
 * @param {(lease: any) => void} [deps.destroyRuntime] 销毁本地运行时租约
 * @param {() => any} [deps.createResourceTable] 资源表工厂（用于释放）
 * @returns {any}
 */
export function createGameSessionController(deps: {
    requestPause: (reason: string) => Promise<{
        kind: string;
        message: string;
    }>;
    getService?: (() => any) | undefined;
    destroyRuntime?: ((lease: any) => void) | undefined;
    createResourceTable?: (() => any) | undefined;
}): any;
/**
 * 游戏会话控制器（2026-10-20 v3 导航收尾，PM 点名硬要求）。
 *
 * 【要解决的真问题】React 的 `useEffect` cleanup 是**同步**的，不能 await。
 * 早期实现用 `return () => { void close('navigate') }`——fire-and-forget：
 * React 当场卸载 iframe，而 `requestPause → 落盘 → saveAck` 还在飞。
 * 结果是「界面已经离开、iframe 已销毁、存档其实没写完」，玩家看到的是假象。
 *
 * 【设计】把「运行中的游戏容器」从 React 树里搬到一个**插件作用域的 detached DOM host**：
 * - host 由插件 `apply()` 时创建并挂到 `document.body`，生命周期与插件一致，
 *   **不随 main 槽页面卸载而销毁**；
 * - iframe 以命令式方式渲染进 host，React 卸载页面时不会移除它；
 * - 导航离开时只**启动**收敛（`requestPause → checkpoint ack → saveAck 封存 → dispose`），
 *   全部 ack 之后才把 iframe 从 host 移除；
 * - 收敛期间页面渲染"正在保存并退出…"占位（不可见但不卸载），玩家看到的是真实状态；
 * - 落盘失败**绝不**显示"已保存"：状态转为 `failed`，容器与会话保留以便重试。
 *
 * 隔离纪律：host 与 iframe 都不进入游戏可达范围；`launchToken`/`runtimeToken`
 * 只在本控制器内存持有，不写 DOM 属性、不进 URL、不进日志。
 */
/**
 * @typedef {object} GameSession
 * @property {string} gameId
 * @property {string} commit
 * @property {string} title
 * @property {string} runtimeInstanceId
 * @property {string} nonce
 * @property {string} launchToken
 * @property {string | null} runtimeToken
 * @property {any} lease
 * @property {string} docHtml
 * @property {string | null} blobUrl
 * @property {boolean} [supportsSave]
 * @property {boolean} [supportsResume]
 * @property {Function} [abortAi]
 * @property {Function} [unbindTheme]
 * @property {any} dispatcher
 */
/** 控制器状态。 */
export const SessionState: Readonly<{
    IDLE: "idle";
    RUNNING: "running";
    SUSPENDED: "suspended";
    FINALIZING: "finalizing";
    SAVED: "saved";
    FAILED: "failed";
}>;
export type GameSession = {
    gameId: string;
    commit: string;
    title: string;
    runtimeInstanceId: string;
    nonce: string;
    launchToken: string;
    runtimeToken: string | null;
    lease: any;
    docHtml: string;
    blobUrl: string | null;
    supportsSave?: boolean;
    supportsResume?: boolean;
    abortAi?: Function;
    unbindTheme?: Function;
    dispatcher: any;
};
