// @ts-check
/**
 * 游戏中心**页面**组件（2026-10-20 用户改版要求）。
 *
 * 【为什么单独一个文件】用户明确要求：游戏库不再放在弹框里，改为 DSH 主内容区域的
 * 真正页面；页面右上角放「链路诊断」按钮，点击后才打开已有的诊断弹窗。
 * 实现方式是把原 `GameCenterOverlay`（`shell.overlay` list 槽）改为由本页面按需挂载，
 * 页面本身注册进 `main` 槽——不是把弹框放大伪装成页面，也不另起替代 server。
 *
 * 职责边界：
 * - 本组件只负责**页面骨架**：标题、右上角诊断按钮、窄屏滚动容器、空/加载/错误状态；
 * - 游戏库、安装、启动、受控 iframe、诊断弹窗等全部逻辑仍由 `GameCenterOverlay` 承担，
 *   `GameLibrary` 只承担游戏库展示与选择，不绕过 Host 审批；
 * - 页面深浅色跟随 DSH：通过主题桥切换游戏库深浅配色；
 * - 离开页面可恢复暂停，最终关闭仍走原有释放与存档确认路径。
 *
 * @param {object} props
 * @param {(key: string) => string} props.t
 * @param {(reason: string) => Promise<any>} props.requestPause
 * @param {any} [props.sessionController] 插件作用域会话控制器（v3 导航收尾）
 * @param {((args: { gameId: string, saveId: string, runtimeInstanceId?: string }) => any) | null} [props.beginRuntime]
 * @param {((ack: { generation: number, revision: number }) => void) | null} [props.onSaveAck]
 * @param {{ failure: string | null, mounted: boolean }} [props.remoteState]
 * @param {() => any} [props.getService]
 * @param {() => string} [props.makeNonce]
 * @param {() => string} [props.makeLaunchToken]
 * @param {any} [props.runDiagnostics]
 * @param {(controls: {openDiagnostics: () => void}) => any} props.children 内容区渲染函数
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import { pushEscapeLayer } from './focus.js';
import { GameCenterOverlay } from './GameCenterOverlay.js';
import { GameCenterIcon } from './GameCenterIcon.js';
import { WhaleWallet } from './WhaleWallet.js';
import { LIBRARY_STYLES } from './library-styles.js';

/**
 * @typedef {object} OverlayStore
 * @property {boolean} open
 * @property {(next: boolean) => void} set
 * @property {(fn: (open: boolean) => () => void) => () => void} subscribe
 */

/**
 * 页面容器样式：占满主内容区，窄屏可纵向滚动。
 * 游戏库侧栏和内容区分别管理留白，背景遮住宿主壁纸，保障文字对比度。
 */
const PAGE_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  gap: 0,
  padding: 0,
  overflow: 'hidden',
  boxSizing: 'border-box',
};

/** 顶部栏：标题在左、诊断按钮在右（用户要求右上角）。 */
const HEADER_STYLE = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
  flexWrap: 'wrap',
};

/**
 * 内容区：游戏库主体，允许窄屏滚动，运行游戏时由 iframe 占满。
 * 游戏库采用侧栏与独立滚动内容，运行时继续占满整个可用内容区。
 */
const BODY_STYLE = {
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'hidden',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  margin: '0 auto',
  boxSizing: 'border-box',
};

/**
 * 游戏中心页面：把游戏库作为主内容区页面呈现，诊断弹窗按需打开。
 *
 * @param {any} props
 * @returns {any}
 */
