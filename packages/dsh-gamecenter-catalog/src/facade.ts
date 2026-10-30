import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  isSafePathSegment,
  isSafeBundlePath,
  bundleContentBytes,
  validateGameBundleFiles,
  validateDisplayMetadata,
  evaluateCompatibility,
  resolveRunningVersions,
  sdkRangeAccepts,
  type CatalogMachineEntry,
  type ApprovedRelease,
  type CatalogListWireResult,
  type CatalogListWireEntry,
  type CatalogInstallWireResult,
  type GameBundleWireResult,
  type GameBundleWireFile,
  type GameManifestV1,
  type CatalogCompatibility,
  type CatalogDisplayMetadata,
  type RuntimeVersionObservation,
} from '@dsh-gamecenter/protocol'
import { evaluateInstallability } from './catalog/approvalMatcher.js'
import {
  GitHubCatalogProvider,
  type HttpFetcher,
  type GitHubCatalogProviderOptions,
} from './catalog/githubProvider.js'
import { FileCatalogCacheStore } from './catalog/cacheStore.js'
import type { ICatalogCacheStore, CatalogProvider } from './catalog/types.js'
import { installGamePackage, uninstallGamePackage } from './install/installer.js'
import type { InstallReporter, InstallSourceFile, InstallSecurityLimits } from './install/types.js'

const cacheIds = new WeakMap<object, number>()
let cacheSequence = 0
function cacheIdentity(cache: object): string { if (!cacheIds.has(cache)) cacheIds.set(cache, ++cacheSequence); return String(cacheIds.get(cache)) }

export const githubProviderPool = new Map<string, GitHubCatalogProvider>()

export function getOrCreateGitHubProvider(options: GitHubCatalogProviderOptions): GitHubCatalogProvider {
  if (options.fetcher && !options.scopeKey) return new GitHubCatalogProvider(options)
  const poolKey = `${options.owner}/${options.repo}:${options.token ?? ''}:${options.apiBaseUrl ?? ''}:${options.scopeKey ?? ''}:${options.fetcher ? cacheIdentity(options.fetcher) : ''}`
  let existing = githubProviderPool.get(poolKey)
  if (!existing) {
    existing = new GitHubCatalogProvider(options)
    githubProviderPool.set(poolKey, existing)
  }
  return existing
}

export function clearGitHubProviderPool(): void {
  githubProviderPool.clear()
}

export interface PrepareInstallOptions {
  entry: CatalogMachineEntry
  approvals: readonly ApprovedRelease[]
  gameLibraryDir: string
  stagingDir: string
  fetcher?: HttpFetcher | undefined
  bundledSource?: {
    manifestContent: string | Uint8Array | Buffer
    files: readonly InstallSourceFile[]
  } | undefined
  limits?: InstallSecurityLimits | undefined
  compatibility?: CatalogCompatibility | undefined
  runningVersions?: { gameCenter: string; dsh: string } | null | undefined
  gameCenterObservation?: RuntimeVersionObservation | null | undefined
  dshObservation?: RuntimeVersionObservation | null | undefined
  /** 可选安装上报钩子；缺省时安装行为不变（统计永不参与门禁）。 */
  reporter?: InstallReporter | undefined
}

/**
 * 校验平台兼容性与五元组审批 → 取产物（或直接使用传入产物） → 校验摘要/路径/体积 → 隔离安装。
 *
 * 保证：
 * 0. 安装前门禁：evaluateCompatibility 实跑判定，不满足或未解析版本一律 fail closed；
 * 1. 严格按 commit 隔离安装到 `<gameLibraryDir>/<gameId>/<commit>/`；
 * 2. 旧版本不覆盖：若已安装返回 alreadyInstalled: true；
 * 3. 任何一项校验不符显式拒绝，绝不装半成品或降级安装；
 * 4. 零脚本执行。
 */
