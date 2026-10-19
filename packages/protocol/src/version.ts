/**
 * 协议版本常量与兼容判定。
 *
 * 设计约束（基线 §4.1、§5）：只认已知主版本；未知主版本必须拒绝，
 * 而不是“尽力解析”。次版本只允许追加可选字段。
 */

/** 游戏 manifest（gamecenter.json）主版本。 */
export const MANIFEST_SCHEMA_VERSION = 1 as const

/** 目录条目机器块（Issue 内 ```gamecenter-json```）主版本。 */
export const CATALOG_ENTRY_SCHEMA_VERSION = 1 as const

/** 存档文件外层主版本。 */
export const SAVE_FORMAT_VERSION = 1 as const

/** 存档内 gameplay 状态结构主版本（每个游戏独立演进）。 */
export const GAME_STATE_SCHEMA_VERSION = 1 as const

/** SDK 接口主版本：manifest.sdk 的兼容范围以此为准。 */
export const SDK_MAJOR_VERSION = 1 as const

/** SDK 语义版本字符串，写入 manifest.sdk 的推荐形态。 */
export const SDK_VERSION = '1.0.0' as const

/** Bridge 线协议版本，握手时双方交换。 */
export const BRIDGE_PROTOCOL_VERSION = 1 as const

/**
 * Bridge 单条消息上限（字节，按 UTF-8 编码计）。
 * 具体数值属于产品参数，阶段1 可按实测调整，但必须在 Bridge 与 Host 两侧同源。
 */
export const BRIDGE_MAX_MESSAGE_BYTES = 256 * 1024

/** 一次 AI 请求中 messages 的数量上限。 */
export const BRIDGE_MAX_MESSAGES = 64

/** 目录条目正文（Issue body）字节上限，防止超大 Issue 拖垮同步。 */
export const CATALOG_MAX_ISSUE_BODY_BYTES = 64 * 1024

/**
 * 宽松 semver 判定：只解析 major.minor.patch，忽略预发布与构建元数据。
 * 不引入 semver 依赖，协议包保持零运行时依赖。
 */
export function parseSemver(input: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/**
 * 判定游戏声明的 `sdk` 范围是否覆盖宿主提供的 SDK 版本。
 *
 * 阶段0 支持的范围语法（刻意收窄，便于静态校验且不引入依赖）：
 * - `^MAJOR.MINOR.PATCH`
 * - `~MAJOR.MINOR.PATCH`
 * - `MAJOR.MINOR.PATCH`
 * - `>=MAJOR.MINOR.PATCH <MAJOR.MINOR.PATCH`
 * 其他语法一律返回 false（宁可拒绝，不猜测）。
 */
export function sdkRangeAccepts(range: string, hostVersion: string = SDK_VERSION): boolean {
  const host = parseSemver(hostVersion)
  if (!host) return false
  const trimmed = range.trim()

  const caret = /^\^(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(trimmed)
  if (caret?.[1]) {
    const base = parseSemver(caret[1])
    if (!base) return false
    return host.major === base.major && compare(host, base) >= 0
  }

  const tilde = /^~(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(trimmed)
  if (tilde?.[1]) {
    const base = parseSemver(tilde[1])
    if (!base) return false
    return (
      host.major === base.major && host.minor === base.minor && compare(host, base) >= 0
    )
  }

  const andRange = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+\.\d+\.\d+)$/.exec(trimmed)
  if (andRange?.[1] && andRange[2]) {
    const lower = parseSemver(andRange[1])
    const upper = parseSemver(andRange[2])
    if (!lower || !upper) return false
    return compare(host, lower) >= 0 && compare(host, upper) < 0
  }

  const exact = parseSemver(trimmed)
  if (exact) return compare(host, exact) === 0

  return false
}

function compare(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}
