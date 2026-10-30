/**
 * 目录展示元数据与兼容性门禁（阶段1 扩展，2026-10-20 冻结）。
 *
 * 【为什么单独一个文件】
 * `catalog.ts` 的安装信任根是**五元组**
 * `{gameId, repository, commit, manifestDigest, bundleDigest}`。
 * 用户要求 Issue 里展示游戏名、Markdown 简介、封面截图、适配游戏中心版本、
 * 适配 DSH 版本——这些**不是**五元组的一部分，因此：
 *
 * 1. **不能**说"编辑 Issue 就一定让审批失效"：五元组不变时安装仍被批准；
 * 2. 展示元数据与兼容性**每次展示/安装/启动都重新校验**（版本 gate 实时重算），
 *    否则发布的兼容范围会随时间失效却看不出来；
 * 3. 若将来要对"元数据也经过审批"提出更强主张，必须引入**独立的规范元数据摘要**
 *    `metadataDigest` 并绑定到 Issue 修订——本文件已定义该摘要的**规范序列化与计算**，
 *    但**是否把它加入审批记录属于协议变更，本阶段不启用**（见 `METADATA_APPROVAL_ENABLED`）。
 *
 * 【双语 / Bilingual】
 * 本文件所有对外说明均为中文与英文并列；协议标识符不翻译。
 */

import type { JsonValue } from './json.js'

/**
 * 展示元数据是否纳入审批信任根。
 *
 * 当前为 `false`：审批只认五元组；元数据与兼容性**每次**重新校验，
 * 不因为"曾经展示过"而被信任。
 */
export const METADATA_APPROVAL_ENABLED = false as const

/** 元数据规范序列化版本；`metadataDigest` 变化即视为元数据变更。 */
export const CATALOG_METADATA_SCHEMA_VERSION = 1 as const

/** 简介 Markdown 上限（字符）。超过即拒绝，避免整篇 Issue 塞进目录缓存。 */
export const DESCRIPTION_MARKDOWN_MAX_CHARS = 8000

/** 封面图片上限：1 张。Cover image: at most one. */
export const COVER_MAX_COUNT = 1

/** 截图数量上限 / Screenshot count limit. */
export const SCREENSHOT_MAX_COUNT = 8

/** 单张图片字节上限（2 MiB）/ Per-image byte limit. */
export const MEDIA_MAX_BYTES_PER_IMAGE = 2 * 1024 * 1024

/** 图片像素边长上限，防解压炸弹 / Edge limit guarding against decompression bombs. */
export const MEDIA_MAX_EDGE_PX = 4096

/** 允许的图片 MIME：**不含 SVG**（SVG 可携带主动内容）/ Allowed MIME types, SVG excluded. */
export const MEDIA_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type MediaMime = (typeof MEDIA_ALLOWED_MIME)[number]

/**
 * 受控图片引用 / Controlled image reference.
 *
 * 图片**只能**通过本结构引用；正文 Markdown 里**不允许**任何 `<img>`、raw HTML 或
 * 直接图片链接——Markdown 中一旦出现外部图片语法即拒绝整条元数据。
 */
export interface CatalogMediaRef {
  /** 只允许 https。HTTPS only. */
  url: string
  /** `sha256:<64 hex>`，Host 下载后必须逐字节校验。 */
  sha256: string
  mime: MediaMime
  /** 展示用像素尺寸，用于占位与上限校验。 */
  width: number
  height: number
  /** 无障碍替代文本（必填，不能为空）。 */
  alt: string
}

/** 平台版本门禁 / Platform version gate（**真实安装与启动门禁**，不是装饰）。 */
export interface CatalogCompatibility {
  /**
   * 适配的游戏中心版本范围（semver range）。
   * 与 `CatalogReleaseRef`/`CatalogMachineEntry.version`（**游戏自身版本**）是两回事，
   * 严禁把平台版本写进游戏版本字段。
   */
  gameCenter: string
  /** 适配的 DSH 版本范围（semver range）。 */
  dsh: string
}

