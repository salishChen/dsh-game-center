import {
  matchApproval,
  buildInstallPlan,
  type CatalogMachineEntry,
  type ApprovedRelease,
  type CatalogEntryView,
} from '@dsh-gamecenter/protocol'
import type { EvaluateInstallResult } from './types.js'

/**
 * 校验条目是否满足安装门禁（五元组比对）。
 * 五元组包括：{ gameId, repository, commit, manifestDigest, bundleDigest }。
 *
 * 任何一个字段不匹配均不可安装，原因码严格使用 protocol 的 ERROR_CODES。
 */
export function evaluateInstallability(
  entry: CatalogMachineEntry,
  approvals: readonly ApprovedRelease[],
): EvaluateInstallResult {
  const matched = matchApproval(entry, approvals)
  if (!matched.ok) {
    return {
      installable: false,
      code: 'PROTOCOL_INVALID',
      reason: matched.reason,
    }
  }

  const planResult = buildInstallPlan(entry, approvals)
  if (!planResult.ok) {
    return {
      installable: false,
      code: planResult.code,
      reason: planResult.reason,
    }
  }

  return {
    installable: true,
    approval: matched.approval,
    plan: planResult.plan,
  }
}

/**
 * 用审批记录列表丰富 CatalogEntryView 的展示状态。
 */
export function annotateEntryViewWithApproval(
  view: CatalogEntryView,
  approvals: readonly ApprovedRelease[],
): CatalogEntryView {
  const result = evaluateInstallability(view.entry, approvals)
  if (result.installable) {
    return {
      ...view,
      approvalState: 'approved',
    }
  }

  // 检查是否有该 gameId 历史审批（若有但当前五元组不符，属于待审核或版本未批准）
  const hasHistory = approvals.some((a) => a.gameId === view.entry.gameId)
  return {
    ...view,
    approvalState: hasHistory ? 'pending' : 'unknown',
  }
}
