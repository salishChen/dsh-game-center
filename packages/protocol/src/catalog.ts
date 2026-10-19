/**
 * 目录条目协议（基线 §4.1）。
 *
 * Issue 是可变的发现索引，不能单独作为信任根。
 * 决定某个版本是否可安装的是已批准的 {gameId, repository, commit, manifestDigest, bundleDigest}。
 * 本文件只定义机器块的解析契约，不定义网络与鉴权。
 */

import type { JsonValue } from './json.js'

/** 固定提交内的发布元组；Issue 中展示的部分必须与之逐字节一致。 */
export interface CatalogReleaseRef {
  /** 完整提交 SHA（40 位十六进制），实际下载以此为准；ref 只供人识别。 */
  commit: string
  /** 人类可读的 ref/tag；不参与下载决策。 */
  ref: string
  /** 游戏仓库 URL，首版限定 GitHub/Gitee HTTPS。 */
  repository: string
  manifestPath: string
  /** `sha256:<hex>`，针对 manifest 文件原始字节。 */
  manifestDigest: string
  /** `sha256:<hex>`，针对规范化的 dist 文件清单。 */
  bundleDigest: string
}

/** Issue 机器块中的条目（`gamecenter-json` 代码块内容）。 */
export interface CatalogMachineEntry {
  schemaVersion: 1
  gameId: string
  title: string
  summary: string
  version: string
  source: CatalogReleaseRef
}

/** 目录来源身份：不依赖 Issue 标题，也不假设 Gitee 的 issue 标识是数字。 */
export interface CatalogSourceKey {
  forge: 'github' | 'gitee'
  owner: string
  repo: string
  issueId: string
}

export function catalogSourceKeyString(key: CatalogSourceKey): string {
  return `${key.forge}:${key.owner}/${key.repo}#${key.issueId}`
}

/** 审批记录：受保护分支上的可信审批，才是安装的信任根。 */
export interface ApprovedRelease {
  gameId: string
  /** 被审批的游戏仓库 URL；来源身份参与信任根，防止把同一提交/摘要改挂到别的仓库。 */
  repository: string
  commit: string
  manifestDigest: string
  bundleDigest: string
  /** 审批者与审批记录位置，用于审计。 */
  approvedBy: string
  approvedAt: string
  approvalRecordPath: string
}

/**
 * 安装门禁判定：Issue 中的发布元组必须与某条审批记录逐字段一致。
 * 五元组 = {gameId, repository, commit, manifestDigest, bundleDigest}，缺一不可。
 * 返回 null 表示允许安装（附带命中的审批记录），否则返回拒绝原因。
 */
export function matchApproval(
  entry: CatalogMachineEntry,
  approvals: readonly ApprovedRelease[],
): { ok: true; approval: ApprovedRelease } | { ok: false; reason: string } {
  const hit = approvals.find(
    (approval) =>
      approval.gameId === entry.gameId &&
      approval.repository === entry.source.repository &&
      approval.commit === entry.source.commit &&
      approval.manifestDigest === entry.source.manifestDigest &&
      approval.bundleDigest === entry.source.bundleDigest,
  )
  if (!hit) {
    return {
      ok: false,
      reason: 'Issue 中的发布元组与任何审批记录都不一致；旧审批不会自动覆盖新内容。',
    }
  }
  return { ok: true, approval: hit }
}

/**
 * 摘要字符串规范：`sha256:` + 64 位小写十六进制。
 */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value)
}

/** 提交 SHA 规范：40 位小写十六进制（首版不启用短 SHA）。 */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/

export function isFullCommit(value: string): boolean {
  return COMMIT_PATTERN.test(value)
}

/** 描述文字只作展示，不能被解释为安装命令。 */
export type CatalogDisplayText = string

/** 目录条目在本地缓存中的形态（可与审批状态一同展示）。 */
export interface CatalogEntryView {
  key: CatalogSourceKey
  entry: CatalogMachineEntry
  /** 审批状态；未审批条目可展示但不可安装。 */
  approvalState: 'approved' | 'pending' | 'rejected' | 'unknown'
  fetchedAt: string
  /** 原始机器块的可校验副本，便于对账。 */
  raw: JsonValue
}
