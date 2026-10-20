import {
  parseCatalogIssueBody,
  type CatalogParseResult,
  type CatalogEntryView,
  type CatalogSourceKey,
  type ErrorCode,
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
 * 解析来自 GitHub API 的 Issue 对象。
 *
 * 强制约束：
 * 1. 严格排除 PR 记录（包含 pull_request 字段即拒绝）；
 * 2. 正文必须包含单个合法的 gamecenter-json 机器块；
 * 3. 拒绝重复块、重复 key、超限正文与未知主版本；
 * 4. Issue 标识转为字符串，不强假定数字类型。
 */
export function parseGitHubIssuePayload(
  rawIssue: unknown,
  context: { owner: string; repo: string },
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
