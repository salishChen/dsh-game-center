// @ts-check
/**
 * 游戏中心图标（2026-10-20 用户指定）。
 *
 * 来源：用户提供的「游戏机手柄.svg」（4 个 path、viewBox 0 0 1024 1024）。
 * 已做净化，与原始附件的差异**只在**：
 *   1. 去掉 `<?xml ...?>` 声明与 `<!DOCTYPE svg PUBLIC "...svg11.dtd">`
 *      —— 外部 DTD 会让 XML 解析器去访问 w3.org，沙箱/离线环境直接失败，
 *      且是 XXE 一类问题的入口，本图标绝不需要它；
 *   2. 去掉编辑器元数据 `t="1792486842127"`、`class="icon"`、`version="1.1"`、
 *      `p-id`、`xmlns:xlink`（无 xlink 引用）；
 *   3. `fill="#878A94"` → `fill="currentColor"`，让颜色跟随 DSH 主题
 *      （深浅色都保证可读），不写死灰色；
 *   4. 保留 `viewBox="0 0 1024 1024"` 与 4 个 path 的 `d` **逐字不变**，
 *      造型与原文件一致。
 *
 * 【为什么内联而不是 <img src="....svg">】产物是单文件 bundle（dist/client.js），
 * 运行时没有独立的静态资源路径；且内联 SVG 才能用 `currentColor` 跟随主题。
 *
 * 【边界】这是**平台本地受信图标**（用户直接提供、经 PM 实读后指定）。
 * 它**不**改变 Issue 媒体规则：目录元数据里的封面/截图仍然禁 SVG，
 * 仍只接受 png/jpeg/webp/gif。两件事不要混为一谈。
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h } from 'react';

/** 净化后的 4 个 path 数据（与原附件逐字一致）。 */
const ICON_PATHS = [
  'M941 327.32a259.29 259.29 0 0 0-184.55-76.45h-488.9a261 261 0 0 0 0 522h488.9A261 261 0 0 0 941 327.32zM756.47 712.88H269.12c-106.57 0-198.6-87.07-202.46-193.57-4.14-114.2 87.57-208.43 200.86-208.43h487.36c106.57 0 198.6 87.07 202.46 193.57 4.13 114.2-87.57 208.43-200.87 208.43z',
  'M392 481.88h-69v-69c0-15.81-12-29.37-27.76-30.51A30 30 0 0 0 263 412.33v69.55h-69c-15.81 0-29.37 12-30.51 27.76a30 30 0 0 0 29.92 32.24H263v69c0 15.81 12 29.37 27.76 30.51A30 30 0 0 0 323 611.43v-69.55h69.55a30 30 0 0 0 29.92-32.24c-1.13-15.77-14.69-27.76-30.47-27.76z',
  'M669.89 449.62m-50 0a50 50 0 1 0 100 0 50 50 0 1 0-100 0Z',
  'M773.5 574.38m-50 0a50 50 0 1 0 100 0 50 50 0 1 0-100 0Z',
];

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
export function GameCenterIcon(options = {}) {
  const size = typeof options.size === 'number' && options.size > 0 ? options.size : 20;
  const title = typeof options.title === 'string' && options.title.length > 0 ? options.title : null;

  const children = ICON_PATHS.map((d) => h('path', { key: d.slice(0, 12), fill: 'currentColor', d }));
  if (title !== null) children.push(h('title', { key: 'title' }, title));

  return h(
    'svg',
    {
      viewBox: '0 0 1024 1024',
      xmlns: 'http://www.w3.org/2000/svg',
      width: size,
      height: size,
      // 无标题时对辅助技术隐藏（纯装饰）；有标题则暴露
      'aria-hidden': title === null ? 'true' : undefined,
      role: title === null ? undefined : 'img',
      'data-gamecenter-icon': '',
      style: { display: 'block', flexShrink: 0 },
    },
    children,
  );
}
