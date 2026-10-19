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
export const PAUSE_TIMEOUT_MS = 3000;

/**
 * @typedef {'idle' | 'starting' | 'running' | 'pausing' | 'paused'
 *   | 'recovery-available' | 'finished' | 'destroyed'} RuntimeState
 */

/**
 * @typedef {object} RuntimeLease
 * @property {string} gameId 已安装版本的权威 gameId（不接受游戏自报值）
 * @property {string} saveId 存档身份
 * @property {string} runtimeInstanceId 本次运行实例 id
 * @property {string} nonce 一次性握手 nonce（销毁时清空）
 * @property {number} generation 运行代次
 * @property {RuntimeState} state
 * @property {boolean} inputOpen 是否接受游戏输入
 * @property {boolean} clockFrozen 虚拟时钟是否冻结
 * @property {number | null} pendingPauseGeneration 正在等待保存确认的代次
 * @property {number | null} lastRevision 最近一次成功保存的 revision
 * @property {number} pauseRequests 已受理的 requestPause 次数
 * @property {number | null} pausedAt 进入 paused/recovery 的时间戳
 * @property {boolean} portBound 专用 MessagePort 是否已建立
 * @property {Set<string>} inflight 已受理但未结算的 Bridge requestId
 */

/**
 * @typedef {object} PauseRequest
 * @property {string} reason 触发暂停的原因
 * @property {number} generation 发起暂停时的运行代次
 */

/**
 * @typedef {object} PauseOutcome
 * @property {'saved' | 'timeout' | 'crashed' | 'refused'} kind
 * @property {number} generation
 * @property {number | null} revision 保存确认后的存档 revision（仅 saved）
 * @property {string} message 面向玩家的说明；必须如实说明恢复位置
 */

/**
 * @typedef {object} RuntimeSnapshot
 * @property {RuntimeState} state
 * @property {number} generation
 * @property {boolean} inputOpen
 * @property {boolean} clockFrozen
 * @property {number | null} pendingPauseGeneration
 * @property {number | null} lastRevision
 * @property {number} pauseRequests
 */

/** 活跃期间允许调用 Bridge 的状态。 */
const ACTIVE_STATES = new Set(['starting', 'running']);

/**
 * @param {RuntimeState} state
 * @returns {boolean}
 */
function isActive(state) {
  return ACTIVE_STATES.has(state);
}

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
export function createRuntimeLease(init) {
  return {
    gameId: init.gameId,
    saveId: init.saveId,
    runtimeInstanceId: init.runtimeInstanceId,
    nonce: init.nonce,
    generation: init.generation ?? 1,
    state: 'starting',
    inputOpen: false,
    clockFrozen: true,
    pendingPauseGeneration: null,
    lastRevision: null,
    pauseRequests: 0,
    pausedAt: null,
    portBound: false,
    inflight: new Set(),
  };
}

/**
 * 输入与虚拟时钟解锁：只有握手成功且处于 active 状态才允许。
 *
 * @param {RuntimeLease} lease
 * @returns {boolean} 是否仍然处于可输入状态（false 表示调用方必须保持屏蔽）
 */
export function openInput(lease) {
  if (!isActive(lease.state)) return false;
  lease.state = 'running';
  lease.inputOpen = true;
  lease.clockFrozen = false;
  return true;
}

/**
 * 关闭路径的**唯一**收敛点：关闭、Escape、返回列表、租约失效都走这里。
 * 幂等：重复调用不会重复计数，也不会重置超时窗口。
 *
 * @param {RuntimeLease} lease
 * @param {{reason: string}} request
 * @returns {PauseRequest | null} 需要执行暂停流程时返回请求，否则 null
 */
export function requestPause(lease, request) {
  if (lease.state !== 'starting' && lease.state !== 'running') return null;
  lease.pauseRequests += 1;
  lease.state = 'pausing';
  lease.inputOpen = false;
  lease.clockFrozen = true;
  lease.pendingPauseGeneration = lease.generation;
  lease.pausedAt = null;
  return { reason: request.reason, generation: lease.generation };
}

