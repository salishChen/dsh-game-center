// @ts-check
/**
 * 专用 MessagePort Bridge 请求分发器与安全主管（基线 §6、§7、阶段1 P4 目标）。
 *
 * 核心安全机制（对应验收项 A9 游戏越权防御）：
 * 1. 白名单方法严格限制：不在 BRIDGE_METHODS 内的一律拒绝为 PROTOCOL_INVALID。
 * 2. 状态与代次拦截：暂停/已封存状态下所有新请求直接拒绝为 PAUSED；旧代次请求直接拒绝为 STALE_RUNTIME。
 * 3. 跨存档越权防御：请求试图指定或篡改 gameId/saveId 时严格拒绝为 PROTOCOL_INVALID。
 * 4. 频率限制：滑动窗口超限拒绝为 RATE_LIMITED，防止死循环轰炸宿主。
 * 5. 消息大小硬限制：超过 BRIDGE_MAX_MESSAGE_BYTES（256 KiB）直接拒绝为 MESSAGE_TOO_LARGE。
 * 6. 凭据绝对隔离：绝不向 MessagePort 发送任何宿主 token、Cordis ctx 或 DOM 对象。
 */

import {
  BRIDGE_METHODS,
  BRIDGE_MAX_MESSAGE_BYTES,
  createRateLimiter,
  parseInbound,
  outboundOk,
  outboundError,
} from './host-bridge.js';
import { admitBridgeCall, openInput, requestPause, completePause } from '../runtime/lease.js';
import { createGameCenterSDK } from '../sdk/index.js';

/**
 * @typedef {object} BridgeDispatcherOptions
 * @property {import('../runtime/lease.js').RuntimeLease} lease 运行实例租约
 * @property {MessagePort} [port] 通信端口（可选，若未提供可在 bindPort 后生效）
 * @property {readonly string[]} [allowedMethods] 允许的方法白名单（默认 BRIDGE_METHODS）
 * @property {ReturnType<typeof createRateLimiter>} [rateLimiter] 频率限制器
 * @property {(payload: any) => Promise<any> | any} [onAiGenerate] 处理 AI 生成（阶段1用 fixture）
 * @property {(payload: any) => Promise<any> | any} [onAiCancel] 处理 AI 取消
 * @property {(payload: any) => Promise<any> | any} [onWalletCommand] 钱包与工坊进度
 * @property {(payload: any) => Promise<any> | any} [onGameCommand] Host 权威牌局命令
 * @property {(payload: any) => Promise<any> | any} [onCheckpoint] 处理存档检查点
 * @property {string} [playerId] 宿主绑定的玩家身份（由 Host 注入，绝不取游戏自报值）
 * @property {(payload: any) => Promise<void> | void} [onReady] 处理准备就绪
 * @property {(payload: any) => Promise<void> | void} [onPauseAck] 处理暂停确认
 */

/**
 * 创建 Bridge 请求分发器。
 * @param {BridgeDispatcherOptions} options
 */