export async function prepareInstall(
  options: PrepareInstallOptions,
): Promise<CatalogInstallWireResult> {
  const { entry, approvals, gameLibraryDir, stagingDir, bundledSource, limits, reporter } = options

  // 0. 安装前门禁：平台版本兼容性校验 (evaluateCompatibility)
  const compatibility = options.compatibility ?? entry.display?.compatibility
  if (compatibility) {
    let running = options.runningVersions
    if (!running && (options.gameCenterObservation !== undefined || options.dshObservation !== undefined)) {
      const pair = resolveRunningVersions(options.gameCenterObservation, options.dshObservation)
      if (pair.ok) {
        running = pair.pair
      } else {
        const failReason = pair.resolutions.find((r) => !r.ok) as any
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `无法确定当前运行的 DSH/游戏中心版本，已阻止安装 (COMPAT_UNRESOLVED): ${failReason?.reason ?? 'unresolved'}`,
        }
      }
    }
    if (!running) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '无法确定当前运行的 DSH/游戏中心版本，已阻止安装 (COMPAT_UNRESOLVED)',
      }
    }
    const compatResult = evaluateCompatibility(
      compatibility,
      running,
      sdkRangeAccepts,
    )
    if (!compatResult.ok) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `安装前兼容性门禁阻断 (${compatResult.field}): ${compatResult.reason}`,
      }
    }
  }

  // 1. 校验五元组审批
  const evalRes = evaluateInstallability(entry, approvals)
  if (!evalRes.installable) {
    return {
      ok: false,
      errorCode: evalRes.code,
      message: evalRes.reason,
    }
  }

  const { plan } = evalRes
  const targetDir = path.join(gameLibraryDir, plan.gameId, plan.commit)

  // 2. 幂等与隔离保护：已存在则直接返回
  try {
    const stat = await fs.stat(targetDir)
    if (stat.isDirectory()) {
      let entryPath = 'dist/index.html'
      try {
        const manifestRaw = await fs.readFile(path.join(targetDir, plan.manifestPath), 'utf-8')
        const manifest = JSON.parse(manifestRaw) as GameManifestV1
        if (manifest.runtime?.entry) {
          entryPath = manifest.runtime.entry
        }
      } catch {
        // 使用默认入口
      }

      return {
        ok: true,
        gameId: plan.gameId,
        commit: plan.commit,
        installedPath: `${plan.gameId}/${plan.commit}`,
        entryPath,
        alreadyInstalled: true,
      }
    }
  } catch {
    // 目录未安装，继续正常安装流程
  }

  // 3. 确定产物来源
  let manifestContent = bundledSource?.manifestContent
  let files = bundledSource?.files

  if (!manifestContent || !files) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: '无法获取固定提交产物：未提供有效的发布产物文件源',
    }
  }

  // 4. 调用安装器执行校验与原子 Staging 落盘
  const installRes = await installGamePackage({
    plan,
    packagesDir: gameLibraryDir,
    stagingDir,
    files,
    manifestContent,
    limits,
    reporter,
  })

  if (!installRes.ok) {
    return {
      ok: false,
      errorCode: installRes.code,
      message: installRes.reason,
    }
  }

  // 解析 entryPath
  let entryPath = 'dist/index.html'
  try {
    const rawStr =
      typeof manifestContent === 'string'
        ? manifestContent
        : Buffer.from(manifestContent).toString('utf-8')
    const manifest = JSON.parse(rawStr) as GameManifestV1
    if (manifest.runtime?.entry) {
      entryPath = manifest.runtime.entry
    }
  } catch {
    // 使用默认
  }

  return {
    ok: true,
    gameId: plan.gameId,
    commit: plan.commit,
    installedPath: `${plan.gameId}/${plan.commit}`,
    entryPath,
    alreadyInstalled: installRes.alreadyInstalled,
  }
}

