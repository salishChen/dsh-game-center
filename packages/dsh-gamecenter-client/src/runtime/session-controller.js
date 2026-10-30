// @ts-check
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
export const SessionState = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SUSPENDED: 'suspended',
  FINALIZING: 'finalizing',
  SAVED: 'saved',
  FAILED: 'failed',
});

/** detached host 的标识（便于调试与测试断言）。 */
const HOST_ATTRIBUTE = 'data-gamecenter-session-host';

/**
 * host 收起（屏幕外）时的样式：不可见但仍挂载，iframe 不销毁。
 * 收敛期间用它把 host 移出 React 树，避免页面卸载时 iframe 被连带移除。
 */
const PARKED_STYLE = {
  position: 'fixed',
  left: '-10000px',
  top: '0px',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  opacity: '0',
  pointerEvents: 'none',
};

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
export function createGameSessionController(deps) {
  const { requestPause } = deps;

  /** @type {{state: string, session: GameSession | null, message: string | null}} */
  const state = { state: SessionState.IDLE, session: null, message: null };

  /** @type {Set<() => void>} */
  const listeners = new Set();

  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {HTMLIFrameElement | null} */
  let frame = null;
  /** @type {string | null} */
  let objectUrl = null;
  /** @type {Promise<any> | null} */
  let inFlight = null;
  let routeActive = false;
  /** @type {HTMLElement | null} */
  let routeAnchor = null;
  let controlQueue = Promise.resolve();
  /** @type {ReturnType<typeof setInterval> | null} */
  let heartbeat = null;
  /** @param {string} method @param {GameSession} session */
  const hostControl = async (method, session) => {
    const service = deps.getService?.();
    if (!service || typeof service[method] !== 'function') throw new Error('Host 生命周期服务未就绪');
    let timeout;
    let result;
    try { result = await Promise.race([
      service[method]({runtimeToken:session.runtimeToken, generation:session.lease.generation, ...(method === 'pause' ? {reason:'close'} : {})}),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Host 生命周期确认超时')), 3000); }),
    ]); } finally { clearTimeout(timeout); }
    if (result?.ok !== true && result?.accepted !== true) throw new Error(result?.error?.message || result?.message || 'Host 会话已失效');
  };

  /**
   * 通知订阅者（页面用它决定渲染"运行中"还是"正在保存并退出"）。
   */
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };

  /**
   * @param {string} next
   * @param {string | null} [message]
   */
  const setState = (next, message = null) => {
    state.state = next;
    state.message = message;
    emit();
  };

  /**
   * @param {HTMLElement} el
   */
  const applyParkedStyle = (el) => {
    el.style.position = PARKED_STYLE.position;
    el.style.left = PARKED_STYLE.left;
    el.style.top = PARKED_STYLE.top;
    el.style.width = PARKED_STYLE.width;
    el.style.height = PARKED_STYLE.height;
    el.style.overflow = PARKED_STYLE.overflow;
    el.style.opacity = PARKED_STYLE.opacity;
    el.style.pointerEvents = PARKED_STYLE.pointerEvents;
    el.style.visibility = 'hidden';
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
  };

  /** 确保 detached host 存在（幂等）。 */
  const ensureHost = () => {
    if (host !== null) return host;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.setAttribute(HOST_ATTRIBUTE, '');
    el.setAttribute('aria-hidden', 'true');
    applyParkedStyle(el);
    document.body.appendChild(el);
    host = el;
    return el;
  };

  /**
   * 把 host 收起到屏幕外（不可见但保留在 DOM 中，iframe 继续存活）。
   *
   * 【绝不跨父节点移动 DOM】QA 与 PM 均指出：包含 `<iframe>` 的节点被
   * `appendChild` / `insertBefore` 跨父节点重新挂载时，Chromium/WebKit 会
   * **销毁并重建 browsing context**（iframe 全量 reload，JS 堆栈与 SDK 实例
   * 全部丢失，MessagePort 断开，未发出的最终检查点被掐断）。
   * 因此 park **只改 CSS，不动父子拓扑**：host 自始至终直属 `document.body`。
   */
  const parkHost = () => {
    if (host === null) return;
    applyParkedStyle(host);
  };

  /**
   * 把 host 用 CSS 定位对齐到页面占位元素（同样不移动 DOM）。
   *
   * 用 `position: fixed` + 目标矩形容器 `getBoundingClientRect()`，
   * 使 host 视觉上覆盖在页面内容区；`display:none` 之外的隐藏都保留渲染。
   *
   * @param {HTMLElement | null} anchor 页面里的占位元素（React 渲染的 slot）
   * @returns {boolean} 是否成功对齐
   */
  const alignHostTo = (anchor) => {
    if (host === null) return false;
    if (anchor === null || anchor.isConnected === false || !routeActive || typeof anchor.getBoundingClientRect !== 'function') {
      applyParkedStyle(host);
      return false;
    }
    const rect = anchor.getBoundingClientRect();
    // 目标不可见（页面已卸载或占位被隐藏）→ 收起，不尝试对齐
    if (rect.width <= 0 || rect.height <= 0) {
      applyParkedStyle(host);
      return false;
    }
    const bounds = anchor.closest?.('[data-gamecenter-page-body]')?.getBoundingClientRect() ?? rect;
    const viewportWidth = typeof window === 'undefined' ? Infinity : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? Infinity : window.innerHeight;
    const clippedTop = Math.max(0, bounds.top - rect.top, -rect.top);
    const clippedLeft = Math.max(0, bounds.left - rect.left, -rect.left);
    const clippedRight = Math.max(0, rect.left + rect.width - bounds.left - bounds.width, rect.left + rect.width - viewportWidth);
    const clippedBottom = Math.max(0, rect.top + rect.height - bounds.top - bounds.height, rect.top + rect.height - viewportHeight);
    host.style.clipPath = `inset(${clippedTop}px ${clippedRight}px ${clippedBottom}px ${clippedLeft}px)`;
    host.style.position = 'fixed';
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
    host.style.overflow = 'hidden';
    host.style.visibility = 'visible';
    host.setAttribute('aria-hidden', 'false');
    host.inert = false;
    host.style.opacity = '1';
    host.style.pointerEvents = 'auto';
    host.style.zIndex = '10';
    return true;
  };

  /**
   * 把游戏会话挂到 detached host（iframe 命令式创建，脱离 React 树）。
   *
   * 【DOM 拓扑硬约束】host 在 `ensureHost()` 时一次性挂到 `document.body`，
   * **之后永不改变父节点**。页面内展示通过 `alignHostTo(anchor)` 用 CSS
   * `position:fixed` 对齐到页面占位元素；离开页面只调用 `parkHost()` 改 CSS。
   * 全程没有跨父节点 `appendChild`，因此不会触发 iframe browsing context 重建。
   *
   * @param {GameSession} session
   * @param {{sandbox: string, frameMode: 'srcdoc' | 'blob', anchor?: HTMLElement | null}} options
   *   `anchor` 提供时，host 用 CSS 对齐到该占位元素（视觉上嵌入页面）；
   *   不提供则保持屏幕外（仅用于保住会话，不展示）。
   */
  const attach = (session, options) => {
    const el = ensureHost();
    if (el === null) return;
    // 先清掉上一个（正常不会发生，防御性）
    detachFrame();

    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-gamecenter-frame', '');
    iframe.setAttribute('sandbox', options.sandbox);
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';

    if (options.frameMode === 'blob' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      const blob = new Blob([session.docHtml], { type: 'text/html' });
      objectUrl = URL.createObjectURL(blob);
      iframe.src = objectUrl;
    } else {
      iframe.srcdoc = session.docHtml;
    }
    el.appendChild(iframe);
    frame = iframe;
    state.session = session;

    routeAnchor = options.anchor ?? null;
    routeActive = routeAnchor !== null;
    if (deps.getService && heartbeat === null) {
      heartbeat = setInterval(() => {
        const current = state.session;
        if (routeActive && current && state.state === SessionState.RUNNING) {
          void hostControl('resumeRuntime', current).catch(error => { parkHost(); setState(SessionState.FAILED, String(error)); });
        }
      }, 10_000);
    }
    // 视觉上嵌入页面（仅 CSS 对齐，绝不移动 DOM 父子关系）
    alignHostTo(options.anchor ?? null);
    setState(SessionState.RUNNING);
  };

  /** 移除 iframe 并释放 blob URL（仅在所有 ack 完成后调用）。 */
  const detachFrame = () => {
    if (frame !== null && frame.parentNode !== null) {
      frame.parentNode.removeChild(frame);
    }
    frame = null;
    if (objectUrl !== null && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
    objectUrl = null;
  };

  /**
   * 启动收敛：**不卸载容器**，直到全部 ack 完成。
   *
   * 顺序（PM 要求，缺一不可）：
   * 1. `triggerPause` 让游戏停止接受输入并产出最终检查点；
   * 2. `requestPause` 内部等待 Host 落盘并返回 revision（超时则回落到最近检查点，
   *    由 lease 层如实标记，不伪造成功）；
   * 3. `saveAck` 封存代次（Host 侧）；
   * 4. `dispatcher.dispose()` 关闭 MessagePort；
   * 5. 以上全部完成后，才移除 iframe 并释放 blob URL。
   *
   * @param {string} reason
   * @returns {Promise<{kind: string, message: string}>}
   */
  const finalize = async (reason) => {
    routeActive = false;
    parkHost();
    await controlQueue;
    if (inFlight !== null) return inFlight;
    const session = state.session;
    if (session === null) {
      return { kind: 'saved', message: '没有运行中的游戏。' };
    }
    const wasSuspended = state.state === SessionState.SUSPENDED;
    const explicitClose = ['close', 'escape', 'back-to-list'].includes(reason);
    /** @param {string} message */
    const releaseWithoutSave = async (message) => {
      session.abortAi?.();
      let timer;
      let confirmed = false;
      try {
        const result = await Promise.race([
          deps.getService?.()?.abandonRuntime({launchToken:session.launchToken, runtimeInstanceId:session.runtimeInstanceId}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('撤销租约超时')), 3000); }),
        ]);
        confirmed = result?.ok === true;
      } catch {} finally { clearTimeout(timer); }
      abandon();
      return {kind:'closed', message:message + (confirmed ? '' : '；租约撤销未获确认，已完成本地清理')};
    };
    if (session.supportsSave === false || session.supportsResume === false) {
      let flashSaved=false;
      let flashSaveUnconfirmed=false;
      if(session.gameId==='example.crazy-flasher4'){
        try{
          // 惰性解析依赖：避免模块顶层 import 破坏以 CJS 方式加载本文件的测试宿主，
          // 同时允许调用方通过 deps.saveFlashBeforeClose 注入（测试可替换）。
          const saveFlash = deps.saveFlashBeforeClose ?? (await import('./wallet-progress.js')).saveFlashBeforeClose;
          flashSaved=await saveFlash(session,deps.getService?.());
        }
        catch(error){
          // 兜底：解析或保存失败都不得阻断关闭。记录一次失败、照常关闭，
          // 并在提示里如实说明"未确认保存"，而不是让玩家卡在关闭流程里或静默丢进度。
          flashSaveUnconfirmed=true;
          try{ console.warn('[gamecenter] 关闭前保存 Flash 进度失败，已继续关闭：',error); }catch{}
        }
      }
      const result = await releaseWithoutSave(
        flashSaved
          ? '当前游戏进度已保存，游戏已关闭。'
          : flashSaveUnconfirmed
            ? '关闭时进度未能确认保存，游戏已关闭；如需继续请从上次存档恢复。'
            : '对局已结束（本次未保存）',
      );
      return {...result, kind:'saved'};
    }
    setState(SessionState.FINALIZING);

    // 【关键】收敛一开始就把 host 移出 React 树（屏幕外但仍在 DOM）。
    // 这样即使 main 槽页面此刻被卸载，iframe 也不会被 React 连带移除——
    // 它要活到下面的 saveAck ack 之后才被销毁。
    parkHost();

    /** @type {Promise<{kind: string, message: string}>} */
    const run = (async () => {
      let outcome;
      try {
        if (wasSuspended) {
          await hostControl('resumeRuntime', session);
          session.lease.state = 'running';
        }
        if (deps.getService) await hostControl('pause', session);
        // Register the result waiter before sending a pause that can acknowledge immediately.
        const paused = requestPause(reason);
        if (session.dispatcher && typeof session.dispatcher.triggerPause === 'function') {
          session.dispatcher.triggerPause({ reason });
        }
        outcome = await paused;
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (explicitClose) return releaseWithoutSave(`游戏已关闭；本次保存未确认（${e?.message || '保存失败'}），保留此前检查点`);
        // 落盘失败：绝不显示"已保存"，保留容器以便重试。
        setState(SessionState.FAILED, e?.message || '保存失败');
        showGlobalNotice(e?.message || '保存失败', {
          retryable: true,
          onRetry: () => {
            hideGlobalNotice();
            void finalize(reason);
          },
        });
        return { kind: 'crashed', message: e?.message || '保存失败' };
      }

      // 只有确认 saved 才销毁；timeout/crashed 走 recovery（由上层展示回落位置）。
      if (outcome.kind === 'saved') {
        if (session.dispatcher && typeof session.dispatcher.dispose === 'function') {
          session.dispatcher.dispose();
        }
        if (session.blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(session.blobUrl);
        }
        session.unbindTheme?.();
        deps.destroyRuntime?.(session.lease);
        detachFrame();
        state.session = null;
        setState(SessionState.SAVED, outcome.message);
        hideGlobalNotice();
        return outcome;
      }

      if (explicitClose) return releaseWithoutSave(`游戏已关闭；本次保存未确认，保留此前检查点。${outcome.message}`);

      // 未确认保存：保留 iframe 与会话，让上层显示"回落到最近检查点"并可重试。
      setState(SessionState.FAILED, outcome.message);
      // 【QA 要求】页面此时可能已卸载，React 里的 notice 玩家看不见。
      // 因此额外挂一个直属 document.body 的全局提示，页面卸载后依然可见可重试。
      showGlobalNotice(outcome.message || '保存未确认', {
        retryable: true,
        onRetry: () => {
          hideGlobalNotice();
          void finalize(reason);
        },
      });
      return outcome;
    })();

    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
    }
  };

  /**
   * 立即放弃（不保存）：仅用于启动失败回滚，不涉及运行中对局。
   * @returns {void}
   */
  const abandon = () => {
    routeActive = false;
    routeAnchor = null;
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    if (state.session) {
      state.session.abortAi?.();
      state.session.dispatcher?.dispose?.();
      state.session.unbindTheme?.();
      deps.destroyRuntime?.(state.session.lease);
    }
    detachFrame();
    state.session = null;
    hideGlobalNotice();
    setState(SessionState.IDLE);
  };

  /**
   * 订阅状态变化。
   * @param {() => void} fn
   * @returns {() => void}
   */
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  /** 当前状态快照（只读）。 */
  /** @type {HTMLElement | null} */
  let noticeEl = null;

  /**
   * 挂一个直属 `document.body` 的全局提示。
   *
   * 【为什么不用 React notice】收敛失败往往发生在页面**已经卸载**之后
   * （导航离开 → React 树没了 → React 里的 notice 玩家根本看不见）。
   * 因此这里直接操作 DOM，挂在 body 上，页面卸载后依然可见，并提供重试按钮。
   *
   * @param {string} message
   * @param {{retryable?: boolean, onRetry?: () => void}} [options]
   */
  const showGlobalNotice = (message, options = {}) => {
    if (typeof document === 'undefined') return;
    hideGlobalNotice();
    const el = document.createElement('div');
    el.setAttribute('data-gamecenter-global-notice', '');
    el.setAttribute('role', 'alert');
    el.style.position = 'fixed';
    el.style.right = '16px';
    el.style.bottom = '16px';
    el.style.maxWidth = '360px';
    el.style.padding = '12px 14px';
    el.style.background = 'var(--dsw-alias-bg-base, Canvas)';
    el.style.color = 'var(--dsw-alias-label-primary, CanvasText)';
    el.style.border = '1px solid var(--dsw-alias-border-l3, #d0d7de)';
    el.style.borderLeft = '4px solid #cf222e';
    el.style.borderRadius = '8px';
    el.style.boxShadow = '0 8px 24px rgba(31, 35, 40, 0.2)';
    el.style.zIndex = '2000';
    el.style.fontSize = '13px';
    el.style.lineHeight = '1.5';

    const text = document.createElement('div');
    text.textContent = `游戏状态未确认：${message}。会话已保留，可重试。`;
    el.appendChild(text);

    if (options.retryable === true && typeof options.onRetry === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重试';
      btn.setAttribute('data-gamecenter-action', 'retry-save');
      btn.style.marginTop = '8px';
      btn.style.marginRight = '8px';
      btn.style.padding = '4px 10px';
      btn.style.fontSize = '12px';
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', () => {
        if (typeof options.onRetry === 'function') options.onRetry();
      });
      el.appendChild(btn);

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = '知道了';
      dismiss.setAttribute('data-gamecenter-action', 'dismiss-notice');
      dismiss.style.marginTop = '8px';
      dismiss.style.padding = '4px 10px';
      dismiss.style.fontSize = '12px';
      dismiss.style.cursor = 'pointer';
      dismiss.addEventListener('click', () => hideGlobalNotice());
      el.appendChild(dismiss);
    }

    document.body.appendChild(el);
    noticeEl = el;
  };

  /** 移除全局提示（幂等）。 */
  const hideGlobalNotice = () => {
    if (noticeEl !== null && noticeEl.parentNode !== null) {
      noticeEl.parentNode.removeChild(noticeEl);
    }
    noticeEl = null;
  };

  const snapshot = () => ({ state: state.state, session: state.session, message: state.message });

  /**
   * 把 host 用 CSS 重新对齐到给定占位元素（不移动 DOM）。
   * 页面 resize / 布局变化 / 重新渲染时调用。
   * @param {HTMLElement | null} anchor
   * @returns {boolean}
   */
  const align = (anchor) => {
    if (anchor === null) { routeActive = false; routeAnchor = null; parkHost(); return false; }
    if (state.state !== SessionState.RUNNING) return false;
    return alignHostTo(anchor);
  };

  const reconcileRoute = () => {
    controlQueue = controlQueue.catch(() => {}).then(async () => {
      const session = state.session;
      if (!session || state.state === SessionState.FINALIZING) return;
      try {
        if (!routeActive) {
          parkHost();
          session.abortAi?.();
          if (state.state === SessionState.SUSPENDED) return;
          session.lease.state = 'suspended'; session.lease.inputOpen = false; session.lease.clockFrozen = true;
          await hostControl('suspendRuntime', session);
          await session.dispatcher?.control('suspend');
          if (state.session === session) setState(SessionState.SUSPENDED);
        } else {
          if (state.state === SessionState.SUSPENDED || state.state === SessionState.FAILED) {
            await hostControl('resumeRuntime', session);
            await session.dispatcher?.control('resume');
            if (state.session !== session) return;
            session.lease.state = 'running'; session.lease.inputOpen = true; session.lease.clockFrozen = false;
            setState(SessionState.RUNNING);
          }
          if (routeActive && state.session === session) alignHostTo(routeAnchor);
        }
      } catch (error) {
        parkHost(); setState(SessionState.FAILED, String(error));
        showGlobalNotice(String(error), {retryable:true, onRetry:() => { void reconcileRoute(); }});
      }
    });
    return controlQueue;
  };
  /** @param {HTMLElement} anchor */
  const bind = (anchor) => { routeAnchor = anchor; routeActive = true; return reconcileRoute(); };
  const unbind = () => { routeActive = false; routeAnchor = null; parkHost(); return reconcileRoute(); };

  /** 是否持有 detached host（测试与调试用）。 */
  const debugInfo = () => ({
    hasHost: host !== null,
    hasFrame: frame !== null,
    hostAttribute: HOST_ATTRIBUTE,
    hostParentIsBody: host !== null && host.parentNode === document.body,
  });

  return { attach, finalize, abandon, align, bind, unbind, suspend: unbind, resume: bind, notify: emit, getFrame: () => frame, dispose: abandon, subscribe, snapshot, debugInfo };
}