/** 展示元数据 / Display metadata（不参与五元组审批）。 */
export interface CatalogDisplayMetadata {
  schemaVersion: typeof CATALOG_METADATA_SCHEMA_VERSION
  /**
   * 游戏自身的 Git 仓库地址（**用户必填**）。
   *
   * 与机器块 `source.repository` **同源**，不得另造 `gameUrl` 平行字段：
   * - 规范化后两者必须**逐字相同**，不一致即拒绝整条元数据（fail closed）；
   * - 首版只接受 GitHub 仓库：`https://github.com/<owner>/<repo>`，可容忍 `.git` 后缀；
   * - 拒绝凭据（userinfo）、query、fragment、非仓库路径（`/tree/…`、`/issues/…`）。
   *
   * English: the game's own Git repository URL, required and identical to
   * `source.repository` after normalization. GitHub HTTPS repository URLs only.
   */
  repository: string
  /** 简短介绍（纯文本，用于列表卡片）。Plain-text one-liner for the list card. */
  summary: string
  /** Markdown 简介；渲染端必须使用白名单渲染器（禁 raw HTML / 禁外部图片语法）。 */
  descriptionMarkdown: string
  /** 封面：`null` 表示无封面，客户端显示占位。 */
  cover: CatalogMediaRef | null
  screenshots: CatalogMediaRef[]
  compatibility: CatalogCompatibility
}

/** 一条元数据违规 / One metadata violation. */
export interface CatalogMetadataViolation {
  field: string
  reason: string
  /** 双语原因；UI 直接展示中文，日志用英文。 */
  reasonEn: string
}

/** 五元组摘要字符串 / Install trust tuple (unchanged five fields). */
export interface CatalogTrustTuple {
  gameId: string
  repository: string
  commit: string
  manifestDigest: string
  bundleDigest: string
}

export const DIGEST_HEX_PATTERN = /^sha256:[0-9a-f]{64}$/
/**
 * 允许的范围语法 / Accepted range grammar.
 *
 * 与 `version.ts` 的 `sdkRangeAccepts()` **刻意保持同一子集**（不引入 semver 依赖）：
 * - `^M.m.p`（含预发布后缀）
 * - `~M.m.p`
 * - `M.m.p`（精确）
 * - `>=M.m.p <M.m.p`（可带预发布后缀）
 * 其它写法（`*`、`latest`、`||`、`-` 范围）一律拒绝 —— fail closed。
 */
const SEMVER_RANGE_PATTERN =
  /^(?:\^|~)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$|^>=\s*\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s+<\s*\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * 游戏仓库地址规范化 / Normalize a game repository URL.
 *
 * 只接受 `https://github.com/<owner>/<repo>[.git]`：
 * - `<owner>` 与 `<repo>` 各 1~100 个 `[A-Za-z0-9._-]`，不允许 `.`/`..`；
 * - 不允许 userinfo、端口、query、fragment、末尾多余路径；
 * - 统一输出为 **不带 `.git`** 的小写主机 + 原样大小写的 owner/repo，
 *   便于与 `source.repository` 做“规范化后逐字相同”的比较。
 *
 * 返回 `null` 表示不合法（调用方必须 fail closed）。
 */
export function normalizeGameRepositoryUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return null
  const match = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(
    value.trim(),
  )
  if (match === null) return null
  const owner = match[1] ?? ''
  const repo = match[2] ?? ''
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  if (owner.length === 0 || repo.length === 0) return null
  return `https://github.com/${owner}/${repo}`
}

/**
 * Markdown 危险构造检测 / Markdown hazard scan.
 *
 * 规则（任何一条命中即拒绝整段说明）：
 * - 禁止 raw HTML：任何 `<` 后紧跟字母、`!`、`/` 一律视为 HTML；
 * - 禁止图片语法 `![...](...)` 与 HTML `<img>`：图片只能走 `media`；
 * - 禁止 `javascript:` / `data:` / `vbscript:` 协议；
 * - 禁止 iframe/script/style/object/embed/link/meta 标签名（大小写不敏感）。
 */
export function findMarkdownHazards(text: string): string[] {
  const hazards: string[] = []
  if (/<\s*[A-Za-z!/]/.test(text)) hazards.push('raw-html')
  if (/!\[[^\]]*\]\(/.test(text)) hazards.push('markdown-image')
  if (/(?:javascript|data|vbscript)\s*:/i.test(text)) hazards.push('unsafe-scheme')
  if (/<\s*(?:script|style|iframe|object|embed|link|meta)\b/i.test(text)) hazards.push('active-tag')
  return hazards
}