export function createBridgeDispatcher(options) {
  const { lease } = options;
  const allowedMethods = options.allowedMethods ?? BRIDGE_METHODS;
  const limiter = options.rateLimiter ?? createRateLimiter();
  /** @type {MessagePort | null} */
  let boundPort = options.port ?? null;
  /** @type {number | null} */
  let pauseSentGeneration = null;
  /**
   * 主题推送的单增序号（协议 host.push 信封的 `seq`）。
   * 游戏据此丢弃乱序/重复推送；每个 dispatcher 实例独立计数。
   */
  let themeSeq = 0;
  let controlSeq = 0;
  /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
  const controlPending = new Map();
  /** @param {'suspend' | 'resume'} action */
  function control(action) {
    if (!boundPort) return Promise.reject(new Error('游戏端口尚未就绪'));
    if (action === 'suspend') { lease.state = 'suspended'; lease.inputOpen = false; lease.clockFrozen = true; }
    const controlId = 'control-' + (++controlSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { controlPending.delete(controlId); reject(new Error('游戏暂停/恢复确认超时')); }, 3000);
      controlPending.set(controlId, {resolve, reject, timer});
      boundPort?.postMessage({type:'lifecycle:control', action, controlId, generation:lease.generation});
    });
  }
  /** 当前绑定的消息监听器；dispose 时用于精确解绑。 */
  /** @type {((eventOrData: any) => void) | null} */
  let currentListener = null;

  /**
   * 绑定通信 MessagePort，建立双向监听（兼顾浏览器与 Node.js Worker 端口）。
   * @param {MessagePort} port
   */
  function bindPort(port) {
    boundPort = port;
    lease.portBound = true;

    const onData = (/** @type {any} */ eventOrData) => {
      const data = eventOrData && typeof eventOrData === 'object' && 'data' in eventOrData ? eventOrData.data : eventOrData;
      void handleMessage(data);
    };
    // 记住监听器与端口，供 dispose() 精确解绑；否则端口会一直持有监听，
    // 事件循环无法退出（测试进程挂死、页面卸载后也不释放）。
    currentListener = onData;

    if (typeof /** @type {any} */ (port).on === 'function') {
      /** @type {any} */ (port).on('message', onData);
    } else if (typeof /** @type {any} */ (port).addEventListener === 'function') {
      /** @type {any} */ (port).addEventListener('message', onData);
    } else {
      port.onmessage = onData;
    }

    if (typeof port.start === 'function') {
      port.start();
    }
  }

  /**
   * 处理单条入站消息并分发。
   * @param {unknown} rawData
   */
  async function handleMessage(rawData) {
    if (!boundPort) return;

    // 1. 信封反序列化与结构基础校验
    const parsed = parseInbound(rawData);
    if (!parsed.ok) {
      const fallbackReqId =
        rawData && typeof rawData === 'object' && typeof /** @type {any} */ (rawData).requestId === 'string'
          ? /** @type {any} */ (rawData).requestId
          : 'unknown';
      boundPort.postMessage(outboundError(fallbackReqId, { code: parsed.code, message: parsed.message }));
      return;
    }

    const { requestId, method, payload } = parsed;
    if (method === 'lifecycle.controlAck') {
      const ack = /** @type {any} */ (payload);
      const pending = controlPending.get(ack?.controlId);
      if (pending && ack.generation === lease.generation) {
        clearTimeout(pending.timer); controlPending.delete(ack.controlId);
        if (ack.ok === true) pending.resolve(ack); else pending.reject(new Error(ack.message || '游戏暂停/恢复失败'));
      }
      return;
    }

    // 2. 状态、端口与运行代次准入检查
    const envelopeGen =
      payload && typeof payload === 'object' && typeof /** @type {any} */ (payload).generation === 'number'
        ? /** @type {any} */ (payload).generation
        : lease.generation;

    // lifecycle.pauseAck 是暂停流程的响应，在 pausing 状态下特许通过
    const isPauseAck = method === 'lifecycle.pauseAck';
    if (!isPauseAck) {
      const admission = admitBridgeCall(lease, { generation: envelopeGen, method }, allowedMethods);
      if (!admission.allowed) {
        boundPort.postMessage(
          outboundError(requestId, {
            code: admission.code || 'PROTOCOL_INVALID',
            message: admission.message || 'Bridge 请求被拒绝',
          }),
        );
        return;
      }
    }

    // 3. 频率限制检查
    if (!limiter.tryAcquire()) {
      boundPort.postMessage(
        outboundError(requestId, {
          code: 'RATE_LIMIT',
          message: '请求过于频繁，超出频率限制配额',
          retryable: true,
        }),
      );
      return;
    }

    // 4. 跨存档越权检查（A9 核心防御点：游戏不能指定或伪造非当前租约的 gameId / saveId）
    if (payload && typeof payload === 'object') {
      const obj = /** @type {any} */ (payload);
      if (typeof obj.gameId === 'string' && obj.gameId !== lease.gameId) {
        boundPort.postMessage(
          outboundError(requestId, {
            code: 'PROTOCOL_INVALID',
            message: '禁止跨游戏越权访问',
          }),
        );
        return;
      }
      if (typeof obj.saveId === 'string' && obj.saveId !== lease.saveId) {
        boundPort.postMessage(
          outboundError(requestId, {
            code: 'PROTOCOL_INVALID',
            message: '禁止跨存档越权访问',
          }),
        );
        return;
      }
    }

    // 5. 分发到具体业务方法
    try {
      if (method === 'wallet.command') {
        if (!options.onWalletCommand) throw new Error('钱包服务未就绪');
        const result = await options.onWalletCommand(payload);
        boundPort?.postMessage(outboundOk(requestId, result));
        return;
      }
      if (method === 'game.command') {
        if (!options.onGameCommand) throw new Error('Host 牌局服务未就绪');
        const result = await options.onGameCommand(payload);
        boundPort?.postMessage(outboundOk(requestId, result));
        return;
      }
      if (method === 'lifecycle.ready') {
        openInput(lease);
        if (options.onReady) await options.onReady(payload);
        boundPort.postMessage(outboundOk(requestId, { ready: true }));
        return;
      }

      if (method === 'save.checkpoint') {
        if (!options.onCheckpoint) {
          boundPort.postMessage(outboundError(requestId, { code: 'NOT_IMPLEMENTED', message: '未配置存档处理器' }));
          return;
        }

        // 校验可信宿主 playerId（若提供，杜绝空串降级；生产由 Host 绑定）
        if (options.playerId !== undefined && (typeof options.playerId !== 'string' || options.playerId.trim().length === 0)) {
          boundPort.postMessage(
            outboundError(requestId, {
              code: 'PROTOCOL_INVALID',
              message: '宿主未绑定可信 playerId，拒绝存档写入',
            }),
          );
          return;
        }

        const savePayload = payload && typeof payload === 'object' ? /** @type {any} */ (payload) : null;
        if (!savePayload) {
          boundPort.postMessage(
            outboundError(requestId, {
              code: 'PROTOCOL_INVALID',
              message: 'save.checkpoint 请求体必须为对象',
            }),
          );
          return;
        }

        // 校验 operationId 必填且非空
        if (typeof savePayload.operationId !== 'string' || savePayload.operationId.trim().length === 0) {
          boundPort.postMessage(
            outboundError(requestId, {
              code: 'PROTOCOL_INVALID',
              message: 'save.checkpoint 必须提供 operationId 幂等键',
            }),
          );
          return;
        }

        // 校验 expectedRevision 必填且为非负整数
        if (
          typeof savePayload.expectedRevision !== 'number' ||
          !Number.isInteger(savePayload.expectedRevision) ||
          savePayload.expectedRevision < 0
        ) {
          boundPort.postMessage(
            outboundError(requestId, {
              code: 'PROTOCOL_INVALID',
              message: 'save.checkpoint expectedRevision 必须为非负整数',
            }),
          );
          return;
        }

        const forwarded = {
          gameId: lease.gameId,
          saveId: lease.saveId,
          generation: lease.generation,
          activeGeneration: lease.generation,
          isSealed: Boolean(lease.state === 'paused' || lease.state === 'destroyed' || lease.state === 'recovery-available'),
          ...(typeof options.playerId === 'string' && options.playerId.trim().length > 0
            ? { playerId: options.playerId.trim() }
            : {}),
          operationId: savePayload.operationId.trim(),
          expectedRevision: savePayload.expectedRevision,
          state: savePayload.state ?? null,
          elapsedGameMs:
            typeof savePayload.elapsedGameMs === 'number' && savePayload.elapsedGameMs >= 0
              ? savePayload.elapsedGameMs
              : 0,
          rngState: typeof savePayload.rngState === 'string' ? savePayload.rngState : '',
          installedCommit: typeof savePayload.installedCommit === 'string' ? savePayload.installedCommit : 'current',
          gameStateSchemaVersion:
            typeof savePayload.gameStateSchemaVersion === 'number' ? savePayload.gameStateSchemaVersion : 1,
          modelBindings:
            savePayload.modelBindings && typeof savePayload.modelBindings === 'object'
              ? savePayload.modelBindings
              : {},
        };

        let saveRes;
        try {
          saveRes = await options.onCheckpoint(forwarded);
        } catch (procErr) {
          const err = /** @type {any} */ (procErr);
          boundPort.postMessage(
            outboundError(requestId, {
              code: err.code || 'INTERNAL_ERROR',
              message: err.message || '存档处理器执行异常',
              retryable: Boolean(err.retryable),
              currentRevision: err.currentRevision,
            }),
          );
          return;
        }

        const failureRes = /** @type {any} */ (saveRes);
        if (failureRes && typeof failureRes === 'object' && failureRes.ok === false) {
          boundPort.postMessage(
            outboundError(requestId, {
              code: failureRes.code || 'INTERNAL_ERROR',
              message: failureRes.message || '存档写入失败',
              retryable: Boolean(failureRes.retryable || failureRes.code === 'RATE_LIMIT'),
              currentRevision: failureRes.currentRevision,
            }),
          );
          return;
        }

        const nextRevision = typeof saveRes?.revision === 'number' ? saveRes.revision : (lease.lastRevision ?? 1);
        lease.lastRevision = nextRevision;
        boundPort.postMessage(
          outboundOk(requestId, {
            revision: nextRevision,
            idempotentReplay: Boolean(saveRes?.idempotentReplay),
          }),
        );
        return;
      }

      if (method === 'lifecycle.pauseAck') {
        const ackGen =
          payload && typeof payload === 'object' && typeof /** @type {any} */ (payload).generation === 'number'
            ? /** @type {any} */ (payload).generation
            : lease.generation;
        const ackRev =
          payload && typeof payload === 'object' && typeof /** @type {any} */ (payload).revision === 'number'
            ? /** @type {any} */ (payload).revision
            : lease.lastRevision ?? 1;

        const outcome = completePause(lease, { generation: ackGen, revision: ackRev });
        if (outcome.kind === 'refused') {
          if (boundPort) {
            boundPort.postMessage(outboundError(requestId, { code: 'STALE_RUNTIME', message: outcome.message }));
          }
          return;
        }
        try {
          if (options.onPauseAck) await options.onPauseAck({...(payload && typeof payload === 'object' ? payload : {}), generation:ackGen, revision:ackRev});
        } catch (error) {
          // Host did not confirm persistence: leave the pending close eligible for timeout recovery.
          lease.state = 'pausing'; lease.pendingPauseGeneration = ackGen;
          throw error;
        }
        if (boundPort) {
          boundPort.postMessage(outboundOk(requestId, { acknowledged: true, state: lease.state }));
        }
        return;
      }

      if (method === 'ai.generate') {
        if (!options.onAiGenerate) {
          // 【不再伪造成功 · 2026-10-21】此前这里直接回一条 fixture 文本
          // `AI生成对局完成（阶段1 fixture）`。游戏侧按自己的 schema 校验必然失败，
          // 于是静默降级成本地生成，玩家看到的是"AI 没连上/直接报错"——假成功掩盖了
          // 真实断点。没有转发实现时必须**明确失败**，游戏据此提示重试或改玩经典模式。
          if (boundPort) {
            boundPort.postMessage(
              outboundError(requestId, {
                code: 'CAPABILITY_UNAVAILABLE',
                message: 'AI 生成暂不可用：未装配 Host aiGenerate 转发',
                retryable: false,
              }),
            );
          }
          return;
        }
        const aiRes = await options.onAiGenerate(payload);
        if (boundPort) {
          boundPort.postMessage(outboundOk(requestId, aiRes));
        }
        return;
      }

      if (method === 'ai.cancel') {
        if (options.onAiCancel) await options.onAiCancel(payload);
        if (boundPort) {
          boundPort.postMessage(outboundOk(requestId, { cancelled: true }));
        }
        return;
      }

      // 未知方法已在前面被 parseInbound 或 admitBridgeCall 拦截，此处为逻辑完备兜底
      if (boundPort) {
        boundPort.postMessage(outboundError(requestId, { code: 'PROTOCOL_INVALID', message: `未支持的方法: ${method}` }));
      }
    } catch (procErr) {
      if (!boundPort) return;
      const err = /** @type {any} */ (procErr);
      boundPort.postMessage(
        outboundError(requestId, {
          code: err.code || 'INTERNAL_ERROR',
          message: err.message || 'Bridge 内部处理失败',
        }),
      );
    }
  }

  /**
   * 触发宿主侧暂停流程，向游戏端口发送 pause 信号并冻结时钟与输入。
   * @param {{ reason: string }} param0
   */
  function triggerPause({ reason }) {
    const pauseReq = requestPause(lease, { reason });
    if (!pauseReq && !(lease.state === 'pausing' && lease.pendingPauseGeneration === lease.generation)) return false;
    if (pauseSentGeneration === lease.generation) return false;
    pauseSentGeneration = lease.generation;
    if (boundPort) {
      boundPort.postMessage({
        type: 'lifecycle:pause',
        generation: lease.generation,
        reason,
      });
    }
    return true;
  }

  /**
   * 经**已配对的 MessagePort** 下发主题（v3）。
   *
   * 【为什么必须走这条 port】主题是玩家可见状态，若监听 window 的 theme-change
   * 字符串消息，任意同页脚本都能伪造，把游戏刷成错误配色。这条 port 是握手
   * （event.source + nonce + runtimeInstanceId 三者校验通过）之后才建立的，
   * 来源天然可信，因此主题只从这里下发。
   *
   * 【信封格式：协议唯一契约】`{ kind:'host.push', event:'theme', seq, payload:{ mode, source } }`。
   * 与游戏 SDK 共用同一格式，不再各建一套；`seq` 单增，游戏据此丢弃乱序/重复。
   * `source`：'dsh' = DSH 显式主题（**优先于 OS 偏好**）；'os' = 无显式主题时回落 OS。
   *
   * @param {'dark' | 'light'} mode
   * @param {'dsh' | 'os'} [source]
   * @returns {boolean} 是否成功下发
   */
  function sendTheme(mode, source = 'dsh') {
    if (mode !== 'dark' && mode !== 'light') return false;
    if (source !== 'dsh' && source !== 'os') return false;
    if (!boundPort) return false;
    themeSeq += 1;
    boundPort.postMessage({
      kind: 'host.push',
      event: 'theme',
      seq: themeSeq,
      payload: { mode, source },
    });
    return true;
  }

  /**
   * 解绑端口并释放监听器。
   *
   * 为什么必须有：端口若仍持有 'message' 监听，Node 的事件循环不会退出
   * （表现为测试进程挂死）；浏览器侧则是关闭弹层后仍留着引用，泄漏到下次运行。
   * 释放后 `lease.portBound` 置 false，后续入站消息不再被处理。
   */
  function dispose() {
    for (const pending of controlPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('游戏已关闭')); }
    controlPending.clear();
    const port = boundPort;
    const listener = currentListener;
    if (port && listener) {
      if (typeof /** @type {any} */ (port).off === 'function') {
        /** @type {any} */ (port).off('message', listener);
      } else if (typeof /** @type {any} */ (port).removeEventListener === 'function') {
        /** @type {any} */ (port).removeEventListener('message', listener);
      } else if (/** @type {any} */ (port).onmessage === listener) {
        /** @type {any} */ (port).onmessage = null;
      }
    }
    currentListener = null;
    boundPort = null;
    lease.portBound = false;
  }

  if (options.port) {
    bindPort(options.port);
  }

  return {
    bindPort,
    handleMessage,
    triggerPause,
    control,
    sendTheme,
    dispose,
  };
}

