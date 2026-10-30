/**
 * 游戏 manifest（`gamecenter.json`，基线 §5）。
 *
 * 这是固定提交内的运行契约，是 manifest 的唯一来源；
 * 发布工具从它生成 Issue 摘要，避免维护两份互相冲突的运行配置。
 *
 * 本文件所有接口都是【拟新增协议】，不是 DSH 既有 API。
 */

import type { AIOperation, Modality } from './capabilities.js'

export interface ManifestAiSlot {
  /** 该 slot 是否为必需：必需 slot 无可用模型时，启动按钮给出缺失能力并禁止开始。 */
  required: boolean
  operation: AIOperation
  requires: {
    input: Modality[]
    output: Modality[]
  }
  /**
   * 可选 slot 的显式降级方式。仅允许游戏上架时声明，
   * 平台不得隐式降级。缺省表示“无降级，视为必需”。
   */
  fallback?: 'bundled-assets' | 'skip'
}

export interface GameManifestV1 {
  /** 未知主版本必须拒绝。 */
  schemaVersion: 1
  /** 稳定游戏身份，不依赖 Issue 标题；形如 `namespace.slug`。 */
  id: string
  name: string
  /** Local preview metadata; published discovery uses Issue categories. */
  categories?: string[]
  version: string
  /** SDK 兼容范围；范围语法见 version.ts 的 sdkRangeAccepts。 */
  sdk: string
  runtime: {
    kind: 'web'
    /** 相对游戏仓库根目录的入口路径，必须位于 dist/ 内。 */
    entry: string
  }
  /**
   * 存档能力声明。缺省 = 该游戏不支持存档：
   * Host 不得要求 checkpoint/saveAck，关闭时直接撤销租约并回收容器；
   * 调用 saveCheckpoint/saveAck/saveLatest 一律返回 SAVE_UNSUPPORTED（非致命）。
   */
  save?: SaveCapability
  permissions: {
    storage: 'game-scoped'
    /** 首版必须为 false：所有 AI 与存档经 Bridge。 */
    directNetwork: false
  }
  ai?: {
    slots: Record<string, ManifestAiSlot>
    /** 要求同一模型承担的 slot 分组；组内 slot 必须绑定到同一 provider/model。 */
    sameModelGroup?: string[][]
  }
}

/**
 * 存档能力声明（manifest.save）。
 * - `supportsResume: true`：可跨会话续玩，关闭时必须落盘并封存代次。
 * - `supportsResume: false`：允许写检查点但不提供续玩入口，关闭不强制落盘。
 */
export interface SaveCapability {
  schemaVersion: number
  supportsResume: boolean
  checkpointPolicy: 'each-action' | 'manual'
}

/** 存档能力判定：Host 与 Client 共用，禁止各处各写一份 `manifest.save?.x`。 */
export function hasSaveCapability(
  manifest: { save?: SaveCapability },
): manifest is { save: SaveCapability } {
  return manifest.save !== undefined
}

/** 游戏 id 规则：2~64 字符，小写字母数字与 `.` `-`，必须以字母或数字开头结尾。 */
export const GAME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/

export function isValidGameId(value: string): boolean {
  return GAME_ID_PATTERN.test(value)
}

/** The single shared interpretation of optional save declarations. */
export function getSaveMode(manifest: {save?:SaveCapability}): 'none' | 'checkpoint-only' | 'resumable' {
  if (!hasSaveCapability(manifest)) return 'none'
  if (!manifest.save || !Number.isInteger(manifest.save.schemaVersion) || manifest.save.schemaVersion < 1 ||
      typeof manifest.save.supportsResume !== 'boolean' || !['each-action','manual'].includes(manifest.save.checkpointPolicy)) throw new Error('非法存档能力声明')
  return manifest.save.supportsResume ? 'resumable' : 'checkpoint-only'
}
