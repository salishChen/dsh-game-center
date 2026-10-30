/**
 * 渲染游戏中心图标（内联 SVG）。
 *
 * 颜色用 `currentColor`：由父元素 `color`（DSH 主题 token）决定，
 * 深浅色下都可读，不写死灰色。
 *
 * @param {object} [options]
 * @param {number} [options.size] 像素尺寸（默认 20，与 DSH 侧栏其他图标一致）
 * @param {string} [options.title] 可访问标题；提供时移除 aria-hidden 并加 <title>
 * @returns {any}
 */
export function GameCenterIcon(options?: {
    size?: number | undefined;
    title?: string | undefined;
}): any;
