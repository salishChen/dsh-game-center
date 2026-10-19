/**
 * 模型能力建模（基线 §5.1）。
 *
 * 关键规则：
 * - 不要只存“multimodal: true”。能力分为 操作 / 输入模态 / 输出模态 / 附加特性 / 限制。
 * - 元数据缺失一律表示 `unknown`，不得默认视为支持。
 * - DSH 目录中的图像输入信息只能证明声明的输入能力，不能推出输出能力，
 *   也不能证明真实端点可用；必须同时确认 adapter 能执行该操作。
 */

/** AI 操作名。首版只实现 chat.generate；其余为已定义但需适配器支持的能力。 */
export const AI_OPERATIONS = [
  'chat.generate',
  'image.generate',
  'image.edit',
  'audio.transcribe',
  'audio.synthesize',
  'video.understand',
  'video.generate',
] as const

export type AIOperation = (typeof AI_OPERATIONS)[number]

/** 核心模态：与 DSH ModelModalityMap 的 text / image 对齐，其余按需扩展。 */
export const MODALITIES = ['text', 'image', 'audio', 'video'] as const

export type Modality = (typeof MODALITIES)[number]

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown'

/** 证据来源：决定该能力声明有多可信。 */
export type CapabilityEvidence = 'adapter' | 'dsh-catalog' | 'manual' | 'probe'

/** 发现缺口，不猜测。 */
export interface CapabilityQuery {
  operation: AIOperation
  requires: {
    input: Modality[]
    output: Modality[]
  }
}

export interface ModelLimits {
  /** 单次请求最大上下文 token 数（未知则缺省）。 */
  contextTokens?: number
  /** 单次请求最大输出 token 数（未知则缺省）。 */
  outputTokens?: number
  /** 单次请求允许的最大图片数量。 */
  maxImagesPerRequest?: number
}

/**
 * 一个具体模型的能力条目（脱敏，绝不含凭据与端点）。
 */
export interface ModelCapabilityEntry {
  providerId: string
  modelId: string
  adapterId: string
  operations: AIOperation[]
  inputModalities: Modality[]
  outputModalities: Modality[]
  streaming: CapabilityStatus
  structuredOutput: CapabilityStatus
  limits: ModelLimits
  status: CapabilityStatus
  evidence: CapabilityEvidence
  /** ISO 8601 时间戳。 */
  verifiedAt: string
  adapterVersion: string
}

/** 单个 slot 的匹配结果。 */
export interface SlotMatch {
  slot: string
  /** 满足该 slot 全部需求的候选模型（已脱敏）。 */
  candidates: ModelCapabilityEntry[]
  /** 需求中没有任何候选模型满足的具体缺口，空数组表示完全满足。 */
  missing: CapabilityQuery[]
}

/**
 * 能力匹配：判断一个模型条目是否满足查询。
 *
 * 注意这是纯函数，只用于筛选候选；实际请求前 Host 仍须重新验证绑定可用。
 */
export function satisfies(entry: ModelCapabilityEntry, query: CapabilityQuery): boolean {
  if (entry.status !== 'supported') return false
  if (!entry.operations.includes(query.operation)) return false
  for (const modality of query.requires.input) {
    if (!entry.inputModalities.includes(modality)) return false
  }
  for (const modality of query.requires.output) {
    if (!entry.outputModalities.includes(modality)) return false
  }
  return true
}

/**
 * 必需 slot 无候选时，返回缺失的具体能力；全部满足时返回空数组。
 * 可选 slot 的降级策略由 manifest 显式声明，本函数不做隐式降级。
 */
export function missingCapabilities(
  query: CapabilityQuery,
  entries: readonly ModelCapabilityEntry[],
): CapabilityQuery[] {
  return entries.some((entry) => satisfies(entry, query)) ? [] : [query]
}
