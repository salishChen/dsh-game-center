import {
  catalogSourceKeyString,
  parseCatalogIssueBody,
  protocolError,
  type CatalogEntryView,
  type CatalogMachineEntry,
  type CatalogSourceKey,
  type ErrorCode,
} from '@dsh-gamecenter/protocol'
import type {
  CatalogFetchOptions,
  CatalogFetchResult,
  CatalogProvider,
  CatalogReconciliationResult,
  ICatalogCacheStore,
} from './types.js'
import { mergeCatalogEntries } from './cacheStore.js'
import type { HttpFetcher } from './githubProvider.js'

/**
 * 远端目录 Provider（阶段 3，拟新增）。
 *
 * 与 `GitHubCatalogProvider` 的差别只在「发现来源」：Issue 扫描由后台完成，
 * Provider 只通过 HTTP 取已经登记好的条目。信任根不因此移动——
 * 安装门禁仍由客户端本地 `authorizeInstall(entry, approvals)` 复核五元组。
 *
 * 约束（与后台约定一致）：
 * - 后台不存游戏产物，只登记 release 链接与元数据；下载仍直连 GitHub。
 * - 机器块必须能被 `parseCatalogIssueBody` 解析通过，客户端不实现第二套解析。
 * - 网络异常时返回上次成功缓存（`offline: true`），不抹掉缓存。
 */

/** 单次同步允许读取的最大响应体；后台是受信服务，但客户端仍需限长。 */
export const REMOTE_CATALOG_MAX_BYTES = 4 * 1024 * 1024

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/

/** 来源身份：契约字段名为 `source`；早期草案的 `key` 仅作兼容读取。 */
export interface RemoteCatalogSource {
  forge: 'github' | 'gitee'
  owner: string
  repo: string
  issueId: string
}

/**
 * 后台登记的单个条目（契约 §3 条款 9–11）。
 *
 * 可用条目的必需项是 `source` + (`machine` 或 `raw`)：
 * - `machine`：Issue 机器块同构对象，客户端用同一解析器校验；
 * - `raw`：机器块原始副本，`machine` 缺省时以它代替。
 * 缺任一项的条目直接跳过，禁止猜身份或填空机器块——那会造出"能看不能装"的伪条目。
 */
export interface RemoteCatalogItem {
  source?: RemoteCatalogSource | undefined
  /** @deprecated 早期草案字段名，仅为兼容读取；新数据只用 `source`。 */
  key?: RemoteCatalogSource | undefined
  machine?: CatalogMachineEntry | undefined
  raw?: unknown
  stale?: boolean | undefined
  scannedAt?: string | undefined
}

export interface RemoteCatalogPayload {
  schemaVersion: 1
  /** 契约字段名。 */
  entries?: RemoteCatalogItem[] | undefined
  /** @deprecated 早期草案字段名，仅为兼容读取；新数据只用 `entries`。 */
  items?: RemoteCatalogItem[] | undefined
  nextCursor?: string | undefined
  stale?: boolean | undefined
  scannedAt?: string | undefined
}

export interface RemoteCatalogProviderOptions {
  /** 后台 API 根地址，例如 `https://games.example.com/v1`。 */
  baseUrl: string
  fetcher?: HttpFetcher | undefined
  cacheStore?: ICatalogCacheStore | undefined
  /** 后台签发的只读 token；只放在 Host 侧，不进 Client/iframe。 */
  token?: string | undefined
  /** 本地缓存标识；缺省用后台域名。 */
  scopeKey?: string | undefined
  now?: (() => Date) | undefined
}

export class RemoteCatalogProvider implements CatalogProvider {
  readonly forge = 'remote' as const
  /** 本地缓存标识：同一后台地址的缓存互不复用。 */
  readonly scopeKey: string
  private readonly baseUrl: string
  private readonly fetcher: HttpFetcher
  private readonly cacheStore?: ICatalogCacheStore | undefined
  private readonly token?: string | undefined
  private readonly now: () => Date
  private readonly inFlight = new Map<string, Promise<CatalogFetchResult>>()

  /**
   * 后台 API 根地址（已去尾斜杠），供门面把后台返回的相对媒体路径解析成绝对地址。
   *
   * 只读暴露：门面据此推出受信 origin（`new URL(publicBaseUrl).origin`），
   * 再把 `display.cover.url = "/v1/covers/<gameId>"` 这类同源相对路径补成绝对 URL。
   */
  get publicBaseUrl(): string {
    return this.baseUrl
  }

