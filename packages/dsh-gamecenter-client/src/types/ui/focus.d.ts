/**
 * 把一个关闭回调压入层栈；返回出栈函数（幂等）。
 * @param {() => void} onEscape
 * @returns {() => void}
 */
export function pushEscapeLayer(onEscape: () => void): () => void;
/**
 * 判断一个元素是否还能接收焦点（仍在文档里、未被 disabled、可见）。
 * @param {unknown} element
 * @returns {boolean}
 */
export function isFocusable(element: unknown): boolean;
/**
 * 记录打开前的焦点，返回“关闭时如何恢复焦点”的函数。
 * @param {unknown} [fallback] 打开动作的触发元素（打开前焦点已丢失时用）
 * @returns {() => void}
 */
export function captureFocusReturn(fallback?: unknown): () => void;
/** 当前层栈深度（验收断言用）。 */
export function openLayerCount(): number;