export interface ReadInstalledBundleOptions {
  gameLibraryDir: string
  gameId: string
  commit: string
  compatibility?: CatalogCompatibility | undefined
  runningVersions?: { gameCenter: string; dsh: string } | null | undefined
  gameCenterObservation?: RuntimeVersionObservation | null | undefined
  dshObservation?: RuntimeVersionObservation | null | undefined
}

/**
 * 读取已安装游戏提交内的受限白名单文本文件。
 *
 * 安全原则：
 * 0. 启动前门禁：evaluateCompatibility 实跑判定，不满足或未解析版本一律 fail closed；
 * 1. 严格使用 isSafeBundlePath 检查相对路径与后缀白名单；
 * 2. 拒绝符号链接（不跟随）；
 * 3. 超限（单文件超限、总字节超限、文件数超限）显式失败不截断；
 * 4. 返回前调用 validateGameBundleFiles 完成 Host 侧校验。
 */
export { uninstallGamePackage } from './install/installer.js'

export async function readInstalledBundle(
  options: ReadInstalledBundleOptions,
): Promise<GameBundleWireResult> {
  const { gameLibraryDir, gameId, commit, compatibility: optionsCompatibility, runningVersions } = options

  if (!isSafePathSegment(gameId) || !isSafePathSegment(commit)) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `gameId 或 commit 包含非法路径字符：${gameId}/${commit}`,
    }
  }

  const targetDir = path.join(gameLibraryDir, gameId, commit)
  try {
    const dirStat = await fs.stat(targetDir)
    if (!dirStat.isDirectory()) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `安装路径不是目录：${targetDir}`,
      }
    }
  } catch {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `未找到已安装版本：${gameId}/${commit}`,
    }
  }

  // 读取 manifest 获取入口文件路径与兼容性
  let entryPath = 'dist/index.html'
  let manifest: (GameManifestV1 & { compatibility?: CatalogCompatibility }) | null = null
  try {
    const manifestRaw = await fs.readFile(path.join(targetDir, 'gamecenter.json'), 'utf-8')
    manifest = JSON.parse(manifestRaw) as GameManifestV1 & { compatibility?: CatalogCompatibility }
    if (manifest.runtime?.entry) {
      entryPath = manifest.runtime.entry
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `读取游戏 manifest 失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 0. 启动前门禁：平台版本兼容性校验 (evaluateCompatibility)
  const compatibility = optionsCompatibility ?? manifest?.compatibility
  if (compatibility) {
    let running = runningVersions
    if (!running && (options.gameCenterObservation !== undefined || options.dshObservation !== undefined)) {
      const pair = resolveRunningVersions(options.gameCenterObservation, options.dshObservation)
      if (pair.ok) {
        running = pair.pair
      } else {
        const failReason = pair.resolutions.find((r) => !r.ok) as any
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `无法确定当前运行的 DSH/游戏中心版本，已阻止启动 (COMPAT_UNRESOLVED): ${failReason?.reason ?? 'unresolved'}`,
        }
      }
    }
    if (!running) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '无法确定当前运行的 DSH/游戏中心版本，已阻止启动 (COMPAT_UNRESOLVED)',
      }
    }
    const compatResult = evaluateCompatibility(
      compatibility,
      running,
      sdkRangeAccepts,
    )
    if (!compatResult.ok) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `启动前兼容性门禁阻断 (${compatResult.field}): ${compatResult.reason}`,
      }
    }
  }

  // 递归扫描 targetDir 下的所有白名单常规文件
  const bundleFiles: GameBundleWireFile[] = []

  async function walkDir(currentDir: string): Promise<{ ok: boolean; error?: string }> {
    let entries: string[]
    try {
      entries = await fs.readdir(currentDir)
    } catch (e) {
      return { ok: false, error: `读取目录失败: ${currentDir}` }
    }

    for (const name of entries) {
      // 忽略内部安装元数据文件
      if (name === '.dsh-installed.json') continue

      const fullPath = path.join(currentDir, name)
      let stat
      try {
        stat = await fs.lstat(fullPath)
      } catch {
        return { ok: false, error: `无法获取文件状态: ${fullPath}` }
      }

      // 严禁符号链接（不跟随）
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          error: `检测到符号链接 ${fullPath}，禁止包含在游戏产物中`,
        }
      }

      if (stat.isDirectory()) {
        const subRes = await walkDir(fullPath)
        if (!subRes.ok) return subRes
        continue
      }

      if (stat.isFile()) {
        const relPath = path.relative(targetDir, fullPath).replace(/\\/g, '/')
        if (!isSafeBundlePath(relPath)) {
          // 若不是安全白名单文件（如二进制、非白名单后缀或路径异常），显式拒绝
          return {
            ok: false,
            error: `文件路径不安全或后缀不在白名单：${relPath}`,
          }
        }

        const content = await fs.readFile(fullPath, 'utf-8')
        bundleFiles.push({
          path: relPath,
          content,
        })
      }
    }
    return { ok: true }
  }

  const walkResult = await walkDir(targetDir)
  if (!walkResult.ok) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: walkResult.error ?? '扫描游戏文件失败',
    }
  }

  // 调用 protocol 提供的 Host 侧校验函数
  const violations = validateGameBundleFiles(bundleFiles)
  if (violations.length > 0) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
    }
  }

  let totalBytes = 0
  for (const f of bundleFiles) {
    totalBytes += bundleContentBytes(f.content)
  }

  return {
    ok: true,
    gameId,
    commit,
    entryPath,
    files: bundleFiles,
    totalBytes,
  }
}

export interface ListCatalogOptions {
  /** `github` 直连 Issue；`remote` 由后台聚合后下发；`fixture` 只做本地预览。 */
  mode: 'github' | 'fixture' | 'remote'
  approvals: readonly ApprovedRelease[]
  gameLibraryDir?: string | undefined
  cache?: ICatalogCacheStore | undefined
  fetcher?: HttpFetcher | undefined
  provider?: CatalogProvider | undefined
  githubOptions?: {
    owner: string
    repo: string
    token?: string | undefined
    apiBaseUrl?: string | undefined
  } | undefined
  fixtureEntries?: readonly CatalogMachineEntry[] | undefined
  refresh?: boolean | undefined
}

const ALLOWED_IMAGE_HOSTS = ['user-images.githubusercontent.com', 'raw.githubusercontent.com'] as const

/**
 * 解析并校验单条目录条目的展示元数据。
 *
 * 后台（`backend/api.ts`）下发的媒体是**同源相对路径**（`/v1/covers/<gameId>`），
 * 直接交给 `validateDisplayMetadata` 必然失败；而校验是整体 fail-closed 的，
 * 一个媒体字段失败就会把**整块** display（含 summary/descriptionMarkdown）丢掉。
 * 因此这里先克隆 display，把 `cover` 与 `screenshots[]` 里的同源相对路径
 * （以单个 `/` 开头，排除协议相对地址 `//`）补成 `${受信 origin}${url}`，
 * 绝对 URL 一律原样不动，然后再做校验。
 */
function resolveEntryDisplay(
  entry: CatalogMachineEntry,
  trustedMediaOrigins?: readonly string[] | undefined,
): CatalogDisplayMetadata | null {
  if (!entry.display) return null
  const source = entry.display as unknown as Record<string, unknown>
  const origin = trustedMediaOrigins?.[0]?.replace(/\/+$/, '')
  const absolutize = (url: unknown): unknown => {
    if (origin === undefined || origin === '') return url
    if (typeof url !== 'string') return url
    // 只补同源绝对路径；`//host/...` 是协议相对地址（跨源），保持原样交给校验去拒。
    if (!url.startsWith('/') || url.startsWith('//')) return url
    return `${origin}${url}`
  }
  const cloneMedia = (item: unknown): unknown => {
    if (typeof item !== 'object' || item === null) return item
    const media = item as Record<string, unknown>
    const nextUrl = absolutize(media['url'])
    return nextUrl === media['url'] ? { ...media } : { ...media, url: nextUrl }
  }
  const screenshots = source['screenshots']
  const resolved: CatalogDisplayMetadata = {
    ...source,
    repository: (source['repository'] as any) ?? entry.source.repository,
    cover: cloneMedia(source['cover']),
    screenshots: Array.isArray(screenshots) ? screenshots.map(cloneMedia) : screenshots,
  } as CatalogDisplayMetadata
  const violations = validateDisplayMetadata(
    resolved,
    {
      allowedImageHosts: ALLOWED_IMAGE_HOSTS,
      sourceRepository: entry.source.repository,
      trustedMediaOrigins,
    },
  )
  return violations.length === 0 ? resolved : null
}

async function buildCatalogWireEntries(
  items: readonly { entry: CatalogMachineEntry }[],
  approvals: readonly ApprovedRelease[],
  gameLibraryDir?: string | undefined,
  isRemoteSource = false,
  trustedMediaOrigins?: readonly string[] | undefined,
): Promise<CatalogListWireEntry[]> {
  const wireEntries: CatalogListWireEntry[] = []
  for (const item of items) {
    const entry = item.entry
    let approvalState: 'approved' | 'pending' | 'rejected' | 'unknown' = 'unknown'

    // 在 remote 模式下，直接采信后台下发的权威审核通过状态
    if (isRemoteSource && (item as any).approvalState === 'approved') {
      approvalState = 'approved'
    } else {
      const evalRes = evaluateInstallability(entry, approvals)
      if (evalRes.installable) {
        approvalState = 'approved'
      } else {
        const hasHistory = approvals.some((a) => a.gameId === entry.gameId)
        approvalState = hasHistory ? 'pending' : 'unknown'
      }
    }

    const diskStatus = gameLibraryDir
      ? await checkInstalledOnDisk(gameLibraryDir, entry.gameId, entry.source.commit)
      : { installed: false, installedCommit: null }

    const itemAny = item as any
    const rawAny = itemAny.raw as any
    const stats =
      itemAny.stats ??
      (rawAny && typeof rawAny === 'object' && rawAny.stats && typeof rawAny.stats === 'object'
        ? rawAny.stats
        : undefined)
    const updatedAt =
      itemAny.updatedAt ??
      (rawAny && typeof rawAny === 'object' && typeof rawAny.updatedAt === 'string'
        ? rawAny.updatedAt
        : typeof itemAny.fetchedAt === 'string'
          ? itemAny.fetchedAt
          : undefined)

    wireEntries.push({
      gameId: entry.gameId,
      title: entry.title,
      summary: entry.summary,
      categories: entry.categories??[],
      version: entry.version,
      repository: entry.source.repository,
      commit: entry.source.commit,
      manifestDigest: entry.source.manifestDigest,
      bundleDigest: entry.source.bundleDigest,
      approvalState,
      installed: diskStatus.installed,
      installedCommit: diskStatus.installedCommit,
      display: resolveEntryDisplay(entry, trustedMediaOrigins),
      stats,
      updatedAt,
    })
  }
  return wireEntries
}

/**
 * 列出目录条目并组合审批状态与本地安装状态。
 *
 * 硬规则：
 * 1. fixture 模式不得伪造 commit/摘要/审批，条目标记 approvalState: 'unknown'，source: 'fixture'；
 * 2. 真实安装状态依据 gameLibraryDir 磁盘实际判定；
 * 3. 生产缓存策略：进入即展示上次缓存快照（stale: true），后台单飞刷新，失败保留缓存列表。
 */
export async function listCatalog(options: ListCatalogOptions): Promise<CatalogListWireResult> {
  const { mode, approvals, gameLibraryDir, fixtureEntries, githubOptions, cache, fetcher, refresh, provider } =
    options

  if (mode === 'fixture') {
    const rawList = fixtureEntries ?? []
    const wireEntries: CatalogListWireEntry[] = []

    for (const entry of rawList) {
      const diskStatus = gameLibraryDir
        ? await checkInstalledOnDisk(gameLibraryDir, entry.gameId, entry.source.commit)
        : { installed: false, installedCommit: null }

      wireEntries.push({
        gameId: entry.gameId,
        title: entry.title,
        summary: entry.summary,
        categories: entry.categories??[],
        version: entry.version,
        repository: entry.source.repository,
        commit: entry.source.commit,
        manifestDigest: entry.source.manifestDigest,
        bundleDigest: entry.source.bundleDigest,
        // fixture 模式硬规则：不伪造审批，标为 unknown
        approvalState: 'unknown',
        installed: diskStatus.installed,
        installedCommit: diskStatus.installedCommit,
        display: resolveEntryDisplay(entry, []),
      })
    }

    return {
      ok: true,
      source: 'fixture',
      fetchedAt: new Date().toISOString(),
      entries: wireEntries,
    }
  }

  // 网络模式：github（客户端直连 Issue）或 remote（后台聚合后下发）
  const networkMode: 'github' | 'remote' = mode === 'remote' ? 'remote' : 'github'

  if (networkMode === 'github' && !githubOptions) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: 'GitHub 模式必须提供 githubOptions (owner, repo)',
    }
  }
  if (networkMode === 'remote' && !provider) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: '远端模式必须提供 provider（RemoteCatalogProvider 实例）',
    }
  }

  const cacheScope =
    networkMode === 'remote'
      ? `remote_${provider?.scopeKey ?? 'default'}`
      : `github_${githubOptions?.owner ?? ''}_${githubOptions?.repo ?? ''}`

  const effectiveCacheStore =
    cache ??
    (gameLibraryDir
      ? new FileCatalogCacheStore(
          path.join(gameLibraryDir, '.cache', 'catalogs', `${cacheScope}.json`),
        )
      : undefined)

  // 1. Client 进页先读上次快照：若非显式 refresh 且本地有有效缓存，先直接返回缓存旧数据
  const isRemote = networkMode === 'remote'
  // 后台下发的媒体是同源相对路径；受信来源就是这个后台的 origin（构造失败绝不抛，落空数组）。
  // 只在 remote 模式生效：github 模式下不存在"受信后台"，绝不能凭 provider 放行。
  const trustedMediaOrigins: readonly string[] = (() => {
    if (!isRemote || !provider) return []
    // 静态类型是 CatalogProvider（可能来自 GitHub），只有远端 provider 才带后台根地址；
    // 这里按可选属性读取，缺失就当没有受信来源。
    const baseUrl = (provider as unknown as { publicBaseUrl?: string | undefined }).publicBaseUrl
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) return []
    try {
      return [new URL(baseUrl).origin]
    } catch {
      return []
    }
  })()
  if (refresh !== true && effectiveCacheStore) {
    const cached = await effectiveCacheStore.load()
    if (cached && cached.entries.length > 0) {
      const wireEntries = await buildCatalogWireEntries(cached.entries, approvals, gameLibraryDir, isRemote, trustedMediaOrigins)
      return {
        ok: true,
        source: networkMode,
        fetchedAt: cached.fetchedAt,
        entries: wireEntries,
        stale: true,
        dataSource: 'cache',
      }
    }
  }

  if (refresh !== true) return {ok:true, source:networkMode, fetchedAt:'', entries:[], stale:true, dataSource:'cache'}

  const effectiveProvider =
    provider ??
    getOrCreateGitHubProvider({
      scopeKey: cache ? cacheIdentity(cache) : path.resolve(gameLibraryDir || '.'),
      owner: githubOptions!.owner,
      repo: githubOptions!.repo,
      token: githubOptions!.token,
      apiBaseUrl: githubOptions!.apiBaseUrl,
      cacheStore: effectiveCacheStore,
      fetcher,
    })

  try {
    const fetchRes = await effectiveProvider.fetchEntries(refresh ? undefined : { cursor: '1' })
    const wireEntries = await buildCatalogWireEntries(fetchRes.entries, approvals, gameLibraryDir, isRemote, trustedMediaOrigins)

    let fetchedAt = new Date().toISOString()
    if (fetchRes.notModified && effectiveCacheStore) {
      const cached = await effectiveCacheStore.load()
      if (cached?.fetchedAt) fetchedAt = cached.fetchedAt
    }

    return {
      ok: true,
      source: networkMode,
      fetchedAt,
      entries: wireEntries,
      stale: fetchRes.offline === true,
      dataSource: fetchRes.offline ? 'cache' : 'network',
      ...(fetchRes.error ? {error:fetchRes.error} : {}),
    }
  } catch (err: any) {
    if (effectiveCacheStore) {
      const cached = await effectiveCacheStore.load()
      if (cached && cached.entries.length > 0) {
        const wireEntries = await buildCatalogWireEntries(cached.entries, approvals, gameLibraryDir, isRemote, trustedMediaOrigins)

        return {
          ok: true,
          source: networkMode,
          fetchedAt: cached.fetchedAt,
          entries: wireEntries,
          stale: true,
          dataSource: 'cache',
          error: {code: typeof err?.code === 'string' ? err.code : 'INTERNAL', message: String(err?.message || err)},
        }
      }
    }

    const errorCode = typeof err?.code === 'string' ? err.code : 'INTERNAL'
    const statusPart = err?.details?.status ? ` (HTTP ${err.details.status})` : ''
    const message =
      typeof err?.message === 'string'
        ? `${err.message}${statusPart}`
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      ok: false,
      errorCode,
      message,
    }
  }
}

