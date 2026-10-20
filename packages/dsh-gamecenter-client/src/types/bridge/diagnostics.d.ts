/**
 * @typedef {object} DiagnosticRow
 * @property {string} key
 * @property {string} label
 * @property {'pending' | 'ok' | 'fail' | 'warn' | 'skip'} status
 * @property {string} value
 * @property {string} [detail]
 */
/**
 * @param {string} str
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeMessage(str: string, max?: number): string;
/**
 * 为任意 Promise 提供有界超时与 AbortSignal 取消包装。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T>;
/**
 * 执行诊断全流程。
 *
 * @param {object} params
 * @param {{ failure: string | null, mounted: boolean }} params.remoteState 客户端当前 $mount 状态
 * @param {any} [params.client] createGameCenterClient 创建的包装客户端
 * @param {() => string} params.makeNonce 生成随机 nonce 的函数
 * @param {(row: DiagnosticRow) => void} [params.onRow] 逐步回调（用于实时更新 UI）
 * @param {AbortSignal} [params.signal] 外部取消信号
 * @returns {Promise<DiagnosticRow[]>}
 */
export function runRemoteDiagnostics({ remoteState, client, makeNonce, onRow, signal }: {
    remoteState: {
        failure: string | null;
        mounted: boolean;
    };
    client?: any;
    makeNonce: () => string;
    onRow?: ((row: DiagnosticRow) => void) | undefined;
    signal?: AbortSignal | undefined;
}): Promise<DiagnosticRow[]>;
/**
 * 游戏中心阶段0 最小无付费 Remote 诊断核心逻辑。
 *
 * 契约与安全硬约束：
 * 1. 独立探针实例：使用专用 gameId（`__gamecenter_diag__`），生成独立 runtimeInstanceId。
 * 2. 同一链条复用：saveId 是**存档槽位**（固定 `save-default`），与 runtimeInstanceId 分离；
 *    链内所有依赖租约的探针（handshake / leaseStatus / pause / saveAck）复用同一槽位。
 * 3. 严格只读/无付费：modelCatalog 只读元数据，绝不发起 stream/模型调用。
 * 4. 真实结果判定：旧代次 saveAck 必须严格断言 STALE_RUNTIME 错误，不把失败当成功。
 * 5. 错误脱敏：不展示 token 等凭据，错误消息做安全截断。
 * 6. 有界超时与生命周期取消：
 *    - 单次远程 RPC 3000ms 强制超时，全轮具备合理的全局预算（15s），不误杀正常累积步进；
 *    - 完整支持 AbortSignal 取消机制，重测/卸载时立即中止旧轮次，杜绝迟到写入与租约串扰。
 */
export const DIAG_GAME_ID: "__gamecenter_diag__";
/** 单次远程调用的有界超时上限 (ms) */
export const RPC_TIMEOUT_MS: 3000;
/** 全轮诊断的合理全局超时上限 (ms) */
export const GLOBAL_TIMEOUT_MS: 15000;
export type DiagnosticRow = {
    key: string;
    label: string;
    status: "pending" | "ok" | "fail" | "warn" | "skip";
    value: string;
    detail?: string;
};
