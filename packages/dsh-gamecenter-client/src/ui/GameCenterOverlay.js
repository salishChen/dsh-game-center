// @ts-check
/**
 * DSH 内游戏中心弹层（基线 §7）。
 *
 * 装配事实（实读 0.2.1-rc.2 / build 332895e0…）：
 * - `shell.overlay` 由 ui-layout 声明为 `{kind:"list", scope:"root"}`，AppFrame 用
 *   `renderSlot("shell.overlay", {})` 渲染。list 槽里每个注册项的组件都会被单独挂载，
 *   所以「没有声明 children」的注册项拿不到 renderSlot，只能渲染自身内容 —— 这正好
 *   符合我们“追加一个并列 overlay、不替换已有内容”的诉求。
 * - 组件收到的 props = 标准 root props + 命令式注册的 `inject()` 结果 + 槽 owner props。
 * - DSH 共享 `Modal` 在浏览器静态外部表里，但只覆盖“预编译产物”的 `require`。
 *   本包按 DSH 同形单文件 bundle 打包（esbuild IIFE），外部依赖留在 `require()` 里，
 *   因此**现在可以 require `@deepseek-ai/dsh-client-ui-primitives` 的 Modal 了**；
 *   但该包的 `Modal` 只接受 `children`，焦点往返交由本项目自己的 focus.js 保证。
 *
 * 注：`react` 由 DSH 浏览器静态外部表在运行时提供，
 * 项目内无类型包，故在 import 处声明期望错误，构建期不做类型推导。
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import { captureFocusReturn, pushEscapeLayer } from './focus.js';
import { RemoteDiagnostics } from './RemoteDiagnostics.js';

/**
 * @typedef {object} OverlayStore
 * @property {boolean} open
 * @property {(next: boolean) => void} set
 * @property {(fn: (open: boolean) => void) => () => void} subscribe
 */

/**
 * @typedef {{kind: string, message: string}} PauseResult
 */

/**
 * 弹层。所有关闭路径（关闭按钮、遮罩、Escape、返回列表）都调用同一个 `close()`，
 * 而 `close()` 里第一件事就是 `requestPause()`。
 *
 * @param {{overlay: OverlayStore, t: (key: string) => string,
 *   requestPause: (reason: string) => Promise<PauseResult>,
 *   onClosed: () => void,
 *   remoteState?: { failure: string | null, mounted: boolean },
 *   getService?: () => any,
 *   makeNonce?: () => string,
 *   runDiagnostics?: any}} props
 */
export function GameCenterOverlay({
  overlay,
  t,
  requestPause,
  onClosed,
  remoteState = { failure: null, mounted: false },
  getService = () => null,
  makeNonce = () => '',
  runDiagnostics = null,
}) {
  const [open, setOpen] = useState(overlay.open);
  const [phase, setPhase] = useState(/** @type {'idle' | 'pausing' | 'paused' | 'recovery'} */ ('idle'));
  const [notice, setNotice] = useState(/** @type {string | null} */ (null));
  const dialogRef = useRef(/** @type {any} */ (null));
  const busy = useRef(false);
  /** @type {{current: (() => void) | null}} */
  const restoreFocus = useRef(null);

  useEffect(() => overlay.subscribe(setOpen), [overlay]);

  /**
   * 唯一关闭路径。
   * @param {string} reason
   * @returns {Promise<void>}
   */
  const close = useCallback(
    /** @type {(reason: string) => Promise<void>} */
    async (reason) => {
      if (busy.current) return;
      busy.current = true;
      setPhase('pausing');
      try {
        const outcome = await requestPause(reason);
        setNotice(outcome.message);
        setPhase(outcome.kind === 'saved' ? 'paused' : 'recovery');
      } finally {
        busy.current = false;
        onClosed();
        overlay.set(false);
      }
    },
    [requestPause, onClosed, overlay],
  );

  // 打开：记住焦点 → 聚焦 dialog → Escape 只对最上层生效；关闭：还焦点。
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    restoreFocus.current = captureFocusReturn(dialog);
    if (dialog !== null && typeof dialog.focus === 'function') dialog.focus();
    const pop = pushEscapeLayer(() => {
      void close('escape');
    });
    return () => {
      pop();
      const restore = restoreFocus.current;
      restoreFocus.current = null;
      if (restore !== null) restore();
    };
  }, [open, close]);

  if (!open) return null;

  const title = t('title');
  return h(
    'div',
    { 'data-gamecenter-overlay': '' },
    h('div', {
      'data-gamecenter-mask': '',
      'aria-hidden': 'true',
      onClick: () => void close('close'),
      style: MASK_STYLE,
    }),
    h(
      'div',
      {
        ref: dialogRef,
        tabIndex: -1,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        'aria-busy': phase === 'pausing' ? 'true' : 'false',
        'data-gamecenter-dialog': '',
        'data-gamecenter-phase': phase,
        style: DIALOG_STYLE,
      },
      h('h2', { id: 'gamecenter-title', style: { margin: '0 0 12px', fontSize: '16px' } }, title),
      h(
        'p',
        { style: { margin: '0 0 12px', color: 'var(--dsw-alias-label-tertiary)' } },
        '阶段0 探针：验证 DSH 内可打开弹层，且关闭按钮 / Escape / 遮罩 / 返回列表都走同一个 requestPause。',
      ),
      phase === 'pausing' ? h('p', { 'aria-live': 'polite', style: { margin: '0 0 12px' } }, t('pausing')) : null,
      notice === null ? null : h('p', { role: 'status', style: { margin: '0 0 12px' } }, notice),
      runDiagnostics !== null && typeof runDiagnostics === 'function'
        ? h(RemoteDiagnostics, { remoteState, getService, makeNonce, runDiagnostics })
        : null,
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
        h(
          'button',
          {
            type: 'button',
            'data-gamecenter-action': 'back-to-list',
            onClick: () => void close('back-to-list'),
            disabled: phase === 'pausing',
            style: BUTTON_STYLE,
          },
          '返回列表',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-gamecenter-action': 'close',
            onClick: () => void close('close'),
            disabled: phase === 'pausing',
            style: BUTTON_STYLE,
          },
          '关闭',
        ),
      ),
    ),
  );
}

const MASK_STYLE = Object.freeze({
  position: 'fixed',
  inset: '0',
  background: 'rgba(0, 0, 0, 0.32)',
  zIndex: '1000',
});

const DIALOG_STYLE = Object.freeze({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(560px, 92vw)',
  maxHeight: '80vh',
  overflow: 'auto',
  padding: '20px',
  borderRadius: '12px',
  background: 'var(--dsw-alias-bg-base, #fff)',
  color: 'var(--dsw-alias-label-primary, #111)',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
  zIndex: '1001',
});

const BUTTON_STYLE = Object.freeze({
  padding: '6px 14px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l3, #d0d0d0)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
});
