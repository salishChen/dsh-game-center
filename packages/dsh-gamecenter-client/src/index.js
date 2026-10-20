// @ts-check
/**
 * Client 插件入口（DSH 侧真实装配点）。
 *
 * 装配依据（逐条来自实读 0.2.1-rc.2 / build 332895e0f7c9d4dbfb29729f5eb367fa263ff986）：
 * 1. `@deepseek-ai/dsh-client-modules/lib/index.js` 的 `ClientModuleRegistry.compose()`
 *    会把 Loader 已装载条目里声明了 `dsh.client.platform:"web"` 的包，按
 *    `exports["./client"]` 找到 bundle，拼成 `/plugins/??<id>/client.js&rev=…`
 *    下发，并注入 `window.__DSH_BOOT__`。浏览器侧 `ClientEntries.start()` 建立
 *    Cordis 插件 fiber。→ **第三方 Client 包只需被 Host 侧 Loader 装载，无需改 DSH 核心**。
 * 2. 静态外部表（web-frontend index 包的 `SZ()`）只有 react / react-dom / cordis /
 *    zod / @tanstack/react-virtual / dsh-client-store / dsh-client-ui-slots /
 *    dsh-client-ui-primitives / dsh-client-ui-dockkit。`dsh.client.external` 写其它
 *    裸包名会让 renderer 的对象插件注入悬空。→ 元素用宿主 `react.createElement`
 *    创建；`@deepseek-ai/cordis/ui` 不在静态外部表里。
 * 3. `ui-layout` 的 root `children` 里 `"shell.overlay": { kind: "list", scope: "root" }`，
 *    AppFrame `renderSlot("shell.overlay", {})`。list 槽每项独立挂载，
 *    不声明 children 的注册项拿不到 renderSlot。→ 弹层作为并列项追加，
 *    **不覆盖**已有 shell.overlay 内容（基线 §7 的硬性要求）。
 * 4. 侧栏 `sidebar.panellist` 也是 list，条目含 id/order/label。→ 追加“游戏中心”一项。
 *
 * 注：`react` 由 DSH 浏览器静态外部表在运行时提供，
 * 项目内无类型包，故在 import 处声明期望错误，构建期不做类型推导。
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供（见文件头第 2 条）
import { createElement as h, useEffect } from 'react';
import { GameCenterOverlay } from './ui/GameCenterOverlay.js';
import { createResourceTable } from './runtime/resources.js';
import {
  abandonPause,
  completePause,
  createRuntimeLease,
  destroyRuntime,
  PAUSE_TIMEOUT_MS,
  requestPause as requestPauseLease,
} from './runtime/lease.js';
import { createNonce, createLaunchToken } from './bridge/host-bridge.js';
import { mountGameCenterRemote, createGameCenterClient } from './bridge/remote-mount.js';
import { runRemoteDiagnostics } from './bridge/diagnostics.js';

export const LOCALE_NS = 'gamecenter';
export const PANEL_ID = 'gamecenter';
const TITLE_ZH = '游戏中心';
const TITLE_EN = 'Game Center';

/** 本插件需要 Client 侧的 `remote` 服务（`ctx.remote.$mount` 由 dsh-api-gateway 提供）。 */
export const inject = ['slots', 'locale', 'remote'];

/**
 * DSH 客户端插件上下文（只声明本插件用到的成员，避免引入 cordis 类型包）。
 * @typedef {object} ClientContext
 * @property {any} slots
 * @property {any} locale
 * @property {any} [remote]
 * @property {(name: string) => any} [get]
 * @property {any} [reflect]
 * @property {(fn: () => void | (() => void), label: string) => void} effect
 */

/**
 * @typedef {object} PauseResult
 * @property {string} kind
 * @property {string} message
 */

/**
 * @param {ClientContext} ctx
 */
