// @ts-check
/**
 * 受限 Markdown 渲染（v3：游戏简介展示）。
 *
 * 【安全模型】两条独立防线，缺一不可：
 * 1. **形状校验**：先调协议 `findMarkdownHazards(text)` 检出 raw HTML、
 *    Markdown 图片语法、`javascript:`/`data:` 方案、危险标签。**有 hazard 就整条
 *    简介拒绝展示**（不是"过滤掉继续显示"——过滤会让作者误以为内容已生效）。
 * 2. **渲染层**：只产出 React 文本节点（`h('p', text)`），**从不使用
 *    `innerHTML` / `dangerouslySetInnerHTML`**。因此即使校验被绕过，
 *    任何 HTML 标签也只会作为普通文本显示，不会被解析。
 *
 * 【支持范围（最小完整）】标题 `#`..`######`、无序列表 `-`/`*`、有序列表 `1.`、
 * 段落、行内 `**粗体**` 与 `*斜体*`（以纯文本节点呈现，不产生标记）。
 * 链接、行内代码、表格、引用块等一律按纯文本段落处理。
 *
 * 【与媒体无关】媒体（封面/截图）本轮禁用显示占位，与本渲染器互不影响。
 */

import { findMarkdownHazards, validateDisplayMetadata } from '@dsh-gamecenter/protocol';

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h } from 'react';

/**
 * @typedef {object} MarkdownBlock
 * @property {'heading' | 'list' | 'paragraph'} kind
 * @property {number} [level] heading 级别 1..6
 * @property {boolean} [ordered] 是否有序列表
 * @property {string[]} [items] 列表项文本
 * @property {string} [text] 段落文本
 */

/**
 * 把受限 Markdown 切成块。
 *
 * @param {string} text
 * @returns {MarkdownBlock[]}
 */
export function parseRestrictedMarkdown(text) {
  /** @type {MarkdownBlock[]} */
  const blocks = [];
  /** @type {string[]} */
  const paragraphs = [];

  const flushParagraph = () => {
    if (paragraphs.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraphs.join('\n') });
    paragraphs.length = 0;
  };

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    // 标题：# .. ######（最多 6 级）
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: (heading[2] ?? '').trim() });
      continue;
    }
    // 无序列表：- / *
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    if (unordered !== null) {
      flushParagraph();
      const item = (unordered[1] ?? '').trim();
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'list' && last.ordered === false) {
        (last.items ??= []).push(item);
      } else {
        blocks.push({ kind: 'list', ordered: false, items: [item] });
      }
      continue;
    }
    // 有序列表：1. 2. ...
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered !== null) {
      flushParagraph();
      const item = (ordered[1] ?? '').trim();
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'list' && last.ordered === true) {
        (last.items ??= []).push(item);
      } else {
        blocks.push({ kind: 'list', ordered: true, items: [item] });
      }
      continue;
    }
    paragraphs.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

/**
 * 去掉行内 `**` / `*` 标记（只作为纯文本呈现，不产生任何标记效果）。
 * @param {string} text
 * @returns {string}
 */
export function stripInlineEmphasis(text) {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
}

/**
 * 渲染"已拒绝"提示（只输出纯文本，不回显任何原文）。
 * @param {string} message
 * @returns {any}
 */
function renderRejected(message) {
  return h(
    'div',
    {
      'data-markdown-rejected': '',
      role: 'note',
      style: {
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l3, #d0d7de)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
        color: 'var(--dsw-alias-label-secondary, #57606a)',
        fontSize: '12px',
      },
    },
    message,
  );
}

/**
 * 渲染受限 Markdown。
 *
 * @param {object} props
 * @param {string} props.text 原始 Markdown 文本
 * @param {any} [props.display] 整条展示元数据（用于 validateDisplayMetadata 交叉校验）
 * @param {string} [props.repository] 机器块 `source.repository`（与 display.repository 同源校验）
 * @param {string} [props.className]
 * @param {string} [props.rejectedNotice] 检出 hazard 时的提示文案
 * @returns {any}
 */
export function SafeMarkdown(props) {
  const text = typeof props.text === 'string' ? props.text : '';
  if (text === '') return null;

  // 防线 1a：整条展示元数据校验（协议 validateDisplayMetadata）。
  // 它内部已包含 findMarkdownHazards 对 descriptionMarkdown 的检查，另外还校验
  // schemaVersion / repository 同源 / summary 长度 / compatibility 范围。
  // 【媒体豁免】本轮媒体（cover/screenshots）禁用、不展示，因此校验前先剥离媒体字段——
  // 否则"媒体 URL 不在白名单"会连带把简介一起拒掉，那属于误伤。
  const display = props.display;
  if (display !== null && typeof display === 'object') {
    const violations = validateDisplayMetadata(
      { ...display, cover: null, screenshots: [] },
      { allowedImageHosts: [], sourceRepository: props.repository },
    );
    if (violations.length > 0) {
      return renderRejected(
        `展示元数据不合规（${violations.map((v) => v.field).join(', ')}），简介已拒绝展示。`,
      );
    }
  }

  // 防线 1b：文本形状校验。任一 hazard → 整条拒绝展示。
  const hazards = findMarkdownHazards(text);
  if (hazards.length > 0) {
    return renderRejected(props.rejectedNotice ?? '简介包含不安全内容（HTML/图片/危险链接），已拒绝展示。');
  }

  // 防线 2：只产出文本节点。
  const blocks = parseRestrictedMarkdown(text);
  return h(
    'div',
    {
      'data-markdown': '',
      className: props.className,
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontSize: '13px',
        lineHeight: '1.6',
        color: 'var(--dsw-alias-label-secondary, #57606a)',
      },
    },
    blocks.map((block, index) => {
      const key = `b${index}`;
      if (block.kind === 'heading') {
        const level = Math.min(Math.max(block.level ?? 1, 1), 6);
        return h(
          /** @type {any} */ (`h${level}`),
          {
            key,
            style: {
              margin: 0,
              fontSize: level <= 2 ? '15px' : '14px',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary, CanvasText)',
            },
          },
          stripInlineEmphasis(block.text ?? ''),
        );
      }
      if (block.kind === 'list') {
        const items = block.items ?? [];
        return h(
          block.ordered === true ? 'ol' : 'ul',
          { key, style: { margin: 0, paddingLeft: '20px' } },
          items.map((item, i) =>
            h('li', { key: `i${i}`, style: { margin: '2px 0' } }, stripInlineEmphasis(item)),
          ),
        );
      }
      return h('p', { key, style: { margin: 0, whiteSpace: 'pre-wrap' } }, stripInlineEmphasis(block.text ?? ''));
    }),
  );
}
