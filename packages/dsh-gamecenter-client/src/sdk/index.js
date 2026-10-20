// @ts-check
/**
 * 游戏中心统一小游戏客户端 SDK v1（基线 §6、阶段1 P4 目标）。
 *
 * 核心边界与安全约束（强制红线）：
 * 1. 游戏运行在沙箱 iframe 内，仅通过专用 MessagePort 与父窗口 Bridge 通信。
 * 2. 仅暴露白名单能力：ai.generate/ai.cancel、save.checkpoint、lifecycle、clock、random、assets。
 * 3. 绝不暴露任何 DSH 宿主对象：无 Cordis ctx、无主 DOM、无通用 RPC、无文件系统/API key/Git token。
 * 4. 严禁向游戏端下发任何运行时控制凭据（runtimeToken），游戏对底层鉴权完全无感。
 * 5. 本阶段 ai.generate 禁止发起真实模型调用（由 Bridge 返回确定性 fixture 结果）。
 */

import { createSeededRandom } from './random.js';
import { createGameClock } from './clock.js';

/**
 * @typedef {object} GameMessage
 * @property {'system' | 'user' | 'assistant'} role
 * @property {string} text
 * @property {string[]} [assetIds]
 */

/**
 * @typedef {object} AiGenerateRequest
 * @property {string} slot
 * @property {string} [operation]
 * @property {string} operationId 幂等操作 ID
 * @property {GameMessage[]} messages
 * @property {Record<string, unknown>} [responseSchema]
 */

/**
 * @typedef {object} LifecycleHooks
 * @property {() => Promise<unknown> | unknown} pause
 * @property {(snapshot: unknown) => Promise<void> | void} [restore]
 * @property {() => Promise<void> | void} [resume]
 */

/**
 * 创建小游戏 SDK 实例。
 *
 * @param {object} options
 * @param {MessagePort} options.port 专用的双向通信 MessagePort
 * @param {string | number} [options.initialSeed] 初始伪随机数种子
 * @param {string} [options.initialRngState] 恢复运行时的已有伪随机数状态（优先于 initialSeed）
 * @param {number} [options.initialElapsedMs] 初始累计游戏毫秒
 * @param {number} [options.initialRevision] 恢复运行时已有的基准 revision（作为后续 checkpoint 的 expectedRevision）
 */
