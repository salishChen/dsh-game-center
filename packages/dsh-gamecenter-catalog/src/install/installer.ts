import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  isSafePathSegment,
  type GameManifestV1,
} from '@dsh-gamecenter/protocol'
import type { InstallOptions, InstallResult } from './types.js'
import { verifyManifestDigest, verifyBundleDigest } from './bundleDigest.js'
import { validateInstallSecurity } from './pathSecurity.js'

/**
 * 执行固定提交的安全安装。
 *
 * 核心保障（基线 §9、计划 §1、§4）：
 * 1. 严格按 commit 隔离安装到 `<packagesDir>/<gameId>/<commit>/`；
 * 2. 旧版本不覆盖：若目标目录已存在，直接返回已安装，绝不覆盖旧版本；
 * 3. 校验 manifestDigest 与 bundleDigest，任一不符立即拒绝；
 * 4. 路径逃逸与符号链接全面拦截；
 * 5. 临时 staging 目录组装，校验全部通过后原子移动；失败彻底回滚清理；
 * 6. 禁止运行 npm install、postinstall 或任何仓库脚本。
 */
export async function installGamePackage(options: InstallOptions): Promise<InstallResult> {
  const result = await runInstall(options)
  // 上报是旁路：任何异常都不得改变安装结果，也不得让安装失败。
  try {
    if (result.ok) {
      if (!result.alreadyInstalled) options.reporter?.installSucceeded?.()
    } else {
      options.reporter?.installFailed?.()
    }
  } catch {
    // 静默：统计永不参与门禁
  }
  return result
}

async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const { plan, packagesDir, stagingDir, files, manifestContent, limits } = options

  // 1. 校验 gameId 与 commit 路径段
  if (!isSafePathSegment(plan.gameId) || !isSafePathSegment(plan.commit)) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: 'gameId 或 commit 包含不安全的路径段字符',
    }
  }

  const targetDir = path.join(packagesDir, plan.gameId, plan.commit)

  // 2. 幂等与隔离保护：已存在则直接返回，禁止覆盖
  try {
    const stat = await fs.stat(targetDir)
    if (stat.isDirectory()) {
      return {
        ok: true,
        alreadyInstalled: true,
        installedPath: targetDir,
        gameId: plan.gameId,
        commit: plan.commit,
      }
    }
  } catch {
    // 目标目录不存在，继续安装
  }

  // 3. 校验 manifestDigest
  const manifestVerify = verifyManifestDigest(manifestContent, plan.manifestDigest)
  if (!manifestVerify.ok) {
    return manifestVerify
  }

  // 解析并基础验证 manifest 结构
  let manifestObj: unknown
  try {
    const rawStr =
      typeof manifestContent === 'string'
        ? manifestContent
        : Buffer.from(manifestContent).toString('utf-8')
    manifestObj = JSON.parse(rawStr)
  } catch (err) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `manifest JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const manifest = manifestObj as GameManifestV1
  if (manifest.schemaVersion !== 1) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `未知 manifest schemaVersion: ${String(manifest.schemaVersion)}`,
    }
  }
  if (manifest.id !== plan.gameId) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `manifest id (${manifest.id}) 与安装计划 gameId (${plan.gameId}) 不一致`,
    }
  }

  // 4. 校验 bundleDigest
  const bundleVerify = verifyBundleDigest(files, plan.bundleDigest)
  if (!bundleVerify.ok) {
    return bundleVerify
  }

  // 5. 校验路径逃逸、符号链接与体积
  const secVerify = validateInstallSecurity(files, limits)
  if (!secVerify.ok) {
    return {
      ok: false,
      code: secVerify.code ?? 'PROTOCOL_INVALID',
      reason: secVerify.reason ?? '安全校验未通过',
    }
  }

  // 6. 原子 Staging 安装与回滚
  const stagingId = `staging-${Date.now()}-${randomBytes(6).toString('hex')}`
  const currentStagingPath = path.join(stagingDir, stagingId)

  try {
    await fs.mkdir(currentStagingPath, { recursive: true })

    // 写入 manifest 文件
    const manifestDest = path.join(currentStagingPath, plan.manifestPath)
    await fs.mkdir(path.dirname(manifestDest), { recursive: true })
    await fs.writeFile(manifestDest, manifestContent)

    // 写入所有 bundle 产物文件
    for (const file of files) {
      const fileDest = path.join(currentStagingPath, file.path)
      await fs.mkdir(path.dirname(fileDest), { recursive: true })
      await fs.writeFile(fileDest, file.content)
    }

    // 写入安装元数据记录（仅供本地审计与溯源，不执行脚本）
    //
    // version 取自**已通过 digest 校验的包内 manifest**，而不是调用方给的 plan.version：
    // 2026-10-28 实测三个游戏的 `.dsh-installed.json` 全是 `1.0.0`，因为 Host 侧构造
    // 安装计划时写了常量占位符。审计/展示一旦读这个字段就会报错版本，必须以包内清单为准。
    const installMeta = {
      gameId: plan.gameId,
      version: typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : plan.version,
      commit: plan.commit,
      repository: plan.repository,
      installedAt: new Date().toISOString(),
      manifestDigest: plan.manifestDigest,
      bundleDigest: plan.bundleDigest,
      approvalRecordPath: plan.approvalRecordPath,
    }
    await fs.writeFile(
      path.join(currentStagingPath, '.dsh-installed.json'),
      JSON.stringify(installMeta, null, 2),
      'utf-8',
    )

    // 原子移动到正式目录
    await fs.mkdir(path.dirname(targetDir), { recursive: true })
    await fs.rename(currentStagingPath, targetDir)

    return {
      ok: true,
      alreadyInstalled: false,
      installedPath: targetDir,
      gameId: plan.gameId,
      commit: plan.commit,
    }
  } catch (err) {
    // 失败彻底清理 staging
    try {
      await fs.rm(currentStagingPath, { recursive: true, force: true })
    } catch {
      // ignore staging cleanup failure
    }

    return {
      ok: false,
      code: 'INTERNAL',
      reason: `安装落盘失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * 卸载指定提交的游戏代码。
 *
 * 重要边界（基线 §9）：
 * 仅移除代码安装目录，绝不触碰玩家存档目录，代码卸载与删档物理解耦。
 */
