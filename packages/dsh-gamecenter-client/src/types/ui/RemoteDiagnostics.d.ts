/**
 * @param {{
 *   remoteState: { failure: string | null, mounted: boolean },
 *   getService: () => any,
 *   makeNonce: () => string,
 *   runDiagnostics: (params: any) => Promise<import('../bridge/diagnostics.js').DiagnosticRow[]>
 * }} props
 */
export function RemoteDiagnostics({ remoteState, getService, makeNonce, runDiagnostics }: {
    remoteState: {
        failure: string | null;
        mounted: boolean;
    };
    getService: () => any;
    makeNonce: () => string;
    runDiagnostics: (params: any) => Promise<import("../bridge/diagnostics.js").DiagnosticRow[]>;
}): any;