  constructor(options: RemoteCatalogProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.scopeKey = options.scopeKey ?? safeHost(this.baseUrl)
    this.fetcher = options.fetcher ?? (globalThis as { fetch: HttpFetcher }).fetch
    this.cacheStore = options.cacheStore
    this.token = options.token
    this.now = options.now ?? (() => new Date())
  }

  async fetchEntries(options: CatalogFetchOptions = {}): Promise<CatalogFetchResult> {
    const flightKey = `${options.cursor ?? ''}:${options.since ?? ''}:${options.ifNoneMatch ?? ''}`
    const active = this.inFlight.get(flightKey)
    if (active) return active
    const task = this.doFetchEntries(options)
    this.inFlight.set(flightKey, task)
    try {
      return await task
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  private async doFetchEntries(options: CatalogFetchOptions): Promise<CatalogFetchResult> {
    const url = new URL(`${this.baseUrl}/catalog`)
    url.searchParams.set('limit', '50')
    if (options.since) url.searchParams.set('updatedSince', options.since)
    if (options.cursor) url.searchParams.set('cursor', options.cursor)

    let ifNoneMatch = options.ifNoneMatch
    if (!ifNoneMatch && this.cacheStore) {
      const cached = await this.cacheStore.load()
      if (cached?.etag) ifNoneMatch = cached.etag
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'dsh-gamecenter-catalog',
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch

    let response: Response
    try {
      response = await this.fetcher(url.toString(), { method: 'GET', headers })
    } catch (err) {
      // 离线回退：后台不可达时用上次成功目录，绝不抹缓存。
      // 错误码用 CATALOG_UNREACHABLE 而不是 INTERNAL：这确实是"连不上后台"，
      // 用兜底码会让调用方把它和"内部实现出错"混为一谈。
      if (this.cacheStore) {
        const cached = await this.cacheStore.load()
        if (cached) {
          return {
            entries: cached.entries,
            etag: cached.etag,
            notModified: true,
            offline: true,
            error: { code: 'CATALOG_UNREACHABLE', message: errText(err) },
          }
        }
      }
      throw protocolError('CATALOG_UNREACHABLE', `远端目录不可达: ${errText(err)}`)
    }

    if (response.status === 304) {
      const cached = this.cacheStore ? await this.cacheStore.load() : null
      return {
        entries: cached ? cached.entries : [],
        etag: ifNoneMatch,
        notModified: true,
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw protocolError('CREDENTIAL_REQUIRED', `远端目录鉴权失败: ${response.status}`)
    }
    if (response.status === 429 || response.status >= 500) {
      throw protocolError('RATE_LIMIT', `远端目录暂不可用: ${response.status}`, {
        status: response.status,
      })
    }
    if (!response.ok) {
      throw protocolError('PROTOCOL_INVALID', `远端目录返回非预期状态码: ${response.status}`)
    }

    const text = await response.text()
    if (utf8Length(text) > REMOTE_CATALOG_MAX_BYTES) {
      throw protocolError('PROTOCOL_INVALID', `远端目录响应超过 ${REMOTE_CATALOG_MAX_BYTES} 字节`)
    }

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (err) {
      throw protocolError('PROTOCOL_INVALID', `远端目录响应不是合法 JSON: ${errText(err)}`)
    }

    const parsed = parsePayload(payload)
    if (!parsed.ok) {
      throw protocolError(parsed.code, parsed.reason)
    }

    const fetchedAt = this.now().toISOString()
    const etag = response.headers.get('etag') ?? undefined
    const lastModified = response.headers.get('last-modified') ?? undefined

    if (this.cacheStore) {
      const existing = await this.cacheStore.load()
      const merged = existing ? mergeCatalogEntries(existing.entries, parsed.entries) : parsed.entries
      await this.cacheStore.save({ entries: merged, fetchedAt, etag, lastModified })
    }

    return {
      entries: parsed.entries,
      nextCursor: parsed.nextCursor,
      etag,
      lastModified,
      notModified: false,
    }
  }

  async reconcile(knownKeys: readonly CatalogSourceKey[]): Promise<CatalogReconciliationResult> {
    const fetchRes = await this.fetchEntries()
    const known = new Map<string, CatalogSourceKey>()
    for (const key of knownKeys) known.set(catalogSourceKeyString(key), key)

    const active = new Set<string>()
    const added: CatalogEntryView[] = []
    const updated: CatalogEntryView[] = []
    for (const entry of fetchRes.entries) {
      const k = catalogSourceKeyString(entry.key)
      active.add(k)
      if (known.has(k)) updated.push(entry)
      else added.push(entry)
    }

    const removed: CatalogSourceKey[] = []
    for (const [k, key] of known) {
      if (!active.has(k)) removed.push(key)
    }
    return { added, updated, removed }
  }
}

type ParsePayloadResult =
  | { ok: true; entries: CatalogEntryView[]; nextCursor?: string | undefined }
  | { ok: false; code: ErrorCode; reason: string }

/**
 * 严格校验后台载荷：形状、来源身份、机器块都必须合法。
 * 单个条目非法时跳过（与 GitHub Provider 忽略 PR 的语义一致），
 * 但整批全部非法时视为协议错误，避免「空目录」掩盖后台故障。
 */
export function parsePayload(payload: unknown): ParsePayloadResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: 'PROTOCOL_INVALID', reason: '远端目录载荷必须是对象' }
  }
  const body = payload as Record<string, unknown>
  if (body['schemaVersion'] !== 1) {
    return { ok: false, code: 'PROTOCOL_INVALID', reason: '远端目录 schemaVersion 只支持 1' }
  }
  const items = Array.isArray(body['entries']) ? body['entries'] : body['items']
  if (!Array.isArray(items)) {
    return { ok: false, code: 'PROTOCOL_INVALID', reason: '远端目录 entries 必须是数组' }
  }

  const entries: CatalogEntryView[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const entry = parseItem(item)
    if (!entry) continue
    const k = catalogSourceKeyString(entry.key)
    if (seen.has(k)) continue
    seen.add(k)
    entries.push(entry)
  }

  if (entries.length === 0 && items.length > 0) {
    return { ok: false, code: 'PROTOCOL_INVALID', reason: '远端目录没有任何合法条目' }
  }

  const nextCursor = typeof body['nextCursor'] === 'string' ? body['nextCursor'] : undefined
  return { ok: true, entries, nextCursor }
}

function parseItem(item: unknown): CatalogEntryView | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const key = parseSourceKey(record['source'] ?? record['key'])
  if (!key) return null

