import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  isSafePathSegment,
  isSafeBundlePath,
  bundleContentBytes,
  validateGameBundleFiles,
  type CatalogMachineEntry,
  type ApprovedRelease,
  type CatalogListWireResult,
  type CatalogListWireEntry,
  type CatalogInstallWireResult,
  type GameBundleWireResult,
  type GameBundleWireFile,
  type GameManifestV1,
} from '@dsh-gamecenter/protocol'
import { evaluateInstallability } from './catalog/approvalMatcher.js'
import { GitHubCatalogProvider, type HttpFetcher } from './catalog/githubProvider.js'
import type { ICatalogCacheStore } from './catalog/types.js'
import { installGamePackage } from './install/installer.js'
import type { InstallSourceFile, InstallSecurityLimits } from './install/types.js'

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
}

/**
 * 校验五元组审批 → 取产物（或直接使用传入产物） → 校验摘要/路径/体积 → 隔离安装。
 *
 * 保证：
 * 1. 严格按 commit 隔离安装到 `<gameLibraryDir>/<gameId>/<commit>/`；
 * 2. 旧版本不覆盖：若已安装返回 alreadyInstalled: true；
 * 3. 任何一项校验不符显式拒绝，绝不装半成品或降级安装；
 * 4. 零脚本执行。
 */
export async function prepareInstall(
  options: PrepareInstallOptions,
): Promise<CatalogInstallWireResult> {
  const { entry, approvals, gameLibraryDir, stagingDir, bundledSource, limits } = options

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
}

/**
 * 读取已安装游戏提交内的受限白名单文本文件。
 *
 * 安全原则：
 * 1. 严格使用 isSafeBundlePath 检查相对路径与后缀白名单；
 * 2. 拒绝符号链接（不跟随）；
 * 3. 超限（单文件超限、总字节超限、文件数超限）显式失败不截断；
 * 4. 返回前调用 validateGameBundleFiles 完成 Host 侧校验。
 */
export async function readInstalledBundle(
  options: ReadInstalledBundleOptions,
): Promise<GameBundleWireResult> {
  const { gameLibraryDir, gameId, commit } = options

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

  // 读取 manifest 获取入口文件路径
  let entryPath = 'dist/index.html'
  try {
    const manifestRaw = await fs.readFile(path.join(targetDir, 'gamecenter.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw) as GameManifestV1
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
  mode: 'github' | 'fixture'
  approvals: readonly ApprovedRelease[]
  gameLibraryDir?: string | undefined
  cache?: ICatalogCacheStore | undefined
  fetcher?: HttpFetcher | undefined
  githubOptions?: {
    owner: string
    repo: string
    token?: string | undefined
    apiBaseUrl?: string | undefined
  } | undefined
  fixtureEntries?: readonly CatalogMachineEntry[] | undefined
  refresh?: boolean | undefined
}

/**
 * 列出目录条目并组合审批状态与本地安装状态。
 *
 * 硬规则：
 * 1. fixture 模式不得伪造 commit/摘要/审批，条目标记 approvalState: 'unknown'，source: 'fixture'；
 * 2. 真实安装状态依据 gameLibraryDir 磁盘实际判定。
 */
export async function listCatalog(options: ListCatalogOptions): Promise<CatalogListWireResult> {
  const { mode, approvals, gameLibraryDir, fixtureEntries, githubOptions, cache, fetcher, refresh } =
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
        version: entry.version,
        repository: entry.source.repository,
        commit: entry.source.commit,
        manifestDigest: entry.source.manifestDigest,
        bundleDigest: entry.source.bundleDigest,
        // fixture 模式硬规则：不伪造审批，标为 unknown
        approvalState: 'unknown',
        installed: diskStatus.installed,
        installedCommit: diskStatus.installedCommit,
      })
    }

    return {
      ok: true,
      source: 'fixture',
      fetchedAt: new Date().toISOString(),
      entries: wireEntries,
    }
  }

  // GitHub 模式
  if (!githubOptions) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: 'GitHub 模式必须提供 githubOptions (owner, repo)',
    }
  }

  const provider = new GitHubCatalogProvider({
    owner: githubOptions.owner,
    repo: githubOptions.repo,
    token: githubOptions.token,
    apiBaseUrl: githubOptions.apiBaseUrl,
    cacheStore: cache,
    fetcher,
  })

  try {
    const fetchRes = await provider.fetchEntries(refresh ? undefined : { cursor: '1' })
    const wireEntries: CatalogListWireEntry[] = []

    for (const view of fetchRes.entries) {
      const entry = view.entry
      const evalRes = evaluateInstallability(entry, approvals)
      let approvalState: 'approved' | 'pending' | 'rejected' | 'unknown' = 'unknown'

      if (evalRes.installable) {
        approvalState = 'approved'
      } else {
        const hasHistory = approvals.some((a) => a.gameId === entry.gameId)
        approvalState = hasHistory ? 'pending' : 'unknown'
      }

      const diskStatus = gameLibraryDir
        ? await checkInstalledOnDisk(gameLibraryDir, entry.gameId, entry.source.commit)
        : { installed: false, installedCommit: null }

      wireEntries.push({
        gameId: entry.gameId,
        title: entry.title,
        summary: entry.summary,
        version: entry.version,
        repository: entry.source.repository,
        commit: entry.source.commit,
        manifestDigest: entry.source.manifestDigest,
        bundleDigest: entry.source.bundleDigest,
        approvalState,
        installed: diskStatus.installed,
        installedCommit: diskStatus.installedCommit,
      })
    }

    return {
      ok: true,
      source: 'github',
      fetchedAt: new Date().toISOString(),
      entries: wireEntries,
    }
  } catch (err: any) {
    const errorCode = typeof err?.code === 'string' ? err.code : 'INTERNAL'
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      errorCode,
      message,
    }
  }
}

/** 检查某 gameId 在磁盘上是否已安装及其 commit */
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

    const subDirs = await fs.readdir(gameDir)
    if (subDirs.length === 0) {
      return { installed: false, installedCommit: null }
    }

    // 若 preferredCommit 在子目录中存在，优先返回该 commit
    if (preferredCommit && subDirs.includes(preferredCommit)) {
      return { installed: true, installedCommit: preferredCommit }
    }

    // 否则取第一个有效的 commit 目录
    const firstCommit = subDirs[0]
    return {
      installed: true,
      installedCommit: firstCommit ? firstCommit : null,
    }
  } catch {
    return { installed: false, installedCommit: null }
  }
}
