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
    const installMeta = {
      gameId: plan.gameId,
      version: plan.version,
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
  try {
    await fs.rm(targetDir, { recursive: true, force: true })
    return { ok: true, removedPath: targetDir }
  } catch (err) {
    return {
      ok: false,
      reason: `卸载目录清理失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
