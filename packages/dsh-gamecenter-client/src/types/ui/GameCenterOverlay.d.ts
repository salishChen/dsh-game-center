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
 */
export function GameCenterOverlay({ overlay, t, requestPause, beginRuntime, onSaveAck, onClosed, remoteState, getService, makeNonce, makeLaunchToken, runDiagnostics, }: {
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
}): any;
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