/**
 * 受控 URL 校验 / Controlled URL validation.
 *
 * Host 侧下载前、每次 redirect 后都必须调用本函数重新校验。
 * 只接受形如 `https://<host>/<path>` 的 URL：
 * - 必须是 `https:`；不允许 userinfo（`user@host`）；不允许非默认端口；
 * - 不允许 IP 字面量、`localhost`、私网域名后缀（SSRF 防护的基础层，
 *   真正的 DNS/IP 复核由 Host 下载器在解析后执行）；
 * - 主机必须是白名单之一（精确匹配，不做后缀匹配）。
 */
export function isAllowedMediaUrl(url: unknown, allowedHosts: readonly string[]): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false
  // 不依赖 DOM/Node 的 URL 类型（protocol 的 lib 只有 ES2022）：
  // 手工解析 scheme、authority 与 path，规则与 URL 语义一致且更严格。
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(url)
  if (match === null) return false
  const scheme = (match[1] ?? '').toLowerCase()
  const authority = match[2] ?? ''
  if (scheme !== 'https') return false
  if (authority.length === 0) return false
  // userinfo 一律拒绝（`user:pass@host`）。
  if (authority.includes('@')) return false
  // 只允许 host（可带默认端口与否都不接受自定义端口：出现 `:` 即拒绝，IPv6 也一并拒绝）。
  if (authority.includes(':') || authority.includes('[') || authority.includes(']')) return false
  const host = authority.toLowerCase()
  if (host.length === 0 || host.startsWith('.') || host.endsWith('.')) return false
  if (host.startsWith('-') || host.endsWith('-')) return false
  if (!/^[a-z0-9.-]+$/.test(host)) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  if (!allowedHosts.includes(host)) return false
  return true
}

/**
 * 受信目录后台 origin 上的媒体地址校验 / Media URL on a trusted catalog origin.
 *
 * 【为什么需要】
 * 后台（`backend/api.ts`）下发的封面是**同源绝对或相对路径**（`/v1/covers/<gameId>`），
 * 而 `isAllowedMediaUrl` 只认 https + 白名单主机，这种地址必然被拒；又因为
 * `validateDisplayMetadata` 整体 fail-closed，一个媒体字段失败会让调用方丢掉**整块**
 * display（含 summary/descriptionMarkdown）——封面消失只是表象。
 *
 * 【安全边界：按配置授予的信任，不是放开任意 http】
 * 这里唯一接受的例外是**运维在 Host 配置里显式给出的后台 origin**，它不是网络输入：
 * - `trustedOrigins` 为空/未传 → 视为没有任何受信来源，直接 `false`；
 * - scheme 只接受 `http`/`https`；authority 非空，不得含 userinfo（`@`）、
 *   IPv6 方括号（`[` `]`）；
 * - host 只允许 `[a-z0-9.-]`，可选 `:port` 只接受 1~5 位数字；
 * - path 不得含 `..` 或 `\`（不做任何路径穿越）；
 * - 最终必须与某个受信 origin **逐字相等**（各自 `trim`、去尾斜杠、小写后比较），
 *   不做域名后缀或子域匹配。
 * **不放宽 `isAllowedMediaUrl` 本身**：公网图片仍然只允许 https + 白名单主机 + 无自定义端口。
 */
export function isTrustedMediaOriginUrl(url: unknown, trustedOrigins: readonly string[] | undefined): boolean {
  if (!Array.isArray(trustedOrigins) || trustedOrigins.length === 0) return false
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?$/.exec(url)
  if (match === null) return false
  const scheme = match[1] ?? ''
  if (scheme !== 'http' && scheme !== 'https') return false
  const authority = match[2] ?? ''
  if (authority.length === 0) return false
  if (authority.includes('@') || authority.includes('[') || authority.includes(']')) return false
  // host 只允许 [a-z0-9.-]；端口只允许 1~5 位数字。
  if (/^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(authority) === null) return false
  const pathPart = match[3] ?? ''
  if (pathPart.includes('..') || pathPart.includes('\\')) return false
  const origin = `${scheme}://${authority}`.toLowerCase()
  return trustedOrigins.some((trusted) => trusted.trim().replace(/\/+$/, '').toLowerCase() === origin)
}

/**
 * 校验展示元数据 / Validate display metadata.
 *
 * 返回空数组表示通过。**任何未知字段、缺省必填字段、超限均拒绝**（fail closed）。
 */