/**
 * @typedef {object} ConnectSDKToDispatcherOptions
 * @property {import('../runtime/lease.js').RuntimeLease} lease 运行实例租约
 * @property {string} playerId 宿主可信玩家身份
 * @property {string | number} [initialSeed] 初始随机数种子
 * @property {string} [initialRngState] 恢复时已有的随机数状态
 * @property {number} [initialElapsedMs] 初始累计游戏毫秒
 * @property {number} [initialRevision] 恢复时已有的基准 revision
 * @property {(payload: any) => Promise<any> | any} [onWalletCommand] 钱包与工坊进度
 * @property {(payload: any) => Promise<any> | any} [onGameCommand] Host 权威牌局命令
 * @property {(payload: any) => Promise<{ ok?: boolean, revision?: number, idempotentReplay?: boolean, code?: string, message?: string }> | any} onCheckpoint 存档检查点处理回调（可直连 SaveStore.writeCheckpoint）
 * @property {(payload: any) => Promise<any> | any} [onAiGenerate] 处理 AI 生成
 * @property {(payload: any) => Promise<any> | any} [onAiCancel] 处理 AI 取消
 * @property {(payload: any) => Promise<void> | void} [onReady] 处理准备就绪
 * @property {(payload: any) => Promise<void> | void} [onPauseAck] 处理暂停确认
 */