  // 必需项：source + (machine 或 raw)。两者都没有时跳过，禁止填空机器块。
  const machineInput = record['machine'] ?? record['raw']
  if (typeof machineInput !== 'object' || machineInput === null) return null

  // 复用 Issue 机器块解析器：客户端不存在第二套字段校验。
  const fenced = `\`\`\`gamecenter-json\n${JSON.stringify(machineInput)}\n\`\`\``
  const parsed = parseCatalogIssueBody(fenced)
  if (!parsed.ok) return null

  const scannedAt = typeof record['scannedAt'] === 'string' ? record['scannedAt'] : undefined
  const raw = record['raw'] ?? machineInput
  const rawApproval = typeof record['approvalState'] === 'string' ? record['approvalState'] : undefined
  const approvalState: CatalogEntryView['approvalState'] =
    rawApproval === 'approved' ? 'approved' : rawApproval === 'pending' ? 'pending' : rawApproval === 'rejected' ? 'rejected' : 'unknown'
  const stats =
    record['stats'] && typeof record['stats'] === 'object'
      ? (record['stats'] as { downloads?: number; installs?: number })
      : undefined
  const updatedAt =
    typeof record['updatedAt'] === 'string'
      ? record['updatedAt']
      : typeof record['publishedAt'] === 'string'
        ? record['publishedAt']
        : undefined

  return {
    key,
    entry: parsed.entry,
    approvalState,
    fetchedAt: scannedAt ?? new Date().toISOString(),
    raw: raw as unknown as CatalogEntryView['raw'],
    stats,
    updatedAt,
  }
}

function parseSourceKey(value: unknown): CatalogSourceKey | null {
  if (typeof value !== 'object' || value === null) return null
  const key = value as Record<string, unknown>
  const forge = key['forge']
  if (forge !== 'github' && forge !== 'gitee') return null
  const owner = key['owner']
  const repo = key['repo']
  const issueId = key['issueId']
  if (typeof owner !== 'string' || !NAME_PART.test(owner)) return null
  if (typeof repo !== 'string' || !NAME_PART.test(repo)) return null
  if (typeof issueId !== 'string' || issueId.length === 0 || issueId.length > 64) return null
  return { forge, owner, repo, issueId }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  } catch {
    return 'unknown'
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
