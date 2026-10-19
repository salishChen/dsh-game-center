// @ts-check
/**
 * 弹层的**焦点与键盘约定**（基线 §7 无障碍要求）。
 *
 * 抽成独立模块的理由：这段逻辑决定“Escape 是否真的走 requestPause”“关闭后焦点
 * 是否真的回到打开前的元素”，必须有可断言的行为，而不是埋在 JSX 里靠肉眼验收。
 *
 * 约定：
 * 1. Escape 只对**最上层**打开的那个弹层生效（嵌套时不连带关掉下面的）。
 * 2. Escape 在捕获阶段处理一次并 `preventDefault`，避免 DSH 全局快捷键同时响应。
 * 3. 输入法组字中（`isComposing` / keyCode 229）按下的 Escape 不当作关闭，防止中文输入误关。
 * 4. 打开时记住 `document.activeElement`，关闭后**只有该元素仍在文档里且可聚焦**才还回去；
 *    否则退回到打开它的触发元素（若有），再否则留给浏览器默认。
 */

/** 当前打开的弹层层栈（只增删本项目自己的实例）。 @type {(() => void)[]} */
const openStack = [];

/**
 * 全局唯一的 Escape 监听器：只作用于栈顶。
 * @type {Set<() => void>}
 */
const escapeHandlers = new Set();
/** @type {EventListener | null} */
let installedKeyDown = null;

/** @param {KeyboardEvent} event */
function handleKeyDown(event) {
  if (event.key !== 'Escape') return;
  // 输入法组字中不响应 Escape（中文/日文输入法的候选取消会发 Escape）。
  if (event.isComposing || event.keyCode === 229) return;
  const top = openStack[openStack.length - 1];
  if (top === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  top();
}

/**
 * 把一个关闭回调压入层栈；返回出栈函数（幂等）。
 * @param {() => void} onEscape
 * @returns {() => void}
 */
export function pushEscapeLayer(onEscape) {
  openStack.push(onEscape);
  escapeHandlers.add(onEscape);
  if (installedKeyDown === null && typeof document !== 'undefined') {
    installedKeyDown = /** @type {EventListener} */ (handleKeyDown);
    document.addEventListener('keydown', installedKeyDown, true);
  }
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    const index = openStack.lastIndexOf(onEscape);
    if (index !== -1) openStack.splice(index, 1);
    escapeHandlers.delete(onEscape);
    if (openStack.length === 0 && installedKeyDown !== null && typeof document !== 'undefined') {
      document.removeEventListener('keydown', installedKeyDown, true);
      installedKeyDown = null;
    }
  };
}

/**
 * 判断一个元素是否还能接收焦点（仍在文档里、未被 disabled、可见）。
 * @param {unknown} element
 * @returns {boolean}
 */
export function isFocusable(element) {
  if (element === null || typeof element !== 'object') return false;
  const el = /** @type {any} */ (element);
  if (typeof el.focus !== 'function') return false;
  if (el.isConnected === false) return false;
  if (el.disabled === true) return false;
  if (typeof el.hidden === 'boolean' && el.hidden) return false;
  return true;
}

/**
 * 记录打开前的焦点，返回“关闭时如何恢复焦点”的函数。
 * @param {unknown} [fallback] 打开动作的触发元素（打开前焦点已丢失时用）
 * @returns {() => void}
 */
export function captureFocusReturn(fallback) {
  const previous = typeof document === 'undefined' ? null : document.activeElement;
  return () => {
    if (isFocusable(previous)) {
      /** @type {any} */ (previous).focus();
      return;
    }
    if (isFocusable(fallback)) {
      /** @type {any} */ (fallback).focus();
    }
  };
}

/** 当前层栈深度（验收断言用）。 */
export function openLayerCount() {
  return openStack.length;
}