/**
 * 建立专用双向 MessageChannel，将 SDK 实例与 BridgeDispatcher 无缝直连。
 * 驱动真实 MessagePort 链路：SDK.save.checkpoint -> dispatcher -> 宿主存储 -> SDK 回执。
 * 提供生命周期安全清理（dispose），确保在 Node 与浏览器下端口、监听器与计时器完全释放。
 *
 * @param {ConnectSDKToDispatcherOptions} options
 */
export function connectSDKToDispatcher(options) {
  const channel = new MessageChannel();
  const sdk = createGameCenterSDK({
    port: channel.port1,
    initialSeed: options.initialSeed,
    initialRngState: options.initialRngState,
    initialElapsedMs: options.initialElapsedMs,
    initialRevision: options.initialRevision,
  });

  /** @type {BridgeDispatcherOptions} */
  const dispatcherOpts = {
    lease: options.lease,
    port: channel.port2,
    playerId: options.playerId,
    onCheckpoint: options.onCheckpoint,
  };
  if (options.onAiGenerate !== undefined) dispatcherOpts.onAiGenerate = options.onAiGenerate;
  if (options.onAiCancel !== undefined) dispatcherOpts.onAiCancel = options.onAiCancel;
  if (options.onWalletCommand !== undefined) dispatcherOpts.onWalletCommand = options.onWalletCommand;
  if (options.onGameCommand !== undefined) dispatcherOpts.onGameCommand = options.onGameCommand;
  if (options.onReady !== undefined) dispatcherOpts.onReady = options.onReady;
  if (options.onPauseAck !== undefined) dispatcherOpts.onPauseAck = options.onPauseAck;

  const dispatcher = createBridgeDispatcher(dispatcherOpts);

  return {
    sdk,
    dispatcher,
    port1: channel.port1,
    port2: channel.port2,
    dispose: () => {
      dispatcher.dispose();
      // @ts-expect-error internal dispose
      if (typeof sdk.disposeInternal === 'function') {
        // @ts-expect-error internal dispose
        sdk.disposeInternal();
      }
      try {
        if (typeof channel.port1.close === 'function') channel.port1.close();
      } catch {}
      try {
        if (typeof channel.port2.close === 'function') channel.port2.close();
      } catch {}
    },
  };
}
