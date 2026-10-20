import { createHash } from 'node:crypto'
import { isDigest, type ErrorCode } from '@dsh-gamecenter/protocol'
import type { BundleFileDescriptor, InstallSourceFile } from './types.js'

/**
 * 计算数据的 SHA-256 规范摘要字符串（`sha256:<64位小写十六进制>`）。
 */
export function sha256Hex(data: string | Uint8Array | Buffer): string {
  const hash = createHash('sha256')
  if (typeof data === 'string') {
    hash.update(data, 'utf-8')
  } else {
    hash.update(data)
  }
  return `sha256:${hash.digest('hex').toLowerCase()}`
}

/**
 * 计算 manifest 文件的摘要。
 */
export function calculateManifestDigest(content: string | Uint8Array | Buffer): string {
  return sha256Hex(content)
}

/**
 * 校验 manifest 摘要是否逐字符匹配预期。
 */
export function verifyManifestDigest(
  content: string | Uint8Array | Buffer,
  expectedDigest: string,
): { ok: true } | { ok: false; code: ErrorCode; reason: string } {
  if (!isDigest(expectedDigest)) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `预期 manifestDigest 格式不合规: ${expectedDigest}`,
    }
  }

  const actualDigest = calculateManifestDigest(content)
  if (actualDigest !== expectedDigest) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `manifestDigest 摘要不匹配: 期望 ${expectedDigest}，实际 ${actualDigest}`,
    }
  }

  return { ok: true }
}

/**
 * 计算产物清单与规范化 bundleDigest。
 *
 * 规范算法（设计 §9）：
 * 1. 过滤并正规化相对路径（统一使用正斜杠 `/`）；
 * 2. 按 UTF-8 / Unicode 相对路径升序严格排序；
 * 3. 对每个常规文件记录 { path, size, sha256 }；
 * 4. 将排序后的清单序列化为规范 JSON 字符串，计算其 SHA-256。
 */
export function calculateBundleDigest(files: readonly InstallSourceFile[]): {
  bundleDigest: string
  fileDescriptors: BundleFileDescriptor[]
} {
  const normalizedList: BundleFileDescriptor[] = files.map((file) => {
    const normalizedPath = normalizeSlash(file.path)
    const size = typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf-8') : file.content.length
    const digest = sha256Hex(file.content)
    return {
      path: normalizedPath,
      size,
      sha256: digest,
    }
  })

  // 按 UTF-8 相对路径升序排序
  normalizedList.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // 生成规范 JSON 字符串（无多余空白，key 顺序固定为 path, size, sha256）
  const canonicalJson = JSON.stringify(
    normalizedList.map((item) => ({
      path: item.path,
      size: item.size,
      sha256: item.sha256,
    })),
  )

  const bundleDigest = sha256Hex(canonicalJson)

  return {
    bundleDigest,
    fileDescriptors: normalizedList,
  }
}

/**
 * 校验一组文件是否完整且准确匹配预期的 bundleDigest。
 */
export function verifyBundleDigest(
  files: readonly InstallSourceFile[],
  expectedBundleDigest: string,
): { ok: true; fileDescriptors: BundleFileDescriptor[] } | { ok: false; code: ErrorCode; reason: string } {
  if (!isDigest(expectedBundleDigest)) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `预期 bundleDigest 格式不合规: ${expectedBundleDigest}`,
    }
  }

  const calculated = calculateBundleDigest(files)
  if (calculated.bundleDigest !== expectedBundleDigest) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: `bundleDigest 摘要不匹配: 期望 ${expectedBundleDigest}，实际 ${calculated.bundleDigest}`,
    }
  }

  return { ok: true, fileDescriptors: calculated.fileDescriptors }
}

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/')
}