/**
 * 保存确认：只有当前代次、且处于 pausing 的请求才能落地。
 * 旧代次的 saveAck 一律拒绝（基线 §8.3「拒绝旧 iframe 的迟到写入」）。
 *
 * @param {RuntimeLease} lease
 * @param {{generation: number, revision: number}} ack
 * @returns {PauseOutcome}
 */
export function completePause(lease, ack) {
  if (lease.state !== 'pausing' || lease.pendingPauseGeneration !== ack.generation) {
    return {
      kind: 'refused',
      generation: ack.generation,
      revision: null,
      message: '保存确认来自已失效的运行代次，已忽略。',
    };
  }
  lease.state = 'paused';
  lease.lastRevision = ack.revision;
  lease.pendingPauseGeneration = null;
  lease.pausedAt = Date.now();
  return {
    kind: 'saved',
    generation: ack.generation,
    revision: ack.revision,
    message: `已保存到检查点 r${ack.revision}，游戏已停止。`,
  };
}

/**
 * 暂停超时或运行实例崩溃：不再等待游戏，回落到最近检查点。
 * 必须如实告知玩家恢复位置（基线 §8.1、验收场景「游戏不响应 pause」）。
 *
 * @param {RuntimeLease} lease
 * @param {'timeout' | 'crashed'} kind
 * @returns {PauseOutcome}
 */
export function abandonPause(lease, kind) {
  if (lease.state !== 'pausing') {
    return {
      kind: 'refused',
      generation: lease.generation,
      revision: lease.lastRevision,
      message: '当前没有进行中的暂停。',
    };
  }
  const generation = lease.generation;
  lease.state = 'recovery-available';
  lease.pendingPauseGeneration = null;
  lease.pausedAt = Date.now();
  const where =
    lease.lastRevision === null ? '本次运行没有成功保存过检查点' : `最近一次成功保存为 r${lease.lastRevision}`;
  return {
    kind,
    generation,
    revision: lease.lastRevision,
    message:
      kind === 'timeout'
        ? `游戏在 ${String(PAUSE_TIMEOUT_MS)}ms 内没有响应保存请求，已终止运行。${where}，下次进入会从这里恢复。`
        : `游戏运行实例异常退出。${where}，下次进入会从这里恢复。`,
  };
}

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
export function admitBridgeCall(lease, envelope, allowedMethods) {
  if (!isActive(lease.state)) {
    return { allowed: false, code: 'PAUSED', message: '运行实例已进入暂停流程，不再接受新请求。' };
  }
  if (!lease.portBound) {
    return { allowed: false, code: 'PROTOCOL_INVALID', message: '专用 MessagePort 尚未建立。' };
  }
  if (envelope.generation !== lease.generation) {
    return { allowed: false, code: 'STALE_RUNTIME', message: '该请求来自已失效的运行代次。' };
  }
  if (!allowedMethods.includes(envelope.method)) {
    return { allowed: false, code: 'PROTOCOL_INVALID', message: `方法 ${envelope.method} 不在 Bridge 白名单内。` };
  }
  return { allowed: true };
}

/**
 * 销毁运行实例：清空所有持有的引用，便于泄漏测试断言。
 *
 * @param {RuntimeLease} lease
 */
export function destroyRuntime(lease) {
  lease.state = 'destroyed';
  lease.inputOpen = false;
  lease.clockFrozen = true;
  lease.pendingPauseGeneration = null;
  lease.inflight.clear();
  lease.portBound = false;
  lease.nonce = '';
}

/**
 * @param {RuntimeLease} lease
 * @returns {RuntimeSnapshot}
 */
export function snapshotRuntime(lease) {
  return {
    state: lease.state,
    generation: lease.generation,
    inputOpen: lease.inputOpen,
    clockFrozen: lease.clockFrozen,
    pendingPauseGeneration: lease.pendingPauseGeneration,
    lastRevision: lease.lastRevision,
    pauseRequests: lease.pauseRequests,
  };
}