export function apply(ctx) {
  const resources = createResourceTable();
  /** @type {import('./runtime/lease.js').RuntimeLease | null} */
  let lease = null;
  /** @type {{dispose: (() => Promise<void>) | null, failure: string | null, mounted: boolean}} */
  const remoteState = { dispose: null, failure: null, mounted: false };

  /** @returns {ReturnType<typeof createGameCenterClient> | null} */
  const getService = () => {
    // Cordis 规范读法：通过 ctx.get() 读取服务表不要求 inject 声明，避免点号访问触发 ReflectService 拦截
    const service =
      typeof ctx.get === 'function'
        ? ctx.get('remote.gameCenter')
        : typeof ctx.reflect?.get === 'function'
          ? ctx.reflect.get('remote.gameCenter')
          : undefined;
    if (!service) return null;
    return createGameCenterClient(service);
  };
  /** 进行中的暂停 Promise 与超时计时器（同一时刻只允许一个）。 */
  /** @type {Promise<PauseResult> | null} */
  let pending = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pauseTimer = null;
  /** @type {((v: PauseResult) => void) | null} */
  let pauseResolve = null;

  /** @param {string} key @returns {string} */
  const t = (key) => {
    try {
      return ctx.locale.bind(LOCALE_NS)(key);
    } catch {
      if (key === 'pausing') return '正在保存并暂停…';
      return TITLE_ZH;
    }
  };

  /** 弹层开关：插件作用域内，卸载即丢弃，不挂 window。 */
  const overlay = {
    open: false,
    /** @type {Set<(open: boolean) => void>} */
    listeners: new Set(),
    /** @param {boolean} next */
    set(next) {
      if (this.open === next) return;
      this.open = next;
      for (const listener of [...this.listeners]) listener(next);
    },
    /** @param {(open: boolean) => void} listener @returns {() => void} */
    subscribe(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };

  /**
   * 所有关闭路径的唯一收敛点。
   * @param {string} reason
   * @returns {Promise<PauseResult>}
   */
  const requestPause = (reason) => {
    if (lease === null) {
      // 还没有运行实例：没有可暂停的游戏，直接放行关闭（不得伪造保存成功）。
      return Promise.resolve({ kind: 'saved', message: '当前没有运行中的游戏。' });
    }
    const request = requestPauseLease(lease, { reason });
    if (request === null) {
      return Promise.resolve({ kind: 'refused', message: '当前运行已处于暂停或已停止。' });
    }
    const current = lease;
    const outcome = /** @type {Promise<PauseResult>} */ (
      new Promise((resolve) => {
        pauseResolve = resolve;
      })
    );
    pending = outcome;
    // 超时兜底：不再等游戏，回落到最近检查点（基线 §8.1）。
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      const resolved = abandonPause(current, 'timeout');
      settle(resolved);
    }, PAUSE_TIMEOUT_MS);
    resources.track('timer', () => {
      if (pauseTimer !== null) clearTimeout(pauseTimer);
      pauseTimer = null;
    });
    return outcome;
  };

  /**
   * 结算一次暂停（保存确认 / 超时 / 崩溃）。
   * @param {PauseResult} outcome
   * @returns {void}
   */
  const settle = (outcome) => {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    const resolve = pauseResolve;
    pauseResolve = null;
    pending = null;
    if (resolve !== null) resolve(outcome);
    if (lease !== null && (outcome.kind === 'saved' || outcome.kind === 'timeout' || outcome.kind === 'crashed')) {
      // 保存确认（或超时回落到检查点）之后才销毁执行实例与资源。
      destroyRuntime(lease);
      resources.releaseAll();
    }
  };

  /**
   * 创建一个新的运行实例登记（阶段1 由 Bridge 握手真正驱动）。
   *
   * `runtimeInstanceId` 可选：由弹层在握手时生成并传给 Host，这里复用同一个值，
   * 否则本地租约与 Host 租约记录的是两个不同的运行实例 ID（诊断与审计会对不上）。
   * @param {{gameId: string, saveId: string, runtimeInstanceId?: string}} args
   * @returns {import('./runtime/lease.js').RuntimeLease}
   */
  const beginRuntime = ({ gameId, saveId, runtimeInstanceId: handedInstanceId }) => {
    const runtimeInstanceId =
      typeof handedInstanceId === 'string' && handedInstanceId.length > 0
        ? handedInstanceId
        : `rt-${createNonce().slice(0, 16)}`;
    lease = createRuntimeLease({ gameId, saveId, runtimeInstanceId, nonce: createNonce() });
    return lease;
  };

  /** 游戏回传保存确认的唯一入口。 */
  /**
   * @param {{generation: number, revision: number}} ack
   * @returns {void}
   */
  const onSaveAck = (ack) => {
    if (lease === null || lease.state !== 'pausing') return;
    settle(completePause(lease, ack));
  };

  ctx.effect(() => {
    try {
      return ctx.locale.register(LOCALE_NS, {
        zh: { title: TITLE_ZH, close: '关闭游戏中心', pausing: '正在保存并暂停…' },
        en: { title: TITLE_EN, close: 'Close Game Center', pausing: 'Saving and pausing…' },
      });
    } catch {
      // locale 缺失时回落到中文常量，不影响功能。
    }
    return () => {};
  }, 'gamecenter: locale');

  ctx.effect(() => {
    // Remote 挂载：把 gameCenter 命名空间挂到 ctx.remote 上（方案 (b)）。
    // 失败不阻塞 UI —— 弹层仍可打开，界面诊断区会如实呈现挂载失败码。
    let cancelled = false;
    void (async () => {
      const mounted = await mountGameCenterRemote(ctx, {
        logger: { warn: (message) => console.warn(message) },
      });
      if (cancelled) {
        if (mounted.ok) await mounted.dispose();
        return;
      }
      if (mounted.ok) {
        remoteState.dispose = mounted.dispose;
        remoteState.failure = null;
        remoteState.mounted = true;
      } else {
        remoteState.failure = `${mounted.code}: ${mounted.message}`;
        remoteState.mounted = false;
        console.warn(`gameCenter: Remote 挂载失败 —— ${mounted.message}`);
      }
    })();

    return () => {
      cancelled = true;
      remoteState.mounted = false;
      const dispose = remoteState.dispose;
      remoteState.dispose = null;
      if (dispose !== null) void dispose();
    };
  }, 'gamecenter: remote $mount');

  ctx.effect(() => {
    // 侧栏入口：list 槽里追加一项，不挤占已有面板。
    //
    // 【位置依据】用户要求游戏中心入口放在「技能中心」附近。
    // 实测（只读，2026-10-18）：
    //  - 「技能中心」不是 DSH 官方包，是 profile 里的第三方插件
    //    `@linxin666/dsh-client-ui-skill-explorer` v0.4.6；
    //    其 `lib/client.js`：`SKILL_EXPLORER_PANEL_ID = "skill-explorer"`、`PANEL_ORDER = 30`，
    //    注册进 `sidebar.panellist`，locale `"entry.label": "技能中心"`。
    //  - DSH 官方 `dsh-client-ui-sidebar/lib/client.js` `syncPanels()`：
    //    `order: options.order ?? 0` 后 `.sort((a, b) => a.order - b.order)`。
    //  - 当前占用：插件管理 0 / 任务管理 10 / 技能中心 30。
    //  → 取 31，紧邻技能中心之后；独立一项，不替换、不遮挡技能中心。
    const disposePanel = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 31,
        label: () => t('title'),
        locale: LOCALE_NS,
      },
      () => h('span', { 'aria-hidden': 'true' }, '🎮'),
    ));

    // Selecting a sidebar panel mounts its keyed main entry. Open the overlay
    // there, and leave a button so it can be reopened without changing panels.
    const disposeMain = ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: LOCALE_NS },
      function GameCenterPanel() {
        useEffect(() => overlay.set(true), []);
        return h('div', { style: { padding: '24px' } },
          h('button', { type: 'button', onClick: () => overlay.set(true) }, t('title')),
        );
      },
    ));

    // 主弹层：shell.overlay 是 list，追加等价位，已有 overlay 不受影响。
    const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      {
        name: 'shell.overlay',
        id: PANEL_ID,
        locale: LOCALE_NS,
        inject: () => ({
          overlay,
          t,
          requestPause,
          beginRuntime,
          onSaveAck,
          onClosed: () => overlay.set(false),
          remoteState,
          getService,
          makeNonce: createNonce,
          makeLaunchToken: createLaunchToken,
          runDiagnostics: runRemoteDiagnostics,
        }),
      },
      GameCenterOverlay,
    ));

    return () => {
      disposeOverlay();
      disposeMain();
      disposePanel();
      overlay.listeners.clear();
      if (lease !== null) destroyRuntime(lease);
      lease = null;
      resources.releaseAll();
    };
  }, 'gamecenter: sidebar entry + shell.overlay');

  // Cordis accepts void or lifecycle disposers from apply(), not a controller object.
}
