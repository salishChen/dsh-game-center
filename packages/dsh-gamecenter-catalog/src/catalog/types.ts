import type {
  CatalogMachineEntry,
  ApprovedRelease,
  CatalogSourceKey,
  CatalogEntryView,
  InstallRejection,
  InstallPlan,
  ErrorCode,
} from '@dsh-gamecenter/protocol'

export type {
  CatalogMachineEntry,
  ApprovedRelease,
  CatalogSourceKey,
  CatalogEntryView,
  InstallRejection,
  InstallPlan,
  ErrorCode,
}

export interface CatalogFetchOptions {
  /** 增量拉取起始时间（ISO 8601），推荐携带重叠时间窗口 */
  since?: string | undefined
  /** 分页游标或页码标记 */
  cursor?: string | undefined
  /** HTTP ETag 条件请求头 */
  ifNoneMatch?: string | undefined
  /** HTTP Last-Modified 条件请求头 */
  ifModifiedSince?: string | undefined
}

export interface CatalogFetchResult {
  entries: CatalogEntryView[]
  nextCursor?: string | undefined
  etag?: string | undefined
  lastModified?: string | undefined
  notModified?: boolean | undefined
  offline?: boolean
  error?: {code:string; message:string}
}

export interface CatalogReconciliationResult {
  added: CatalogEntryView[]
  updated: CatalogEntryView[]
  removed: CatalogSourceKey[]
}

export interface CatalogProvider {
  /**
   * 发现来源。`remote` 表示条目由后台聚合后经 HTTP 下发（阶段 3），
   * 条目自身的来源身份仍是 `CatalogSourceKey` 里的 github/gitee。
   */
  readonly forge: 'github' | 'gitee' | 'remote'
  /** 目录仓库归属；远端目录没有仓库归属，可省略。 */
  readonly owner?: string | undefined
  readonly repo?: string | undefined
  /** 该来源在本地缓存里的稳定标识（远端为后台地址的稳定摘要）。 */
  readonly scopeKey?: string | undefined

  /** 同步目录条目（支持分页、条件请求与增量窗口） */
  fetchEntries(options?: CatalogFetchOptions): Promise<CatalogFetchResult>

  /** 全量或增量对账，识别关闭、删除与取消上架条目 */
  reconcile(knownKeys: readonly CatalogSourceKey[]): Promise<CatalogReconciliationResult>
}

export interface CatalogCacheSnapshot {
  entries: CatalogEntryView[]
  fetchedAt: string
  etag?: string | undefined
  lastModified?: string | undefined
}

export interface ICatalogCacheStore {
  load(): Promise<CatalogCacheSnapshot | null>
  save(snapshot: CatalogCacheSnapshot): Promise<void>
}

export type EvaluateInstallResult =
  | {
      installable: true
      approval: ApprovedRelease
      plan: InstallPlan
    }
  | {
      installable: false
      code: ErrorCode
      reason: string
    }
