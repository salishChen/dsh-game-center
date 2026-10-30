/**
 * @typedef {object} CatalogDisplay
 * @property {number} [schemaVersion]
 * @property {string} [repository]
 * @property {string} [summary]
 * @property {string} [descriptionMarkdown] 受限 Markdown 简介（安全渲染）
 * @property {any} [cover] 封面元数据（媒体本轮禁用，显示占位）
 * @property {any[]} [screenshots] 截图元数据（媒体本轮禁用，显示占位）
 * @property {any} [compatibility]
 */
/**
 * @typedef {object} CatalogEntry
 * @property {string} gameId
 * @property {string} title
 * @property {string} summary
 * @property {string} version
 * @property {string} repository
 * @property {string} commit
 * @property {string} manifestDigest
 * @property {string} bundleDigest
 * @property {'approved' | 'pending' | 'rejected' | 'unknown'} approvalState
 * @property {boolean} installed
 * @property {string | null} installedCommit
 * @property {CatalogDisplay} [display] 展示元数据（简介/媒体/兼容范围）
 */
/**
 * @typedef {object} PreviewEntry
 * @property {string} previewId
 * @property {string} gameId
 * @property {string} name
 * @property {string} version
 * @property {'fixture'} source
 * @property {string} label
 * @property {boolean} installable
 */
/**
 * 游戏中心主弹层组件。
 *
 * @param {object} props
 * @param {OverlayStore} props.overlay
 * @param {(key: string) => string} props.t
 * @param {(reason: string) => Promise<PauseResult>} props.requestPause
 * @param {((args: { gameId: string, saveId: string, runtimeInstanceId?: string }) => any) | null} [props.beginRuntime]
 * @param {((ack: { generation: number, revision: number }) => void) | null} [props.onSaveAck]
 * @param {() => void} props.onClosed
 * @param {{ failure: string | null, mounted: boolean }} [props.remoteState]
 * @param {() => any} [props.getService]
 * @param {() => string} [props.makeNonce]
 * @param {() => string} [props.makeLaunchToken]
 * @param {any} [props.runDiagnostics]
 * @param {'overlay' | 'page'} [props.presentation] 呈现方式：
 *   - `overlay`（默认）：既有 shell.overlay 弹层形态，含遮罩与「游戏库/链路诊断」Tab；
 *   - `page`：作为主内容区**页面**呈现（2026-10-20 用户改版）。无遮罩、无 Tab，
 *     诊断弹窗由页面右上角按钮控制，游戏库常驻内容区。
 * @param {boolean} [props.diagnosticsOpen] page 模式下由页面控制的诊断弹窗开关
 * @param {any} [props.sessionController] 插件作用域的会话控制器（v3 导航收尾用）
 * @param {any} [props.themeBridge] DSH 主题桥（v3：主题经已配对 MessagePort 下发）
 */
export function GameCenterOverlay({ overlay, t, requestPause, beginRuntime, onSaveAck, onClosed, remoteState, getService, makeNonce, makeLaunchToken, runDiagnostics, presentation, diagnosticsOpen, sessionController, themeBridge, }: {
    overlay: OverlayStore;
    t: (key: string) => string;
    requestPause: (reason: string) => Promise<PauseResult>;
    beginRuntime?: ((args: {
        gameId: string;
        saveId: string;
        runtimeInstanceId?: string;
    }) => any) | null | undefined;
    onSaveAck?: ((ack: {
        generation: number;
        revision: number;
    }) => void) | null | undefined;
    onClosed: () => void;
    remoteState?: {
        failure: string | null;
        mounted: boolean;
    } | undefined;
    getService?: (() => any) | undefined;
    makeNonce?: (() => string) | undefined;
    makeLaunchToken?: (() => string) | undefined;
    runDiagnostics?: any;
    presentation?: "overlay" | "page" | undefined;
    diagnosticsOpen?: boolean | undefined;
    sessionController?: any;
    themeBridge?: any;
}): any;
export type CatalogDisplay = {
    schemaVersion?: number;
    repository?: string;
    summary?: string;
    /**
     * 受限 Markdown 简介（安全渲染）
     */
    descriptionMarkdown?: string;
    /**
     * 封面元数据（媒体本轮禁用，显示占位）
     */
    cover?: any;
    /**
     * 截图元数据（媒体本轮禁用，显示占位）
     */
    screenshots?: any[];
    compatibility?: any;
};
export type CatalogEntry = {
    gameId: string;
    title: string;
    summary: string;
    version: string;
    repository: string;
    commit: string;
    manifestDigest: string;
    bundleDigest: string;
    approvalState: "approved" | "pending" | "rejected" | "unknown";
    installed: boolean;
    installedCommit: string | null;
    /**
     * 展示元数据（简介/媒体/兼容范围）
     */
    display?: CatalogDisplay;
};
export type PreviewEntry = {
    previewId: string;
    gameId: string;
    name: string;
    version: string;
    source: "fixture";
    label: string;
    installable: boolean;
};
export type OverlayStore = {
    open: boolean;
    set: (next: boolean) => void;
    subscribe: (fn: (open: boolean) => void) => () => void;
};
export type PauseResult = {
    kind: string;
    message: string;
};
