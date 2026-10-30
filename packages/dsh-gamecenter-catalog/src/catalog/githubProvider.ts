import {
  protocolError,
  type CatalogEntryView,
  type CatalogSourceKey,
} from '@dsh-gamecenter/protocol'
import {
  type CatalogProvider,
  type CatalogFetchOptions,
  type CatalogFetchResult,
  type CatalogReconciliationResult,
  type ICatalogCacheStore,
} from './types.js'
import { parseGitHubIssuePayload } from './issueParser.js'
import { mergeCatalogEntries } from './cacheStore.js'

export type HttpFetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface GitHubCatalogProviderOptions {
  scopeKey?: string
  owner: string
  repo: string
  fetcher?: HttpFetcher | undefined
  cacheStore?: ICatalogCacheStore | undefined
  token?: string | undefined
  apiBaseUrl?: string | undefined
}

export class GitHubCatalogProvider implements CatalogProvider {
  readonly forge = 'github' as const
  readonly owner: string
  readonly repo: string
  private readonly fetcher: HttpFetcher
  private readonly cacheStore?: ICatalogCacheStore | undefined
  private readonly token?: string | undefined
  private readonly apiBaseUrl: string
  private readonly inFlight = new Map<string, Promise<CatalogFetchResult>>()

  constructor(options: GitHubCatalogProviderOptions) {
    this.owner = options.owner
    this.repo = options.repo
    this.fetcher = options.fetcher ?? (globalThis as any).fetch
    this.cacheStore = options.cacheStore
    this.token = options.token
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com'
  }

  async fetchEntries(options: CatalogFetchOptions = {}): Promise<CatalogFetchResult> {
    const flightKey = `${options.cursor ?? ''}:${options.since ?? ''}:${options.ifNoneMatch ?? ''}:${options.ifModifiedSince ?? ''}`
    const active = this.inFlight.get(flightKey)
    if (active) {
      return active
    }
    const task = this.doFetchEntries(options)
    this.inFlight.set(flightKey, task)
    try {
      return await task
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  private async doFetchEntries(options: CatalogFetchOptions): Promise<CatalogFetchResult> {
    const url = new URL(`${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues`)
    url.searchParams.set('state', 'open')
    url.searchParams.set('per_page', '50')
    if (options.since) {
      url.searchParams.set('since', options.since)
    }
    if (options.cursor) {
      url.searchParams.set('page', options.cursor)
    }

    let ifNoneMatch = options.ifNoneMatch
    let ifModifiedSince = options.ifModifiedSince
    if (!ifNoneMatch && !ifModifiedSince && this.cacheStore) {
      const cached = await this.cacheStore.load()
      if (cached) {
        if (cached.etag) ifNoneMatch = cached.etag
        if (cached.lastModified) ifModifiedSince = cached.lastModified
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'dsh-gamecenter-catalog',
    }
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`
    }
    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch
    }
    if (ifModifiedSince) {
      headers['If-Modified-Since'] = ifModifiedSince
    }

    let response: Response
    try {
      response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers,
      })
    } catch (err) {
      // 离线策略：网络异常时，尝试从缓存读取，不抹掉缓存
      if (this.cacheStore) {
        const cached = await this.cacheStore.load()
        if (cached) {
          return {
            entries: cached.entries,
            etag: cached.etag,
            lastModified: cached.lastModified,
            notModified: true,
            offline: true,
            error: {code:'INTERNAL', message:err instanceof Error ? err.message : String(err)},
          }
        }
      }
      throw protocolError('INTERNAL', `网络同步目录失败: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 304 Not Modified
    if (response.status === 304) {
      const cached = this.cacheStore ? await this.cacheStore.load() : null
      if (cached && this.cacheStore) await this.cacheStore.save({...cached, fetchedAt:new Date().toISOString()})
      return {
        entries: cached ? cached.entries : [],
        etag: ifNoneMatch,
        lastModified: ifModifiedSince,
        notModified: true,
      }
    }

    // 限流处理 (403 / 429)
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      if (remaining === '0' || response.status === 429) {
        throw protocolError(
          'RATE_LIMIT',
          'GitHub API 请求频率或额度超限，请稍后重试',
          { status: response.status },
        )
      }
      throw protocolError('PROTOCOL_INVALID', `GitHub API 访问被拒绝: ${response.status}`)
    }

    if (!response.ok) {
      throw protocolError('PROTOCOL_INVALID', `GitHub API 返回非预期状态码: ${response.status}`)
    }

    const rawData = await response.json()
    if (!Array.isArray(rawData)) {
      throw protocolError('PROTOCOL_INVALID', 'GitHub API 返回的 Issues 列表不是数组')
    }

    const validEntries: CatalogEntryView[] = []
    for (const item of rawData) {
      const parseRes = parseGitHubIssuePayload(item, {
        owner: this.owner,
        repo: this.repo,
      })
      if (parseRes.ok) {
        validEntries.push(parseRes.entryView)
      }
      // 非合规项（如 PR 或非游戏条目）被静默忽略或记录，不中断合法项解析
    }

    const etag = response.headers.get('etag') ?? undefined
    const lastModified = response.headers.get('last-modified') ?? undefined
    const nextCursor = extractNextPageCursor(response.headers.get('link'))

    // 更新持久缓存
    if (this.cacheStore) {
      const existing = await this.cacheStore.load()
      const merged = existing ? mergeCatalogEntries(existing.entries, validEntries) : validEntries
      await this.cacheStore.save({
        entries: merged,
        fetchedAt: new Date().toISOString(),
        etag,
        lastModified,
      })
    }

    return {
      entries: validEntries,
      nextCursor,
      etag,
      lastModified,
      notModified: false,
    }
  }

  async reconcile(knownKeys: readonly CatalogSourceKey[]): Promise<CatalogReconciliationResult> {
    const fetchRes = await this.fetchEntries()
    const activeKeySet = new Set(
      fetchRes.entries.map((e) => `${e.key.forge}:${e.key.owner}/${e.key.repo}#${e.key.issueId}`),
    )

    const added: CatalogEntryView[] = []
    const updated: CatalogEntryView[] = []
    const removed: CatalogSourceKey[] = []

    const knownKeyMap = new Map<string, CatalogSourceKey>()
    for (const k of knownKeys) {
      knownKeyMap.set(`${k.forge}:${k.owner}/${k.repo}#${k.issueId}`, k)
    }

    for (const entry of fetchRes.entries) {
      const kStr = `${entry.key.forge}:${entry.key.owner}/${entry.key.repo}#${entry.key.issueId}`
      if (knownKeyMap.has(kStr)) {
        updated.push(entry)
      } else {
        added.push(entry)
      }
    }

    for (const [kStr, key] of knownKeyMap.entries()) {
      if (!activeKeySet.has(kStr)) {
        removed.push(key)
      }
    }

    return { added, updated, removed }
  }
}

function extractNextPageCursor(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined
  const match = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(linkHeader)
  return match ? match[1] : undefined
}