export function GameCenterPage(props) {
  const { t, requestPause, beginRuntime = null, onSaveAck = null } = props;
  const sessionController = props.sessionController ?? null;
  const themeBridge = props.themeBridge ?? null;
  const remoteState = props.remoteState ?? { failure: null, mounted: false };
  const getService = props.getService ?? (() => null);
  const makeNonce = props.makeNonce ?? (() => '');
  const makeLaunchToken = props.makeLaunchToken ?? (() => '');
  const runDiagnostics = props.runDiagnostics ?? null;
  const [colorScheme, setColorScheme] = useState(themeBridge?.current?.() ?? 'dark');
  useEffect(() => themeBridge?.bind?.((/** @type {string} */ scheme) => {setColorScheme(scheme);return true;}), [themeBridge]);

  /**
   * @typedef {object} OverlayStore
   * @property {boolean} open
   * @property {(next: boolean) => void} set
   * @property {(fn: (open: boolean) => void) => () => void} subscribe
   */

  /** @type {{current: OverlayStore | null}} */
  const overlayStore = useRef(null);
  if (overlayStore.current === null) {
    /** @type {Set<(open: boolean) => void>} */
    const listeners = new Set();
    /** @type {OverlayStore} */
    const store = {
      open: false,
      /** @param {boolean} next */
      set(next) {
        this.open = next;
        for (const fn of [...listeners]) fn(next);
      },
      /**
       * @param {(open: boolean) => void} fn
       * @returns {() => void}
       */
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    };
    overlayStore.current = store;
  }
  const overlay = overlayStore.current;

  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const headerRef = useRef(/** @type {any} */ (null));

  /** 打开诊断弹窗（焦点由 DiagnosticsDialog 自行管理捕获与还原）。 */
  const openDiagnostics = useCallback(() => {
    setDiagnosticsOpen(true);
    overlay.set(true);
  }, [overlay]);

  /** 关闭诊断弹窗：焦点回到右上角按钮（用户要求）。 */
  const closeDiagnostics = useCallback(() => {
    setDiagnosticsOpen(false);
    overlay.set(false);
    const node = headerRef.current?.querySelector?.('[data-gamecenter-action="diagnostics"]');
    if (node && typeof node.focus === 'function') node.focus();
  }, [overlay]);

  // 页面级 Escape：仅当诊断弹窗打开时拦截，避免与 DSH 其他快捷键冲突。
  useEffect(() => {
    if (!diagnosticsOpen) return undefined;
    const pop = pushEscapeLayer(() => {
      closeDiagnostics();
    });
    return () => {
      pop();
    };
  }, [diagnosticsOpen, closeDiagnostics]);

  // 同步诊断开关，不改变游戏会话。
  useEffect(() => {
    const unsubscribe = overlay.subscribe((isOpen) => {
      if (!isOpen && diagnosticsOpen) {
        setDiagnosticsOpen(false);
      }
    });
    return unsubscribe;
  }, [overlay, diagnosticsOpen]);

  // 页面卸载/后台只隐藏并可恢复暂停，Document 和 MessagePort 保留。
  // 关闭窗口才执行最终收尾；占位与 iframe 的定位仍交给会话控制器。
  useEffect(() => {
    if (!sessionController) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void sessionController.unbind?.();
      else { const anchor = document.querySelector('[data-gamecenter-frame-slot]'); if (anchor) void sessionController.bind?.(anchor); }
    };
    const onPageHide = () => { void sessionController.finalize('pagehide'); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onPageHide); void sessionController.unbind?.(); };
  }, [sessionController]);

  const title = t('title');
  const [isRunning,setIsRunning]=useState(Boolean(sessionController?.snapshot?.().session));
  useEffect(()=>sessionController?.subscribe?.(()=>setIsRunning(Boolean(sessionController.snapshot().session))),[sessionController]);

  return h(
    'div',
    {
      'data-gamecenter-page': '',
      'data-gamecenter-theme': colorScheme,
      style: PAGE_STYLE,
    },
    h('style', null, LIBRARY_STYLES),
    // 顶部栏：标题 + 右上角链路诊断按钮
    !isRunning && h(
      'div',
      { ref: headerRef, className: 'gc-header', style: HEADER_STYLE },
      h('div', {className:'gc-brand'},
      h('span', {className:'gc-brand-mark'}, h(GameCenterIcon, { size: 24 })),
      h('div', {},
      h(
        'h1',
        {
          id: 'gamecenter-page-title',
          style: {
            margin: 0,
            fontSize: '20px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          },
        },
        // 用户指定的手柄图标：页面标识，颜色跟随 DSH 深浅色。
        title,
      ),
      h('small', {}, 'GAME CENTER')),
      h('span', {className:'gc-header-section'}, '游戏库')),
      h(WhaleWallet,{getService}),
      h(
        'button',
        {
          type: 'button',
          className: 'gc-button gc-button-quiet',
          'data-gamecenter-action': 'diagnostics',
          'aria-haspopup': 'dialog',
          'aria-expanded': diagnosticsOpen ? 'true' : 'false',
          onClick: () => (diagnosticsOpen ? closeDiagnostics() : openDiagnostics()),
        },
        // 双语：locale 键 diagnostics（zh 链路诊断 / en Connection Diagnostics）
        t('diagnostics'),
      ),
    ),

    // 内容区：游戏库/安装/启动/受控 iframe（复用现有弹层实现，不重写）
    h(
      'div',
      { 'data-gamecenter-page-body': '', style: BODY_STYLE },
      h(GameCenterOverlay, {
        overlay,
        t,
        requestPause,
        beginRuntime,
        onSaveAck,
        // 页面模式下"关闭弹层"= 关闭诊断弹窗并回到游戏库
        onClosed: () => closeDiagnostics(),
        remoteState,
        getService,
        makeNonce,
        makeLaunchToken,
        runDiagnostics,
        // 页面模式：弹层不再显示遮罩与"游戏库/链路诊断"Tab（改由页面右上角按钮承担）
        presentation: 'page',
        diagnosticsOpen,
        // v3 导航收尾：会话控制器（iframe 放脱离 React 树的 detached host）
        sessionController,
        // v3 主题通道：DSH 主题经已配对 MessagePort 下发给游戏
        themeBridge,
      }),
    ),
  );
}
