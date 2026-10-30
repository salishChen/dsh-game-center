import {
  parseCatalogIssueBody,
  normalizeGameRepositoryUrl,
  validateDisplayMetadata,
  findMarkdownHazards,
  validGameCategories,
  type CatalogParseResult,
  type CatalogEntryView,
  type CatalogSourceKey,
  type ErrorCode,
  type CatalogDisplayMetadata,
} from '@dsh-gamecenter/protocol'

export { parseCatalogIssueBody }
export type { CatalogParseResult }

export interface GitHubRawIssue {
  id?: number | string
  number: number | string
  title?: string
  body?: string | null
  state?: string
  updated_at?: string
  pull_request?: unknown
}

export interface ParseGitHubIssueOptions {
  allowedImageHosts?: readonly string[] | undefined
}

export type ParseGitHubIssueResult =
  | {
      ok: true
      entryView: CatalogEntryView
    }
  | {
      ok: false
      code: ErrorCode
      reason: string
    }

/**
 * 从 Issue 正文的 Markdown 中提取声明的"游戏地址"。
 * 匹配类似：
 * - **游戏地址 / Game repository URL**（必填 / required）：`https://github.com/foo/bar.git`
 * - **游戏地址**：https://github.com/foo/bar
 */
export function extractGameRepoUrlFromBody(body: string): string | null {
  const match = /(?:游戏地址|Game repository URL)[^\n`]*?[:：]\s*`?([^\s`\n]+)`?/i.exec(body)
  if (!match) return null
  const url = match[1]?.trim() ?? ''
  return url.length > 0 ? url : null
}

/**
 * 从 Issue 正文中提取 Markdown 简介章节。
 */
export function extractDescriptionFromMarkdown(body: string): string | null {
  const match = /###\s*(?:简介|Description)[^\n]*\n([\s\S]*?)(?=(?:^##\s|\n```|$))/m.exec(body)
  if (!match) return null
  const desc = match[1]?.trim() ?? ''
  return desc.length > 0 ? desc : null
}

/**
 * 解析来自 GitHub API 的 Issue 对象。
 *
 * 强制约束（基线 §4.1、§9、v3）：
 * 1. 严格排除 PR 记录（包含 pull_request 字段即拒绝）；
 * 2. 正文必须包含单个合法的 gamecenter-json 机器块；
 * 3. 拒绝重复块、重复 key、超限正文与未知主版本；
 * 4. Issue 标识转为字符串，不强假定数字类型；
 * 5. 正文"游戏地址"与机器块 source.repository 必须规范化后一致，否则拒绝；
 * 6. 调用 validateDisplayMetadata 校验展示元数据与受控媒体；
 * 7. 简介 Markdown 严格禁止 raw HTML、<img>、外部图片语法与危险 scheme (javascript:/data:)。
 */
export function parseGitHubIssuePayload(
  rawIssue: unknown,
  context: { owner: string; repo: string },
  options?: ParseGitHubIssueOptions,
): ParseGitHubIssueResult {
  if (rawIssue === null || typeof rawIssue !== 'object') {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: 'Issue 数据载荷必须是有效对象',
    }
  }

  const issue = rawIssue as GitHubRawIssue

  // 基线 §4.1 / 计划 §1：GitHub Issues 列表必须排除 PR 记录
  if ('pull_request' in issue && issue.pull_request !== undefined && issue.pull_request !== null) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: '排除 Pull Request 记录，仅接收纯 Issue 目录条目',
    }
  }

  if (issue.number === undefined || issue.number === null) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: 'Issue 载荷缺少 number 标识',
    }
  }

  const issueId = String(issue.number).trim()
  if (issueId.length === 0) {
    return {
      ok: false,
      code: 'PROTOCOL_INVALID',
      reason: 'Issue 标识不能为空',
    }
  }

  const body = typeof issue.body === 'string' ? issue.body : ''
  const parsed = parseCatalogIssueBody(body)
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      reason: parsed.reason,
    }
  }

  // Existing Issues can add a human field before older Hosts understand the JSON key.
  const categoryLine=/^\s*-?\s*(?:\*\*)?(?:游戏分类\s*\/\s*Categories|游戏分类|Categories)(?:\*\*)?[^\n:：]*[:：]\s*([^\n]+)/mi.exec(body)
  if(categoryLine){
    const categories=categoryLine[1]!.replace(/[`*]/g,'').split(/[,，、\/|]/).map(s=>s.trim()).filter(Boolean)
    if(!validGameCategories(categories))return {ok:false,code:'PROTOCOL_INVALID',reason:'正文游戏分类必须为 1–3 个有效且不重复的分类'}
    if(parsed.entry.categories&&[...parsed.entry.categories].sort().join('|')!==[...categories].sort().join('|'))return {ok:false,code:'PROTOCOL_INVALID',reason:'正文游戏分类与机器块 categories 不一致'}
    parsed.entry.categories=categories
  }

  // 1. 正文"游戏地址"与机器块 source.repository 校验
  const bodyRepoUrl = extractGameRepoUrlFromBody(body)
  if (bodyRepoUrl) {
    const normalizedBodyRepo = normalizeGameRepositoryUrl(bodyRepoUrl)
    if (!normalizedBodyRepo) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: '正文游戏地址格式不合法（必须是 https://github.com/<owner>/<repo>，不得含凭据/query/fragment/子路径）',
      }
    }
    const normalizedSourceRepo = normalizeGameRepositoryUrl(parsed.entry.source.repository)
    if (normalizedBodyRepo !== normalizedSourceRepo) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: '正文游戏地址与机器块 source.repository 规范化后不一致',
      }
    }
  }

  // 2. 展示元数据与 Markdown 危险构造校验
  const display = parsed.entry.display
  if (display) {
    const displayInput = {
      ...(display as unknown as Record<string, unknown>),
      repository: bodyRepoUrl ?? (display as any).repository ?? parsed.entry.source.repository,
    }
    const violations = validateDisplayMetadata(displayInput, {
      allowedImageHosts: options?.allowedImageHosts ?? [
        'user-images.githubusercontent.com',
        'raw.githubusercontent.com',
      ],
      sourceRepository: parsed.entry.source.repository,
    })
    if (violations.length > 0) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        reason: `展示元数据校验失败: ${violations.map((v) => `${v.field}: ${v.reason}`).join('; ')}`,
      }
    }
  } else {
    // 若未在机器块内提供 display，但 Markdown 正文中有简介章节，同样进行危险构造扫描
    const extractedDesc = extractDescriptionFromMarkdown(body)
    if (extractedDesc) {
      const hazards = findMarkdownHazards(extractedDesc)
      if (hazards.length > 0) {
        return {
          ok: false,
          code: 'PROTOCOL_INVALID',
          reason: `简介含禁用构造：${hazards.join(', ')}`,
        }
      }
    }
  }

  const key: CatalogSourceKey = {
    forge: 'github',
    owner: context.owner,
    repo: context.repo,
    issueId,
  }

  let rawJson: unknown
  try {
    rawJson = JSON.parse(parsed.rawMachineBlock)
  } catch {
    rawJson = parsed.rawMachineBlock
  }

  const entryView: CatalogEntryView = {
    key,
    entry: parsed.entry,
    approvalState: 'unknown',
    fetchedAt: issue.updated_at || new Date().toISOString(),
    raw: rawJson as any,
  }

  return {
    ok: true,
    entryView,
  }
}
