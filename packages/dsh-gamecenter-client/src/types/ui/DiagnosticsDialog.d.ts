/**
 * 链路诊断弹窗。
 *
 * @param {object} props
 * @param {(key: string) => string} props.t
 * @param {{ failure: string | null, mounted: boolean }} props.remoteState
 * @param {() => any} props.getService
 * @param {() => string} props.makeNonce
 * @param {any} props.runDiagnostics
 * @param {() => void} props.onClose 关闭回调（由页面负责把焦点还给触发按钮）
 * @returns {any}
 */
export function DiagnosticsDialog({ t, remoteState, getService, makeNonce, runDiagnostics, onClose }: {
    t: (key: string) => string;
    remoteState: {
        failure: string | null;
        mounted: boolean;
    };
    getService: () => any;
    makeNonce: () => string;
    runDiagnostics: any;
    onClose: () => void;
}): any;
