/**
 * 存档协议（基线 §8.2）。
 *
 * 本文件是存档的**磁盘/传输结构**；Host 是唯一权威写入方。
 * 游戏提供的 `state` 是不透明 JSON，平台不解释其语义，只做大小与完整性校验。
 */

import type { JsonValue } from './json.js'

export type SaveStatus = 'running' | 'paused' | 'finished' | 'recovery-available'

export interface ModelBinding {
  providerId: string
  modelId: string
}

export interface GameSaveV1 {
  saveFormatVersion: 1
  /** 存档内 gameplay 状态结构版本；迁移由游戏提供显式迁移函数。 */
  gameStateSchemaVersion: number
  gameId: string
  saveId: string
  /** 存档固定到该提交：更新安装新版本目录，不覆盖旧目录。 */
  installedCommit: string
  /** 单调递增；旧代次的迟到写入按 revision 拒绝。 */
  revision: number
  status: SaveStatus
  /** 只在 Running 状态累计的游戏虚拟时间。 */
  elapsedGameMs: number
  /** 可序列化随机数状态；恢复后不得按现实时间补跑。 */
  rngState: string
  modelBindings: Record<string, ModelBinding>
  state: JsonValue
  assetIds: string[]
  /** 快照需要关联的已应用操作；不要求无限复制全部历史。 */
  lastAppliedOperationIds: string[]
  /** 存档完整性摘要（覆盖除本字段外的规范序列化内容）。 */
  integrityDigest?: string
}

/**
 * AI 请求账本状态（基线 §8.3）。
 * 状态迁移只允许沿下列方向前进，任何回退都必须作为新记录出现。
 */
export const AI_OPERATION_STATES = [
  'Prepared',
  'Submitted',
  'Completed',
  'Applied',
  'Cancelled',
  'Failed',
  'OutcomeUnknown',
] as const

export type AiOperationState = (typeof AI_OPERATION_STATES)[number]

/** 从某状态可以前往的状态集合；用于 Host 侧状态机校验。 */
export const AI_OPERATION_TRANSITIONS: Record<AiOperationState, readonly AiOperationState[]> = {
  Prepared: ['Submitted', 'Cancelled', 'Failed'],
  Submitted: ['Completed', 'Cancelled', 'Failed', 'OutcomeUnknown'],
  Completed: ['Applied'],
  Applied: [],
  Cancelled: [],
  Failed: [],
  OutcomeUnknown: [],
}

export function canTransition(from: AiOperationState, to: AiOperationState): boolean {
  return AI_OPERATION_TRANSITIONS[from].includes(to)
}

export interface AiOperationRecord {
  /**
   * 幂等键由 Host 用 {player, gameId, saveId} + 游戏提交的 operationId 组合而成；
   * 小游戏不能伪造别的存档身份。
   */
  idempotencyKey: string
  gameId: string
  saveId: string
  slot: string
  /** 提交时的精确模型绑定，用于事后审计与额度核算。 */
  binding: ModelBinding
  state: AiOperationState
  /** 玩家动作意图的快照，保证可见输入可从持久日志重建。 */
  requestDigest: string
  createdAt: string
  updatedAt: string
}

/**
 * 运行代次与控制租约（基线 §8.1、§6）。
 * 运行凭证绑定游戏/存档/运行代次，关闭后失效；它不是 DSH 的登录凭据。
 */
export interface RuntimeLease {
  runtimeInstanceId: string
  /** 单调递增的运行代次；旧代次写入一律拒绝。 */
  generation: number
  gameId: string
  saveId: string
  expiresAt: string
  /** 已封存的代次列表，用于拒绝迟到写入。 */
  sealed: boolean
}

/**
 * 存档兼容判定结果。插件或 SDK 主版本不兼容时必须给出明确原因，
 * 不能直接丢弃进度。
 */
export type SaveCompatibility =
  | { compatible: true }
  | {
      compatible: false
      reason:
        | 'save-format-major-mismatch'
        | 'game-state-major-unsupported'
        | 'sdk-major-mismatch'
        | 'unknown-game-version'
      detail: string
    }

/**
 * 首版兼容策略：
 * - saveFormatVersion 主版本必须等于当前；
 * - gameStateSchemaVersion 必须被游戏声明支持（由游戏 manifest/迁移表给出集合）；
 * - 存档固定的提交必须仍可解析（安装目录保留旧版本）。
 */
export function checkSaveCompatibility(input: {
  save: GameSaveV1
  currentSaveFormatVersion: number
  supportedGameStateVersions: readonly number[]
  installedCommits: readonly string[]
}): SaveCompatibility {
  const { save } = input
  if (save.saveFormatVersion !== input.currentSaveFormatVersion) {
    return {
      compatible: false,
      reason: 'save-format-major-mismatch',
      detail: `saveFormatVersion ${save.saveFormatVersion} != ${input.currentSaveFormatVersion}`,
    }
  }
  if (!input.supportedGameStateVersions.includes(save.gameStateSchemaVersion)) {
    return {
      compatible: false,
      reason: 'game-state-major-unsupported',
      detail: `gameStateSchemaVersion ${save.gameStateSchemaVersion} not in [${input.supportedGameStateVersions.join(', ')}]`,
    }
  }
  if (!input.installedCommits.includes(save.installedCommit)) {
    return {
      compatible: false,
      reason: 'unknown-game-version',
      detail: `installedCommit ${save.installedCommit} not installed`,
    }
  }
  return { compatible: true }
}