/**
 * 检查某 gameId 在磁盘上是否已安装及其 commit。
 *
 * 判据只认**结构合法的安装目录**：目录名必须是 40 位十六进制提交号，且目录内
 * `gamecenter.json` 的 schemaVersion === 1。`.staging`、`staging-*`、空目录、
 * 崩溃残留、`.dsh-installed.json` 之类的一律不算 —— 否则任何残留文件都会让
 * 游戏重新变成「已安装」，而启动时又找不到真实安装目录，按钮点亮却必然报错。
 */
async function checkInstalledOnDisk(
  gameLibraryDir: string,
  gameId: string,
  preferredCommit?: string,
): Promise<{ installed: boolean; installedCommit: string | null }> {
  if (!isSafePathSegment(gameId)) {
    return { installed: false, installedCommit: null }
  }

  const gameDir = path.join(gameLibraryDir, gameId)
  try {
    const stat = await fs.stat(gameDir)
    if (!stat.isDirectory()) {
      return { installed: false, installedCommit: null }
    }

    const entries = await fs.readdir(gameDir)
    const candidates = entries
      // 只信内容、不信目录名：隐藏/暂存项跳过，其余逐个用 gamecenter.json 验真。
      // 不按「40 位十六进制」过滤，避免哪天提交号换格式后把所有真实安装误判为未安装。
      .filter((name) => !name.startsWith('.'))
      // preferredCommit 优先，其余按目录名稳定排序，保证同样磁盘状态永远给同一答案
      .sort((a, b) => {
        if (preferredCommit) {
          if (a === preferredCommit) return -1
          if (b === preferredCommit) return 1
        }
        return a < b ? -1 : a > b ? 1 : 0
      })

    for (const name of candidates) {
      try {
        const raw = await fs.readFile(path.join(gameDir, name, 'gamecenter.json'), 'utf-8')
        const manifest = JSON.parse(raw) as { schemaVersion?: unknown }
        if (manifest?.schemaVersion === 1) {
          return { installed: true, installedCommit: name }
        }
      } catch {
        // 目录不完整 → 不算已安装，继续看下一个候选
      }
    }

    return { installed: false, installedCommit: null }
  } catch {
    return { installed: false, installedCommit: null }
  }
}
