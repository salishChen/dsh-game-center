/**
 * 目录可见性规则（v3：列表不显示审核中的游戏）。
 *
 * 【规则】用户要求「列表中不显示审核中游戏」：
 * - 真实 GitHub 发现源：只显示 `approvalState === 'approved'`。
 *   `pending`（审核中）/`rejected`（已拒绝）/`unknown`（尚无审批记录）都不显示。
 * - 本地 fixture 模式：全部显示。fixture 是本地开发/预览数据，不是真实上架，
 *   列表上方已有醒目的"本地预览模式"告警；若也过滤，fixture 模式将永远空白，
 *   本地开发与集成测试失去可视界面。
 *
 * 抽成纯函数是为了能被直接断言（UI 渲染成本高，且断言"哪个条目没被渲染"
 * 容易变成假阳性）。
 */
/**
 * @typedef {object} VisibleEntryLike
 * @property {string} gameId
 * @property {'approved' | 'pending' | 'rejected' | 'unknown'} approvalState
 */
/**
 * 过滤出应当显示的条目。
 *
 * 用泛型保留调用方的完整条目类型（CatalogEntry 含 commit/display/installed 等字段），
 * 避免把窄类型带进渲染层。
 *
 * @template {VisibleEntryLike} T
 * @param {readonly T[]} entries 全部目录条目
 * @param {boolean} isFixture 是否为本地 fixture 来源
 * @returns {T[]}
 */
export function selectVisibleEntries<T extends VisibleEntryLike>(entries: readonly T[], isFixture: boolean): T[];
/**
 * 被隐藏的条目数（用于如实告知玩家，不静默隐藏）。
 *
 * @param {readonly VisibleEntryLike[]} entries 全部目录条目
 * @param {boolean} isFixture 是否为本地 fixture 来源
 * @returns {number}
 */
export function countHiddenEntries(entries: readonly VisibleEntryLike[], isFixture: boolean): number;
export type VisibleEntryLike = {
    gameId: string;
    approvalState: "approved" | "pending" | "rejected" | "unknown";
};
