import {
  isSafeRelativePath,
  isSafePathSegment,
  GAME_BUNDLE_MAX_FILE_BYTES,
  GAME_BUNDLE_MAX_TOTAL_BYTES,
  type ErrorCode,
} from '@dsh-gamecenter/protocol'
import type { InstallSourceFile, InstallSecurityLimits } from './types.js'

// 【体积上限唯一真源 · 2026-10-27】以前这里独立写着 32 MiB / 64 MiB，而 protocol 的
// GAME_BUNDLE_MAX_FILE_BYTES 是 30 MiB / 50 MiB —— 同一个包在下层放行、在上层被拒，
// 报错文案还各说各的数。现在直接引用 protocol 常量，改一处即全链一致。
export const DEFAULT_MAX_SINGLE_FILE_BYTES = GAME_BUNDLE_MAX_FILE_BYTES
export const DEFAULT_MAX_TOTAL_BYTES = GAME_BUNDLE_MAX_TOTAL_BYTES
export const DEFAULT_MAX_FILE_COUNT = 1000

export interface SecurityCheckResult {
  ok: boolean
  code?: ErrorCode
  reason?: string
}

/**
 * 校验待安装文件集是否符合安全边界要求：
 * 1. 严格禁止路径逃逸（..、绝对路径、盘符、UNC、连续分隔符、空段）；
 * 2. 严格禁止符号链接；
 * 3. 严格禁止单文件超限、总包大小超限、文件数超限；
 * 4. 禁止包含 .git、.github 等隐藏版本控制目录或仓库钩子。
 */
export function validateInstallSecurity(
  files: readonly InstallSourceFile[],
  limits: InstallSecurityLimits = {},
): SecurityCheckResult {
  const maxSingle = limits.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES
  const maxTotal = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxCount = limits.maxFileCount ?? DEFAULT_MAX_FILE_COUNT

  if (files.length > maxCount) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `安装包文件数 ${files.length} 超过允许上限 ${maxCount}`,
    }
  }

  let totalBytes = 0
  const seenPaths = new Set<string>()

  for (const file of files) {
    if (file.isSymlink) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: `检测到符号链接 ${file.path}，出于安全原因禁止安装`,
      }
    }

    if (!isSafeRelativePath(file.path)) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: `文件路径不合法或存在路径逃逸风险: ${file.path}`,
      }
    }

    const normalized = file.path.replace(/\\/g, '/')
    if (seenPaths.has(normalized)) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: `安装包中存在重复冲突路径: ${normalized}`,
      }
    }
    seenPaths.add(normalized)

    // 禁止命中敏感路径模式
    const segments = normalized.split('/')
    for (const seg of segments) {
      if (!isSafePathSegment(seg)) {
        return {
          ok: false,
          code: 'PROTOCOL_INVALID',
          reason: `路径段含不安全字符或属于保留命名: ${seg}`,
        }
      }
      if (seg === '.git' || seg === '.github' || seg === '.svn' || seg === 'node_modules') {
        return {
          ok: false,
          code: 'PROTOCOL_INVALID',
          reason: `禁止安装包含特殊受限目录的文件: ${seg}`,
        }
      }
    }

    const fileSize = typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf-8') : file.content.length
    if (fileSize > maxSingle) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: `单文件 ${file.path} 大小 (${fileSize} 字节) 超过上限 (${maxSingle} 字节)`,
      }
    }

    totalBytes += fileSize
    if (totalBytes > maxTotal) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: `安装包总大小 (${totalBytes} 字节) 超过上限 (${maxTotal} 字节)`,
      }
    }
  }

  return { ok: true }
}
