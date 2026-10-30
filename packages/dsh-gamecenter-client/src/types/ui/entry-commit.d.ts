/**
 * 「对一个条目究竟要操作哪个提交」的唯一判定（见 src/ui/entry-commit.js）。
 *
 * 已安装且 installedCommit 可用时以 installedCommit 为准，否则回落到目录 commit。
 */

export interface EntryCommitLike {
  /** 目录里的最新发布版提交 */
  commit?: string;
  /** 是否已安装 */
  installed?: boolean;
  /** 磁盘上实际安装的提交 */
  installedCommit?: string | null;
}

/**
 * 解析该条目应当被操作的提交号。
 *
 * @param entry 目录条目
 * @returns 提交号；条目缺失时返回空串
 */
export function resolveEntryCommit(entry: EntryCommitLike | null | undefined): string;
