/**
 * DSH 版本锁定与兼容矩阵的唯一数据源。
 *
 * 证据来源（详见 docs/phase0-architecture.md §2）：
 * - 基线引用提交：GitHub API 查询该提交的 commit message 为
 *   "release: next version dsh@0.2.1-rc.2"（2026-10-17T07:22:43Z）。
 * - 实装版本：node 直读
 *   D:\Program Files\deepseek harness\resources\app.asar 内 package.json，
 *   得到 @deepseek-ai/dsh-desktop 0.2.1-rc.2 / dshBuildCommit 332895e0… / dirty=false / nightly。
 *
 * 这里区分 `designBaseline` 与 `localVerified`：两者不是同一提交时，
 * **不得**把其中任何一个当作跨版本兼容承诺。
 */

export interface DshVersionLock {
  /** 设计基线与官方文档引用的提交。 */
  designBaselineCommit: string
  /** 设计基线提交对应的 dsh 包版本。 */
  designBaselineDshVersion: string
  /** 本机实际安装并用于阶段0验证的构建。 */
  localVerified: {
    productName: string
    productVersion: string
    dshVersion: string
    buildCommit: string
    buildDirty: boolean
    updateChannel: string
    electronVersion: string
  }
  /** 阶段0 证据只对下列范围有效。 */
  claimsScope: string
  /** 明确不作承诺的范围。 */
  notClaimed: string[]
}

export const DSH_VERSION_LOCK: DshVersionLock = {
  designBaselineCommit: '687f282e8625c6b8d11ff58211a90524be2e4317',
  designBaselineDshVersion: '0.2.1-rc.2',
  localVerified: {
    productName: '@deepseek-ai/dsh-desktop',
    productVersion: '0.2.1-rc.2',
    dshVersion: '0.2.1-rc.2',
    buildCommit: '332895e0f7c9d4dbfb29729f5eb367fa263ff986',
    buildDirty: false,
    updateChannel: 'nightly',
    electronVersion: '43.3.0',
  },
  claimsScope:
    '仅对 @deepseek-ai/dsh-desktop 0.2.1-rc.2 / dshBuildCommit 332895e0f7c9d4dbfb29729f5eb367fa263ff986 / dirty=false 的本机安装有效',
  notClaimed: [
    '不对 master 或任何未验证的 nightly 构建作兼容承诺',
    '不声称基线提交 687f282e 与实装提交 332895e0 之间无差异（差异清单尚未产出）',
    '不声称尚未实际观察到行为的扩展点（如 Remote contribution 注入、shell.overlay 并列）可用',
  ],
}

/** 宿主插件对 DSH 的最小 engines 声明（供插件 package.json 的 dsh.engines 使用）。 */
export const DSH_ENGINES_RANGE = '>=0.2.0-rc.2' as const
