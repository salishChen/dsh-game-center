// @ts-check
/**
 * 链路诊断弹窗（2026-10-20 页面化改版）。
 *
 * 【为什么单独抽出来】用户改版前，诊断区是 `GameCenterOverlay` 弹层里的一个 Tab；
 * 改版后游戏库成为主内容区页面，诊断改为页面右上角按钮打开的**独立弹窗**。
 * 这里把它抽成独立组件，让 overlay 形态与 page 形态共用同一份诊断逻辑——
 * 诊断实现（`RemoteDiagnostics`）本身一行不改，只换容器与开关。
 *
 * 可访问性与清理：
 * - `role="dialog"` + `aria-modal="true"` + `aria-label`；
 * - 打开时捕获焦点、关闭时还原到触发按钮（由页面负责回跳，这里只调 onClose）；
 * - Escape 关闭（经 pushEscapeLayer 分层，不抢 DSH 其他快捷键）；
 * - 点击遮罩关闭。
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h, useEffect, useRef } from 'react';
import { captureFocusReturn, pushEscapeLayer } from './focus.js';
import { RemoteDiagnostics } from './RemoteDiagnostics.js';

/** 遮罩样式：覆盖整个视口，点击关闭。 */
const MASK_STYLE = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(31, 35, 40, 0.45)',
  zIndex: 1000,
};

/** 弹窗外壳：居中、限宽、可滚动（窄屏不溢出）。 */
const DIALOG_STYLE = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(720px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 64px)',
  overflowY: 'auto',
  background: 'var(--dsw-alias-bg-base, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
  borderRadius: '12px',
  padding: '20px',
  zIndex: 1001,
  boxShadow: '0 8px 24px rgba(31, 35, 40, 0.2)',
};

/** 头部：标题在左、关闭按钮在右。 */
const HEADER_STYLE = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '16px',
  gap: '12px',
};

/** 关闭按钮。 */
const CLOSE_BUTTON_STYLE = {
  padding: '6px 12px',
  fontSize: '13px',
  lineHeight: '20px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
  border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
  borderRadius: '6px',
  cursor: 'pointer',
};

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
export function DiagnosticsDialog({ t, remoteState, getService, makeNonce, runDiagnostics, onClose }) {
  const dialogRef = useRef(/** @type {any} */ (null));
  /** @type {{current: (() => void) | null}} */
  const restoreFocus = useRef(null);

  // 打开时：捕获焦点上下文，把焦点移入弹窗
  useEffect(() => {
    const dialog = dialogRef.current;
    restoreFocus.current = captureFocusReturn(dialog);
    if (dialog !== null && typeof dialog.focus === 'function') dialog.focus();
    return () => {
      const restore = restoreFocus.current;
      restoreFocus.current = null;
      if (restore !== null) restore();
    };
  }, []);

  // Escape 关闭：分层注册，不抢 DSH 其他快捷键
  useEffect(() => {
    const pop = pushEscapeLayer(() => {
      onClose();
    });
    return () => {
      pop();
    };
  }, [onClose]);

  const title = t('diagnostics');

  return h(
    'div',
    null,
    // 遮罩：点击关闭
    h('div', {
      'data-gamecenter-dialog-mask': '',
      'aria-hidden': 'true',
      onClick: () => onClose(),
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
        'data-gamecenter-dialog': '',
        'data-gamecenter-dialog-kind': 'diagnostics',
        style: DIALOG_STYLE,
      },
      h(
        'div',
        { style: HEADER_STYLE },
        h('h2', { id: 'gamecenter-dialog-title', style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, title),
        h(
          'button',
          {
            type: 'button',
            'data-gamecenter-action': 'dialog-close',
            onClick: () => onClose(),
            style: CLOSE_BUTTON_STYLE,
          },
          t('close'),
        ),
      ),
      // 诊断主体：完全复用既有实现（不改逻辑，只换容器）
      h(RemoteDiagnostics, { remoteState, getService, makeNonce, runDiagnostics }),
    ),
  );
}