export function validateDisplayMetadata(
  input: unknown,
  options: {
    allowedImageHosts: readonly string[]
    sourceRepository?: string | undefined
    /**
     * 受信目录后台的 origin 列表（如 `http://192.168.3.222:18080`）。
     * 仅当调用方确认该后台地址由运维配置时传入；缺省即不放行任何 http/相对来源。
     */
    trustedMediaOrigins?: readonly string[] | undefined
  },
): CatalogMetadataViolation[] {
  const out: CatalogMetadataViolation[] = []
  const push = (field: string, reason: string, reasonEn: string): void => {
    out.push({ field, reason, reasonEn })
  }
  if (typeof input !== 'object' || input === null) {
    return [{ field: '*', reason: '元数据必须是对象', reasonEn: 'metadata must be an object' }]
  }
  const meta = input as Record<string, unknown>

  if (meta['schemaVersion'] !== CATALOG_METADATA_SCHEMA_VERSION) {
    push('schemaVersion', `schemaVersion 必须是 ${CATALOG_METADATA_SCHEMA_VERSION}`, 'unsupported schemaVersion')
  }
  // 游戏仓库地址：必填、规范化、且必须与 source.repository 一致（同源，不造平行字段）。
  const repository = normalizeGameRepositoryUrl(meta['repository'])
  if (repository === null) {
    push(
      'repository',
      'repository 必须是 https://github.com/<owner>/<repo>（可带 .git），不得含凭据/query/fragment/子路径',
      'repository must be an https://github.com/<owner>/<repo> URL without credentials, query, fragment or sub-path',
    )
  } else if (options.sourceRepository !== undefined) {
    const source = normalizeGameRepositoryUrl(options.sourceRepository)
    if (source === null || source !== repository) {
      push(
        'repository',
        'display.repository 与机器块 source.repository 规范化后不一致',
        'display.repository does not match source.repository after normalization',
      )
    }
  }
  if (typeof meta['summary'] !== 'string' || meta['summary'].trim().length === 0 || meta['summary'].length > 200) {
    push('summary', 'summary 必须是 1~200 字符的纯文本', 'summary must be 1..200 plain text characters')
  }
  const description = meta['descriptionMarkdown']
  if (typeof description !== 'string' || description.length === 0) {
    push('descriptionMarkdown', 'descriptionMarkdown 不能为空', 'descriptionMarkdown must not be empty')
  } else if (description.length > DESCRIPTION_MARKDOWN_MAX_CHARS) {
    push(
      'descriptionMarkdown',
      `descriptionMarkdown 超过 ${DESCRIPTION_MARKDOWN_MAX_CHARS} 字符`,
      'descriptionMarkdown exceeds length limit',
    )
  } else {
    for (const hazard of findMarkdownHazards(description)) {
      push('descriptionMarkdown', `简介含禁用构造：${hazard}`, `description contains forbidden construct: ${hazard}`)
    }
  }

  // 封面 / cover
  const cover = meta['cover']
  if (cover !== null) {
    validateMedia(cover, 'cover', options, push)
  }

  // 截图 / screenshots
  const screenshots = meta['screenshots']
  if (!Array.isArray(screenshots)) {
    push('screenshots', 'screenshots 必须是数组（可为空数组）', 'screenshots must be an array')
  } else if (screenshots.length > SCREENSHOT_MAX_COUNT) {
    push('screenshots', `截图最多 ${SCREENSHOT_MAX_COUNT} 张`, 'too many screenshots')
  } else {
    screenshots.forEach((item, index) => validateMedia(item, `screenshots[${index}]`, options, push))
  }

  // 兼容性 / compatibility
  const compatibility = meta['compatibility']
  if (typeof compatibility !== 'object' || compatibility === null) {
    push('compatibility', 'compatibility 必须提供（gameCenter 与 dsh 两个 semver 范围）', 'compatibility is required')
  } else {
    const compat = compatibility as Record<string, unknown>
    for (const key of ['gameCenter', 'dsh'] as const) {
      const value = compat[key]
      if (typeof value !== 'string' || !SEMVER_RANGE_PATTERN.test(value)) {
        push(
          `compatibility.${key}`,
          `${key} 必须是合法的 semver 范围（未知或非法一律拒绝）`,
          `${key} must be a valid semver range (fail closed)`,
        )
      }
    }
  }

  return out
}

