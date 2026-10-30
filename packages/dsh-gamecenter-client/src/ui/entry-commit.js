// @ts-check
/**
 * 「对一个条目究竟要操作哪个提交」的唯一判定。
 *
 * 【为什么必须区分· 2026-10-27】
 * 目录条目上的 `commit` 是**目录里的最新发布版**，`installedCommit` 才是**磁盘上真正装了的那份**。
 * 两者不等是常态：有的游戏反复重建（扫雷/斗地主都发过多版），用户装的是旧版而目录早已指向新版。
 *
 * 用 `commit` 去卸载，删的是一个不存在的路径，而 `fs.rm({force:true})` 对不存在的路径
 * 同样返回成功 → 假成功 → 界面乐观置为未安装 → 紧接着按真实磁盘重算又弹回「已安装」，
 * 用户看到的就是「卸载没反应、也装不回去」。
 *
 * 用 `commit` 去启动/握手，Host 找不到该提交的安装目录，必然报「未找到已安装版本」。
 *
 * 所以：**已安装且 installedCommit 可用时，一律以 installedCommit 为准**；
 * 只有尚未安装（或刚装完还没来得及刷新）才回落到目录 commit。
 */

/**
 * @typedef {object} EntryCommitLike
 * @property {string} [commit] 目录里的最新发布版提交
 * @property {boolean} [installed] 是否已安装
 * @property {string | null} [installedCommit] 磁盘上实际安装的提交
 */

/**
 * 解析该条目应当被操作的提交号。
 *
 * @param {EntryCommitLike | null | undefined} entry 目录条目
 * @returns {string} 提交号；条目缺失时返回空串，由调用方决定如何报错
 */
export function resolveEntryCommit(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const installedCommit = /** @type {unknown} */ (entry.installedCommit)
  if (entry.installed === true && typeof installedCommit === 'string' && installedCommit.length > 0) {
    return installedCommit
  }
  const commit = /** @type {unknown} */ (entry.commit)
  return typeof commit === 'string' ? commit : ''
}
