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
export function parseRestrictedMarkdown(text: string): MarkdownBlock[];
/**
 * 去掉行内 `**` / `*` 标记（只作为纯文本呈现，不产生任何标记效果）。
 * @param {string} text
 * @returns {string}
 */
export function stripInlineEmphasis(text: string): string;
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
export function SafeMarkdown(props: {
    text: string;
    display?: any;
    repository?: string | undefined;
    className?: string | undefined;
    rejectedNotice?: string | undefined;
}): any;
export type MarkdownBlock = {
    kind: "heading" | "list" | "paragraph";
    /**
     * heading 级别 1..6
     */
    level?: number;
    /**
     * 是否有序列表
     */
    ordered?: boolean;
    /**
     * 列表项文本
     */
    items?: string[];
    /**
     * 段落文本
     */
    text?: string;
};