export async function uninstallGamePackage(
  packagesDir: string,
  gameId: string,
  commit: string,
): Promise<{ ok: boolean; removedPath?: string; reason?: string }> {
  if (!isSafePathSegment(gameId) || !isSafePathSegment(commit)) {
    return { ok: false, reason: 'gameId 或 commit 包含非法路径字符' }
  }

  const targetDir = path.join(packagesDir, gameId, commit)

  // 【不得假成功 · 2026-10-27】fs.rm({recursive, force}) 对**不存在的路径同样返回成功**。
  // 历史缺陷：客户端传的是「目录里的最新发布版提交」而不是「磁盘上真正安装的提交」，
  // 两者不等时删的是一个空路径 → 报 ok:true → 界面乐观置为未安装 → 紧接着按真实磁盘
  // 重算又弹回「已安装」。用户看到的就是「卸载成功但毫无变化、也装不回去」。
  // 所以先确认目标真的存在；不存在就如实失败，并说清磁盘上到底装了什么。
  let existed = true
  try {
    await fs.lstat(targetDir)
  } catch {
    existed = false
  }

  if (!existed) {
    const parentDir = path.join(packagesDir, gameId)
    const installedCommits: string[] = []
    try {
      for (const name of (await fs.readdir(parentDir)).filter(isVisibleEntry)) {
        try {
          const raw = await fs.readFile(path.join(parentDir, name, 'gamecenter.json'), 'utf-8')
          const manifest = JSON.parse(raw) as { schemaVersion?: unknown }
          if (manifest?.schemaVersion === 1) installedCommits.push(name)
        } catch {
          // 目录不完整 → 不算已安装
        }
      }
    } catch {
      // 父目录不存在 → 这款游戏没装
    }
    const detail =
      installedCommits.length === 0
        ? '磁盘上没有该游戏的可用安装'
        : `磁盘上实际安装的提交是 ${installedCommits.join(', ')}`
    return {
      ok: false,
      reason: `提交 ${commit} 在磁盘上没有安装目录，本次未删除任何内容；${detail}`,
    }
  }

  try {
    await fs.rm(targetDir, { recursive: true, force: true })
    // 删后验真：force 的静默成功不能再当结论，目录确实消失才算卸载成功。
    try {
      await fs.lstat(targetDir)
      return { ok: false, reason: `卸载后目标目录仍然存在: ${targetDir}` }
    } catch {
      // 已消失 → 符合预期
    }
    // 父目录若已完全没有任何可见内容（只剩 .staging / .cache 之类隐藏残留），一并删除。
    //
    // 这里刻意用「目录是否为空」而不是「是否还有可用安装」作为判据：卸载只应该清理
    // 自己留下的空壳，绝不能顺手删掉其它版本目录。历史版本里可能存在缺清单文件的
    // 目录，用「结构是否完整」去判断父目录该不该删，会把那些目录一起误删，从而破坏
    // 「代码卸载与删档解耦、多版本并存」的契约。
    try {
      const parentDir = path.join(packagesDir, gameId)
      const remain = (await fs.readdir(parentDir)).filter((name) => !name.startsWith('.'))
      if (remain.length === 0) {
        await fs.rm(parentDir, { recursive: true, force: true })
      }
    } catch {
      // 父目录清理只是收尾优化，失败不影响本次卸载结果
    }
    return { ok: true, removedPath: targetDir }
  } catch (err) {
    return {
      ok: false,
      reason: `卸载目录清理失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** 判断某个目录名是否是「非隐藏」的候选安装目录（仅用于列举，不作判据）。 */
const isVisibleEntry = (name: string): boolean => !name.startsWith('.')

/**
 * 判断某个 gameId 目录下是否还留有「可用」的安装。
 *
 * 判据只信内容、不信目录名：目录内 `gamecenter.json` 存在且 `schemaVersion === 1`
 * 才算一次可用安装。`.staging`、`staging-*`、空目录、崩溃留下的半截目录一律不算。
 *
 * **仅用于列出/诊断，不参与卸载的物理清理决策**——卸载只用「父目录是否为空」判断，
 * 否则会把结构上真实存在、只是缺清单文件的其它版本目录一起误删。
 */
export async function hasUsableInstallIn(
  parentDir: string,
  entries: readonly string[],
): Promise<boolean> {
  for (const name of entries) {
    if (!isVisibleEntry(name)) continue
    try {
      const raw = await fs.readFile(path.join(parentDir, name, 'gamecenter.json'), 'utf-8')
      const manifest = JSON.parse(raw) as { schemaVersion?: unknown }
      if (manifest?.schemaVersion === 1) return true
    } catch {
      // 目录不完整 → 不算已安装
    }
  }
  return false
}