function validateMedia(
  item: unknown,
  field: string,
  options: { allowedImageHosts: readonly string[]; trustedMediaOrigins?: readonly string[] | undefined },
  push: (field: string, reason: string, reasonEn: string) => void,
): void {
  if (typeof item !== 'object' || item === null) {
    push(field, '图片引用必须是对象', 'media reference must be an object')
    return
  }
  const media = item as Record<string, unknown>
  // 两条通路互不替代：公网图片仍走 `isAllowedMediaUrl`（https + 精确白名单）；
  // `isTrustedMediaOriginUrl` 只放行运维配置的那个后台 origin。
  if (
    !isAllowedMediaUrl(media['url'], options.allowedImageHosts) &&
    !isTrustedMediaOriginUrl(media['url'], options.trustedMediaOrigins)
  ) {
    push(
      `${field}.url`,
      '图片必须是不含 userinfo / 非默认端口 / 白名单主机上的 https URL，或来自受信目录后台的同源地址',
      'media url must be https on an allowlisted host, without userinfo or custom port',
    )
  }
  if (typeof media['sha256'] !== 'string' || !DIGEST_HEX_PATTERN.test(media['sha256'])) {
    push(`${field}.sha256`, 'sha256 必须是 sha256:<64 位小写十六进制>', 'sha256 digest required')
  }
  if (!MEDIA_ALLOWED_MIME.includes(media['mime'] as MediaMime)) {
    push(`${field}.mime`, '只允许 png/jpeg/webp/gif（禁止 SVG）', 'only png/jpeg/webp/gif allowed (no SVG)')
  }
  for (const dim of ['width', 'height'] as const) {
    const value = media[dim]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MEDIA_MAX_EDGE_PX) {
      push(`${field}.${dim}`, `${dim} 必须是 1..${MEDIA_MAX_EDGE_PX} 的整数`, `${dim} must be a positive integer within limits`)
    }
  }
  if (typeof media['alt'] !== 'string' || media['alt'].trim().length === 0 || media['alt'].length > 200) {
    push(`${field}.alt`, 'alt 必须非空且不超过 200 字符', 'alt text required')
  }
}

/**
 * 元数据规范序列化 / Canonical metadata serialization.
 *
 * 用途：若将来把元数据纳入审批，需要一个稳定的摘要输入。
 * 规则：按字段名字典序、无空白、UTF-8；数组保持顺序（截图顺序有展示含义）。
 */
export function canonicalMetadataJson(meta: CatalogDisplayMetadata): string {
  const sortKeys = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, JsonValue> = {}
      for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, JsonValue>)[key] as JsonValue)
      return out
    }
    return value
  }
  return JSON.stringify(sortKeys(meta as unknown as JsonValue))
}

/**
 * 元数据摘要的计算口径（**本阶段不启用**，见 `METADATA_APPROVAL_ENABLED`）。
 * 若启用：`sha256:<hex>` over `canonicalMetadataJson(meta)` 的 UTF-8 字节，
 * 并与 Issue 的 `updated_at`/正文块修订绑定存储。
 */
export function describeMetadataDigestInput(): { version: number; algorithm: string; enabled: boolean } {
  return {
    version: CATALOG_METADATA_SCHEMA_VERSION,
    algorithm: 'sha256 over canonicalMetadataJson(...) UTF-8 bytes',
    enabled: METADATA_APPROVAL_ENABLED,
  }
}

/**
 * 兼容性门禁 / Compatibility gate.
 *
 * **真实门禁**：列表可展示、但**安装与启动前必须调用本函数**，
 * 任一范围不满足即拒绝（不降级、不提示"仍然安装"）。
 */
export function evaluateCompatibility(
  compatibility: CatalogCompatibility,
  running: { gameCenter: string; dsh: string },
  accepts: (range: string, version: string) => boolean,
): { ok: true } | { ok: false; field: 'gameCenter' | 'dsh'; reason: string; reasonEn: string } {
  if (!accepts(compatibility.gameCenter, running.gameCenter)) {
    return {
      ok: false,
      field: 'gameCenter',
      reason: `游戏要求游戏中心 ${compatibility.gameCenter}，当前为 ${running.gameCenter}`,
      reasonEn: `requires game center ${compatibility.gameCenter}, running ${running.gameCenter}`,
    }
  }
  if (!accepts(compatibility.dsh, running.dsh)) {
    return {
      ok: false,
      field: 'dsh',
      reason: `游戏要求 DSH ${compatibility.dsh}，当前为 ${running.dsh}`,
      reasonEn: `requires DSH ${compatibility.dsh}, running ${running.dsh}`,
    }
  }
  return { ok: true }
}
