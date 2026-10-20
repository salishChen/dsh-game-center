/**
 * 安装计划协议（阶段1 P0，基线 §4.1、§4、§11 阶段1）。
 *
 * 本文件只做三件纯函数的事：解析 Issue 机器块、判定是否可安装、产出安装计划。
 * 不发网络请求、不碰文件系统、不执行任何仓库脚本——下载与落盘由目录与安装工程师实现。
 *
 * 本文件所有类型均为【拟新增协议】，不是 DSH 既有 API。
 */

import type { CatalogMachineEntry, ApprovedRelease } from './catalog.js'
import { matchApproval, isDigest, isFullCommit } from './catalog.js'
import type { ErrorCode } from './errors.js'
import { CATALOG_MAX_ISSUE_BODY_BYTES } from './version.js'
import { utf8ByteLength } from './bridge.js'

/** 机器块围栏语言标记；Issue 正文中只允许出现一个该围栏的代码块。 */
export const CATALOG_MACHINE_FENCE = 'gamecenter-json'

/** 解析失败/不可安装的原因，复用统一错误码，不自造字符串。 */
export interface InstallRejection {
  ok: false
  code: ErrorCode
  /** 面向维护者的简短说明，不得含敏感信息。 */
  reason: string
}

/** 解析成功：机器块内容与来源位置。 */
export interface CatalogParseOk {
  ok: true
  entry: CatalogMachineEntry
  /** 块内 JSON 的原始文本，便于对账与摘要。 */
  rawMachineBlock: string
}

export type CatalogParseResult = CatalogParseOk | InstallRejection

/**
 * 从 Issue 正文解析唯一 `gamecenter-json` 机器块。
 *
 * 拒绝规则（基线 §4.1）：
 * - 正文超过 `CATALOG_MAX_ISSUE_BODY_BYTES`；
 * - 出现 0 个或多个机器块；
 * - JSON 解析失败、重复 key、多余/缺失字段、未知主版本；
 * - 字段格式不合法（gameId、40 位完整 commit、sha256 摘要、仓库 URL）。
 */
export function parseCatalogIssueBody(body: string): CatalogParseResult {
  if (typeof body !== 'string') {
    return reject('PROTOCOL_INVALID', 'Issue 正文必须是字符串')
  }
  const byteLength = utf8ByteLength(body)
  if (byteLength > CATALOG_MAX_ISSUE_BODY_BYTES) {
    return reject(
      'PROTOCOL_INVALID',
      `Issue 正文 ${byteLength} 字节超过上限 ${CATALOG_MAX_ISSUE_BODY_BYTES}`,
    )
  }

  const blocks = findMachineBlocks(body)
  if (blocks.length === 0) {
    return reject('PROTOCOL_INVALID', '未找到 gamecenter-json 机器块')
  }
  if (blocks.length > 1) {
    return reject('PROTOCOL_INVALID', `发现 ${blocks.length} 个机器块，只允许一个`)
  }
  const raw = blocks[0] as string

  if (hasDuplicateKeys(raw)) {
    return reject('PROTOCOL_INVALID', '机器块含重复 key')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reject('PROTOCOL_INVALID', `机器块 JSON 解析失败: ${message}`)
  }

  const shape = validateEntryShape(parsed)
  if (!shape.ok) return shape

  return { ok: true, entry: shape.entry, rawMachineBlock: raw }
}

/**
 * 安装门禁：机器块必须与某条审批记录的五元组逐字段一致。
 *
 * 这里不重新实现比较逻辑，直接复用 `matchApproval`（阶段0 已修复为含 repository 的五元组）。
 */
export function authorizeInstall(
  entry: CatalogMachineEntry,
  approvals: readonly ApprovedRelease[],
): { ok: true; approval: ApprovedRelease } | InstallRejection {
  const matched = matchApproval(entry, approvals)
  if (!matched.ok) {
    return reject('PROTOCOL_INVALID', matched.reason)
  }
  return matched
}

/** 安装计划：告诉下载器取什么、校验什么、落到哪。不含任何凭据。 */
export interface InstallPlan {
  gameId: string
  version: string
  repository: string
  /** 只认完整提交；ref 不参与下载决策。 */
  commit: string
  manifestPath: string
  manifestDigest: string
  bundleDigest: string
  /** 相对游戏库的安装目录：`<gameId>/<commit>`，隔离且不覆盖旧版本。 */
  installDir: string
  /** 审批记录路径，用于审计回溯。 */
  approvalRecordPath: string
}

export type InstallPlanResult = { ok: true; plan: InstallPlan } | InstallRejection

/**
 * 生成安装计划。要求 `authorizeInstall` 已通过；本函数仍会重算一次门禁，
 * 避免调用方跳过审批直接构造计划。
 */