export function createGameCenterSDK(options) {
  const { port } = options;
  if (!port || typeof port.postMessage !== 'function') {
    throw new Error('GameCenterSDK 必须由有效的 MessagePort 初始化');
  }

  const clock = createGameClock({ initialElapsedMs: options.initialElapsedMs });
  const random = createSeededRandom(options.initialSeed ?? 1);
  if (typeof options.initialRngState === 'string' && options.initialRngState.length > 0) {
    random.setState(options.initialRngState);
  }

  /** @type {Map<string, { resolve: (val: any) => void, reject: (err: any) => void }>} */
  const pendingRequests = new Map();

  /** @type {LifecycleHooks | null} */
  let lifecycleHooks = null;

  /** 最近一次成功保存的 revision；作为下一次 checkpoint 的 expectedRevision。 */
  let lastKnownRevision =
    typeof options.initialRevision === 'number' && options.initialRevision >= 0
      ? options.initialRevision
      : 0;

  /** 最近一次尝试的 operationId 与 expectedRevision（用于重试时复用）。 */
  /** @type {string | null} */
  let lastAttemptedOperationId = null;
  /** @type {number} */
  let lastAttemptedExpectedRevision = lastKnownRevision;

  /** 动作序号发生器：同一 SDK 实例内，每个新动作自增，确保不同动作拥有不同 operationId */
  let actionSeq = 0;
  const sdkInstanceId = Math.random().toString(36).slice(2, 10);

  /**
   * 记录每个 operationId 首次发送时的完整载荷（快照/时间/RNG/expectedRevision）。
   * 用于重试时复用，消除由于虚拟时钟持续运行导致的重试载荷漂移。
   * @type {Map<string, { state: unknown, elapsedGameMs: number, rngState: string, expectedRevision: number }>}
   */
  const operationPayloadCache = new Map();

  let reqSeq = 0;
  function nextRequestId() {
    reqSeq += 1;
    return `req-${Date.now().toString(36)}-${reqSeq}`;
  }

  /**
   * 通过 MessagePort 发送受控信封请求。
   *
   * @param {string} method 白名单方法名
   * @param {unknown} payload
   * @returns {Promise<any>}
   */
  function sendRequest(method, payload) {
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId();
      pendingRequests.set(requestId, { resolve, reject });

      try {
        port.postMessage({
          bridgeVersion: 1,
          requestId,
          method,
          payload: payload ?? {},
        });
      } catch (postErr) {
        pendingRequests.delete(requestId);
        const err = new Error(`MessagePort 发送失败: ${postErr instanceof Error ? postErr.message : String(postErr)}`);
        /** @type {any} */ (err).code = 'COMMUNICATION_ERROR';
        reject(err);
      }
    });
  }

  // 监听来自宿主 Bridge 的响应或生命周期指令（兼顾浏览器与 Node.js Worker 端口）
  const onIncoming = (/** @type {any} */ eventOrData) => {
    const data = eventOrData && typeof eventOrData === 'object' && 'data' in eventOrData ? eventOrData.data : eventOrData;
    if (!data || typeof data !== 'object') return;

    // 1. 处理 RPC 响应
    if (typeof data.requestId === 'string') {
      const handler = pendingRequests.get(data.requestId);
      if (handler) {
        pendingRequests.delete(data.requestId);
        if (data.ok === true) {
          handler.resolve(data.payload);
        } else {
          const errObj = data.error || {};
          const err = new Error(errObj.message || 'Bridge 请求失败');
          /** @type {any} */ (err).code = errObj.code || 'UNKNOWN';
          /** @type {any} */ (err).retryable = Boolean(errObj.retryable);
          /** @type {any} */ (err).currentRevision = errObj.currentRevision;
          handler.reject(err);
        }
      }
      return;
    }

    // 2. 处理宿主主动下发的生命周期指令（例如要求暂停或恢复）
    if (data.type === 'lifecycle:pause') {
      clock.pause();
      const generation = Number(data.generation) || 0;
      void (async () => {
        try {
          let snapshot = null;
          if (lifecycleHooks && typeof lifecycleHooks.pause === 'function') {
            snapshot = await lifecycleHooks.pause();
          }
          // 暂停成功后发送 pauseAck，由宿主确认并封存代次
          port.postMessage({
            bridgeVersion: 1,
            requestId: nextRequestId(),
            method: 'lifecycle.pauseAck',
            payload: {
              generation,
              revision: lastKnownRevision,
              snapshot: snapshot ?? {},
              elapsedGameMs: clock.getElapsedMs(),
              rngState: random.getState(),
            },
          });
        } catch (hookErr) {
          console.error('[GameCenterSDK] lifecycle.pause 钩子执行异常:', hookErr);
        }
      })();
      return;
    }

    if (data.type === 'lifecycle:resume') {
      clock.resume();
      if (lifecycleHooks && typeof lifecycleHooks.resume === 'function') {
        void lifecycleHooks.resume();
      }
    }
  };

  if (typeof /** @type {any} */ (port).on === 'function') {
    /** @type {any} */ (port).on('message', onIncoming);
  } else if (typeof /** @type {any} */ (port).addEventListener === 'function') {
    /** @type {any} */ (port).addEventListener('message', onIncoming);
  } else {
    port.onmessage = onIncoming;
  }

  if (typeof port.start === 'function') {
    port.start();
  }

  /**
   * 解绑端口并清空未完成请求。
   *
   * 与 dispatcher.dispose() 对称：游戏结束/弹层关闭时必须调用，
   * 否则端口仍持有 'message' 监听，Node 事件循环不退出、浏览器侧引用泄漏。
   * 未完成的请求一律以 `DISPOSED` 拒绝，避免调用方永久等待。
   */
  function dispose() {
    if (typeof /** @type {any} */ (port).off === 'function') {
      /** @type {any} */ (port).off('message', onIncoming);
    } else if (typeof /** @type {any} */ (port).removeEventListener === 'function') {
      /** @type {any} */ (port).removeEventListener('message', onIncoming);
    } else if (port.onmessage === onIncoming) {
      port.onmessage = null;
    }
    if (typeof port.close === 'function') {
      port.close();
    }
    for (const [, handler] of pendingRequests) {
      const err = new Error('SDK 已释放，未完成的请求被取消');
      /** @type {any} */ (err).code = 'DISPOSED';
      handler.reject(err);
    }
    pendingRequests.clear();
  }

  const sdkApi = {
    ai: {
      /**
       * 请求 AI 生成（阶段1返回 fixture 数据，禁止真实付费调用）。
       * @param {AiGenerateRequest} request
       * @returns {Promise<any>}
       */
      generate(request) {
        if (!request || !request.slot || !request.operationId) {
          return Promise.reject(new Error('ai.generate 必须提供 slot 与 operationId'));
        }
        return sendRequest('ai.generate', request);
      },
      /**
       * 取消进行中的 AI 操作。
       * @param {{ operationId: string }} request
       */
      cancel(request) {
        if (!request || !request.operationId) {
          return Promise.reject(new Error('ai.cancel 必须提供 operationId'));
        }
        return sendRequest('ai.cancel', request);
      },
    },
    save: {
      /**
       * 请求保存检查点。
       *
       * 契约（packages/protocol/src/checkpoint.ts `CheckpointRequest`）：
       * - `operationId`：本次保存动作的幂等键。重试必须复用同一个值；不同动作同状态产生不同 ID。
       * - `expectedRevision`：调用方期望的基准 revision，首次传 0 或初始 revision，
       *   之后传上次成功返回的 revision；不匹配时宿主返回 STALE_RUNTIME。
       * - `retry`：布尔值，指定为 true 时表示重试上一次失败的保存动作，自动复用上一次的 operationId 与 expectedRevision。
       *
       * @param {unknown} gameState 游戏不透明状态
       * @param {{ operationId?: string, expectedRevision?: number, retry?: boolean, isRetry?: boolean }} [opts]
       * @returns {Promise<{ revision: number, idempotentReplay?: boolean, operationId: string }>}
       */
      async checkpoint(gameState, opts) {
        let operationId = '';
        const isRetry = Boolean(opts?.retry || opts?.isRetry);

        if (typeof opts?.operationId === 'string' && opts.operationId.trim().length > 0) {
          operationId = opts.operationId.trim();
        } else if (isRetry && typeof lastAttemptedOperationId === 'string') {
          operationId = lastAttemptedOperationId;
        } else {
          // 新动作：严格生成单调唯一的 operationId，保证不同动作同状态产生不同 ID
          actionSeq += 1;
          operationId = `act-${sdkInstanceId}-${actionSeq}`;
        }

        const cached = operationPayloadCache.get(operationId);

        let state;
        let elapsedGameMs;
        let rngState;
        let expectedRevision;

        if (cached && (isRetry || opts?.operationId === operationId)) {
          // 重试同一逻辑请求：复用首次发送的快照、时间、RNG 与 expectedRevision，避免时钟偷跑导致载荷漂移。
          // 若调用方显式传入了不同 state，则使用传入的 state（由宿主 SaveStore 判定为同 op 不同内容并严格拒绝）。
          state = gameState !== undefined ? (gameState ?? null) : cached.state;
          elapsedGameMs = cached.elapsedGameMs;
          rngState = cached.rngState;
          expectedRevision =
            typeof opts?.expectedRevision === 'number' ? opts.expectedRevision : cached.expectedRevision;
        } else {
          state = gameState ?? null;
          elapsedGameMs = clock.getElapsedMs();
          rngState = random.getState();
          expectedRevision =
            typeof opts?.expectedRevision === 'number' ? opts.expectedRevision : lastKnownRevision;
          operationPayloadCache.set(operationId, { state, elapsedGameMs, rngState, expectedRevision });
          if (operationPayloadCache.size > 64) {
            const firstKey = operationPayloadCache.keys().next().value;
            if (firstKey) operationPayloadCache.delete(firstKey);
          }
        }

        lastAttemptedOperationId = operationId;
        lastAttemptedExpectedRevision = expectedRevision;

        let result;
        try {
          result = await sendRequest('save.checkpoint', {
            operationId,
            expectedRevision,
            state,
            elapsedGameMs,
            rngState,
          });
        } catch (err) {
          const e = /** @type {any} */ (err);
          e.operationId = operationId;
          e.expectedRevision = expectedRevision;
          throw e;
        }

        if (result && typeof result.revision === 'number') {
          lastKnownRevision = result.revision;
        }
        return {
          ...result,
          operationId,
        };
      },
    },
    lifecycle: {
      /**
       * 通知平台游戏已加载完成并准备就绪。
       * 宿主收到后解锁时钟与输入。
       */
      ready() {
        clock.resume();
        return sendRequest('lifecycle.ready', {});
      },
      /**
       * 注册小游戏自身的暂停与恢复钩子。
       * @param {LifecycleHooks} hooks
       */
      register(hooks) {
        lifecycleHooks = hooks;
      },
    },
    clock,
    random,
    assets: {
      /**
       * 资产安全引用解析（游戏只能引用自身包内的相对路径或资产 ID）。
       * @param {string} assetId
       * @returns {string}
       */
      resolve(assetId) {
        if (typeof assetId !== 'string' || assetId.includes('..') || assetId.startsWith('/')) {
          throw new Error('非法资产路径，禁止路径逃逸');
        }
        return assetId;
      },
    },
  };

  // 宿主侧释放入口：不可枚举，游戏侧 Object.keys(sdk) 看不到，白名单断言不受影响。
  Object.defineProperty(sdkApi, 'disposeInternal', {
    value: dispose,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return sdkApi;
}

export { createSeededRandom } from './random.js';
export { createGameClock } from './clock.js';

/**
 * 创建 SDK 并返回 `{ sdk, dispose }`。
 *
 * 为什么把 dispose 与 sdk 分开：SDK 表面是**游戏可见的白名单**（ai/save/lifecycle/clock/
 * random/assets），`dispose` 属于宿主侧生命周期管理，不能混进白名单对象，
 * 否则"仅暴露受限能力"的安全断言会被破坏，游戏也可能自己调用 dispose 干扰宿主。
 *
 * @param {{ port: MessagePort, initialSeed?: string | number, initialRngState?: string, initialElapsedMs?: number, initialRevision?: number }} options
 */
export function createGameCenterSDKWithDispose(options) {
  const sdk = createGameCenterSDK(options);
  // disposeInternal 是 defineProperty 挂上的不可枚举方法，JSDoc 推导不到，这里显式取用。
  const internal = /** @type {{ disposeInternal: () => void }} */ (/** @type {unknown} */ (sdk));
  return { sdk, dispose: internal.disposeInternal };
}

/**
 * 无显式 operationId 时，由「状态内容 + 虚拟时间 + RNG」派生一个稳定 ID。
 *
 * 目的：同一状态的重试必须得到同一个 ID（否则重试会被当成新动作，多写一条检查点），
 * 而不同状态必须得到不同 ID。用 JSON 的稳定哈希即可，不需要密码学强度——
 * 它只是幂等键的一部分，真正防篡改靠宿主的摘要与审批。
 *
 * @param {unknown} state
 * @param {number} elapsedGameMs
 * @param {string} rngState
 * @returns {string}
 */
export function computeAutoOperationId(state, elapsedGameMs, rngState) {
  const payload = JSON.stringify({ state: state ?? null, elapsedGameMs, rngState });
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `auto-${(hash >>> 0).toString(16)}-${payload.length.toString(16)}`;
}
