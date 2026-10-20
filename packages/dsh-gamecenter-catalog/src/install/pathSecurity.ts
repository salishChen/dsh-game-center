import { isSafeRelativePath, isSafePathSegment, type ErrorCode } from '@dsh-gamecenter/protocol'
import type { InstallSourceFile, InstallSecurityLimits } from './types.js'

export const DEFAULT_MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024 // 25MB
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024 // 50MB
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