export function buildInstallPlan(
  entry: CatalogMachineEntry,
  approvals: readonly ApprovedRelease[],
): InstallPlanResult {
  const authorized = authorizeInstall(entry, approvals)
  if (!authorized.ok) return authorized

  const safeGameId = entry.gameId
  const safeCommit = entry.source.commit
  // 双保险：即使上游校验被绕过，也不允许路径段逃逸。
  if (!isSafePathSegment(safeGameId) || !isSafePathSegment(safeCommit)) {
    return reject('PROTOCOL_INVALID', 'gameId 或 commit 不能安全用作路径段')
  }

  return {
    ok: true,
    plan: {
      gameId: safeGameId,
      version: entry.version,
      repository: entry.source.repository,
      commit: safeCommit,
      manifestPath: entry.source.manifestPath,
      manifestDigest: entry.source.manifestDigest,
      bundleDigest: entry.source.bundleDigest,
      installDir: `${safeGameId}/${safeCommit}`,
      approvalRecordPath: authorized.approval.approvalRecordPath,
    },
  }
}

/**
 * 路径段安全判定：拒绝空、`.`/`..`、路径分隔符、盘符、控制字符与 Windows 保留字符。
 * 用于 gameId 与 commit 这类会成为目录名的字段。
 */
export function isSafePathSegment(segment: string): boolean {
  if (typeof segment !== 'string' || segment.length === 0 || segment.length > 128) return false
  if (segment === '.' || segment === '..') return false
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(segment)) return false
  // 盘符形态（如 `C:`）与 UNC 前缀已在上面被分隔符规则覆盖，这里再兜一层。
  if (/^[A-Za-z]:/.test(segment)) return false
  return true
}

/**
 * 清单路径安全判定：必须是相对路径，且不含 `..`、绝对路径、UNC 或盘符。
 * 用于 manifestPath 与 dist 文件清单。
 */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  if (path.includes('\u0000')) return false
  // 逐段校验：空段（连续分隔符）与 `..` 一律拒绝，不依赖调用方做规范化。
  const segments = path.split(/[\\/]/)
  return segments.every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * 摘要比对辅助：两侧都必须是规范小写 `sha256:<64hex>`，且逐字符相等。
 * 大写十六进制视为不合规输入直接拒绝，不做大小写归一——所有摘要以规范形式写入协议。
 */
export function digestMatches(expected: string, actual: string): boolean {
  if (!isDigest(expected) || !isDigest(actual)) return false
  return expected === actual
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function reject(code: ErrorCode, reason: string): InstallRejection {
  return { ok: false, code, reason }
}

/** 找出所有 ```gamecenter-json 围栏块的内容（不含围栏行自身）。 */
function findMachineBlocks(body: string): string[] {
  const blocks: string[] = []
  const lines = body.split(/\r?\n/)
  let inside = false
  let buffer: string[] = []

  for (const line of lines) {
    const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9_-]*)\s*$/.exec(line)
    if (!inside) {
      if (fence && fence[2] === CATALOG_MACHINE_FENCE) {
        inside = true
        buffer = []
      }
      continue
    }
    // 已在内层：任何围栏行都视为结束，避免嵌套块造成歧义。
    if (fence) {
      blocks.push(buffer.join('\n'))
      inside = false
      buffer = []
      continue
    }
    buffer.push(line)
  }

  // 未闭合的围栏按错误处理：返回两个，让上层判定“多块/非法”，而不是静默接受。
  if (inside) {
    blocks.push(buffer.join('\n'))
    blocks.push('') // 哨兵：制造长度>1，触发拒绝
  }
  return blocks
}

/** JSON.parse reviver 无法可靠识别重复 key；改为对原始文本做一次轻量扫描。 */
function hasDuplicateKeys(raw: string): boolean {
  // 逐层扫描对象：栈中记录每个 `{` 层级已见过的 key 集合。
  const stack: Set<string>[] = []
  let i = 0
  let expectKey = false

  while (i < raw.length) {
    const char = raw[i]
    if (char === '"') {
      const start = i
      i++
      while (i < raw.length) {
        if (raw[i] === '\\') {
          i += 2
          continue
        }
        if (raw[i] === '"') break
        i++
      }
      const literal = raw.slice(start, i + 1)
      i++
      if (expectKey) {
        const top = stack[stack.length - 1]
        if (top) {
          let key: string
          try {
            key = JSON.parse(literal) as string
          } catch {
            key = literal
          }
          if (top.has(key)) return true
          top.add(key)
        }
        expectKey = false
      }
      continue
    }
    if (char === '{') {
      stack.push(new Set<string>())
      expectKey = true
      i++
      continue
    }
    if (char === '}') {
      stack.pop()
      expectKey = false
      i++
      continue
    }
    if (char === ',') {
      expectKey = stack.length > 0
      i++
      continue
    }
    if (char === '[') {
      // 数组内不追踪 key；压入空集合占位以保持层级对齐。
      stack.push(new Set<string>())
      expectKey = false
      i++
      continue
    }
    if (char === ']') {
      stack.pop()
      i++
      continue
    }
    i++
  }
  return false
}

