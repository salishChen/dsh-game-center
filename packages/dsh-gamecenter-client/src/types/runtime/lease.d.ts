/**
 * 新建一个运行实例登记。
 *
 * @param {object} init
 * @param {string} init.gameId
 * @param {string} init.saveId
 * @param {string} init.runtimeInstanceId
 * @param {string} init.nonce 一次性握手 nonce（URL 片段传递，不进日志）
 * @param {number} [init.generation]
 * @returns {RuntimeLease}
 */
export function createRuntimeLease(init: {
    gameId: string;
    saveId: string;
    runtimeInstanceId: string;
    nonce: string;
    generation?: number | undefined;
}): RuntimeLease;
/**
 * 输入与虚拟时钟解锁：只有握手成功且处于 active 状态才允许。
 *
 * @param {RuntimeLease} lease
 * @returns {boolean} 是否仍然处于可输入状态（false 表示调用方必须保持屏蔽）
 */
export function openInput(lease: RuntimeLease): boolean;
/**
 * 关闭路径的**唯一**收敛点：关闭、Escape、返回列表、租约失效都走这里。
 * 幂等：重复调用不会重复计数，也不会重置超时窗口。
 *
 * @param {RuntimeLease} lease
 * @param {{reason: string}} request
 * @returns {PauseRequest | null} 需要执行暂停流程时返回请求，否则 null
 */
export function requestPause(lease: RuntimeLease, request: {
    reason: string;
}): PauseRequest | null;
/**
 * 保存确认：只有当前代次、且处于 pausing 的请求才能落地。
 * 旧代次的 saveAck 一律拒绝（基线 §8.3「拒绝旧 iframe 的迟到写入」）。
 *
 * @param {RuntimeLease} lease
 * @param {{generation: number, revision: number}} ack
 * @returns {PauseOutcome}
 */
export function completePause(lease: RuntimeLease, ack: {
    generation: number;
    revision: number;
}): PauseOutcome;
/**
 * 暂停超时或运行实例崩溃：不再等待游戏，回落到最近检查点。
 * 必须如实告知玩家恢复位置（基线 §8.1、验收场景「游戏不响应 pause」）。
 *
 * @param {RuntimeLease} lease
 * @param {'timeout' | 'crashed'} kind
 * @returns {PauseOutcome}
 */
export function abandonPause(lease: RuntimeLease, kind: "timeout" | "crashed"): PauseOutcome;
/**
 * @typedef {object} BridgeAdmission
 * @property {boolean} allowed
 * @property {string} [code]
 * @property {string} [message]
 */
/**
 * Bridge 请求准入：白名单 + 状态 + 代次。
 *
 * @param {RuntimeLease} lease
 * @param {{generation: number, method: string}} envelope
 * @param {readonly string[]} allowedMethods
 * @returns {BridgeAdmission}
 */
export function admitBridgeCall(lease: RuntimeLease, envelope: {
    generation: number;
    method: string;
}, allowedMethods: readonly string[]): BridgeAdmission;
/**
 * 销毁运行实例：清空所有持有的引用，便于泄漏测试断言。
 *
 * @param {RuntimeLease} lease
 */
export function destroyRuntime(lease: RuntimeLease): void;
/**
 * @param {RuntimeLease} lease
 * @returns {RuntimeSnapshot}
 */
export function snapshotRuntime(lease: RuntimeLease): RuntimeSnapshot;
/**
 * 运行代次与控制租约（基线 §7、§8.1、§8.3、§8.4）。
 *
 * 【拟新增协议，不是 DSH 既有 API】
 *
 * 本模块只做**纯状态判定**，不碰 DOM、不碰计时器，便于 node --test 直接验证：
 * - 每次运行一个 `generation`；旧代次（iframe 迟到消息）一律拒绝。
 * - `requestPause()` 是**唯一**关闭/切走/到期的入口；进入 Pausing 后立即
 *   拒绝新请求，并屏蔽输入、冻结虚拟时钟、暂停音频。
 * - 暂停超时（默认 3000ms，产品目标，见基线 §8.1）后不再等待游戏，
 *   销毁实例并回落到“最近检查点”状态，由界面如实告知恢复位置。
 */
/** 暂停目标（产品目标，非硬性协议常量；实测后可由 Host 配置覆盖）。 */
export const PAUSE_TIMEOUT_MS: 3000;
export type BridgeAdmission = {
    allowed: boolean;
    code?: string;
    message?: string;
};
export type RuntimeState = "idle" | "starting" | "running" | "pausing" | "paused" | "recovery-available" | "finished" | "destroyed";
export type RuntimeLease = {
    /**
     * 已安装版本的权威 gameId（不接受游戏自报值）
     */
    gameId: string;
    /**
     * 存档身份
     */
    saveId: string;
    /**
     * 本次运行实例 id
     */
    runtimeInstanceId: string;
    /**
     * 一次性握手 nonce（销毁时清空）
     */
    nonce: string;
    /**
     * 运行代次
     */
    generation: number;
    state: RuntimeState;
    /**
     * 是否接受游戏输入
     */
    inputOpen: boolean;
    /**
     * 虚拟时钟是否冻结
     */
    clockFrozen: boolean;
    /**
     * 正在等待保存确认的代次
     */
    pendingPauseGeneration: number | null;
    /**
     * 最近一次成功保存的 revision
     */
    lastRevision: number | null;
    /**
     * 已受理的 requestPause 次数
     */
    pauseRequests: number;
    /**
     * 进入 paused/recovery 的时间戳
     */
    pausedAt: number | null;
    /**
     * 专用 MessagePort 是否已建立
     */
    portBound: boolean;
    /**
     * 已受理但未结算的 Bridge requestId
     */
    inflight: Set<string>;
};
export type PauseRequest = {
    /**
     * 触发暂停的原因
     */
    reason: string;
    /**
     * 发起暂停时的运行代次
     */
    generation: number;
};
export type PauseOutcome = {
    kind: "saved" | "timeout" | "crashed" | "refused";
    generation: number;
    /**
     * 保存确认后的存档 revision（仅 saved）
     */
    revision: number | null;
    /**
     * 面向玩家的说明；必须如实说明恢复位置
     */
    message: string;
};
export type RuntimeSnapshot = {
    state: RuntimeState;
    generation: number;
    inputOpen: boolean;
    clockFrozen: boolean;
    pendingPauseGeneration: number | null;
    lastRevision: number | null;
    pauseRequests: number;
};