function validateEntryShape(value: unknown): { ok: true; entry: CatalogMachineEntry } | InstallRejection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return reject('PROTOCOL_INVALID', '机器块必须是 JSON 对象')
  }
  const obj = value as Record<string, unknown>

  const allowedKeys = ['schemaVersion', 'gameId', 'title', 'summary', 'version', 'source']
  const extra = Object.keys(obj).filter((key) => !allowedKeys.includes(key))
  if (extra.length > 0) {
    return reject('PROTOCOL_INVALID', `机器块含未知字段: ${extra.join(', ')}`)
  }
  const missing = allowedKeys.filter((key) => !(key in obj))
  if (missing.length > 0) {
    return reject('PROTOCOL_INVALID', `机器块缺少字段: ${missing.join(', ')}`)
  }

  if (obj['schemaVersion'] !== 1) {
    return reject('PROTOCOL_INVALID', `未知机器块主版本: ${String(obj['schemaVersion'])}`)
  }

  const gameId = obj['gameId']
  const title = obj['title']
  const summary = obj['summary']
  const version = obj['version']
  const source = obj['source']

  if (typeof gameId !== 'string' || !isValidCatalogGameId(gameId)) {
    return reject('PROTOCOL_INVALID', 'gameId 不符合命名规则')
  }
  if (typeof title !== 'string' || title.length === 0 || title.length > 120) {
    return reject('PROTOCOL_INVALID', 'title 必须为 1..120 字符')
  }
  if (typeof summary !== 'string' || summary.length === 0 || summary.length > 2000) {
    return reject('PROTOCOL_INVALID', 'summary 必须为 1..2000 字符')
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    return reject('PROTOCOL_INVALID', 'version 必须形如 1.0.0')
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return reject('PROTOCOL_INVALID', 'source 必须是对象')
  }

  const src = source as Record<string, unknown>
  const allowedSourceKeys = [
    'repository',
    'ref',
    'commit',
    'manifestPath',
    'manifestDigest',
    'bundleDigest',
  ]
  const srcExtra = Object.keys(src).filter((key) => !allowedSourceKeys.includes(key))
  if (srcExtra.length > 0) {
    return reject('PROTOCOL_INVALID', `source 含未知字段: ${srcExtra.join(', ')}`)
  }
  const srcMissing = allowedSourceKeys.filter((key) => !(key in src))
  if (srcMissing.length > 0) {
    return reject('PROTOCOL_INVALID', `source 缺少字段: ${srcMissing.join(', ')}`)
  }

  const repository = src['repository']
  const ref = src['ref']
  const commit = src['commit']
  const manifestPath = src['manifestPath']
  const manifestDigest = src['manifestDigest']
  const bundleDigest = src['bundleDigest']

  if (typeof repository !== 'string' || !isGitHubRepositoryUrl(repository)) {
    return reject('PROTOCOL_INVALID', 'repository 必须是 https://github.com/<owner>/<repo>')
  }
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) {
    return reject('PROTOCOL_INVALID', 'ref 必须为 1..200 字符')
  }
  if (typeof commit !== 'string' || !isFullCommit(commit)) {
    return reject('PROTOCOL_INVALID', 'commit 必须是 40 位小写十六进制完整提交')
  }
  if (typeof manifestPath !== 'string' || !isSafeRelativePath(manifestPath)) {
    return reject('PROTOCOL_INVALID', 'manifestPath 必须是安全相对路径')
  }
  if (typeof manifestDigest !== 'string' || !isDigest(manifestDigest)) {
    return reject('PROTOCOL_INVALID', 'manifestDigest 必须形如 sha256:<64hex>')
  }
  if (typeof bundleDigest !== 'string' || !isDigest(bundleDigest)) {
    return reject('PROTOCOL_INVALID', 'bundleDigest 必须形如 sha256:<64hex>')
  }

  const entry: CatalogMachineEntry = {
    schemaVersion: 1,
    gameId,
    title,
    summary,
    version,
    source: { repository, ref, commit, manifestPath, manifestDigest, bundleDigest },
  }
  return { ok: true, entry }
}

/** 首版仅 GitHub：`https://github.com/<owner>/<repo>`，可选 `.git` 后缀。 */
function isGitHubRepositoryUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url)
}

function isValidCatalogGameId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/.test(value)
}
