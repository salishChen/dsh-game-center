/**
 * 统一错误码与错误信封（基线 §6 末尾）。
 *
 * 原则：
 * - 错误码是协议的一部分，游戏与界面只按 code 分支，不解析 message 文本。
 * - 任何错误都不得携带 provider 凭据、base URL、token 或主 DSH 会话内容。
 * - `retryable` 由 Host 判定，游戏不得自行推断“重试是免费的”。
 */

export const ERROR_CODES = [
  /** 所需能力（操作/输入/输出模态）无可用适配器或模型。 */
  'CAPABILITY_UNAVAILABLE',
  /** 已绑定模型被删除、停用或不在 provider 目录中。 */
  'MODEL_UNAVAILABLE',
  /** 凭据缺失或失效；需要玩家在设置中修复，不重试。 */
  'CREDENTIAL_REQUIRED',
  /** 请求频率或并发超限。 */
  'RATE_LIMIT',
  /** 请求次数/token/图片额度已用尽。 */
  'BUDGET_EXCEEDED',
  /** 运行实例已被暂停（关闭弹层、租约失效、控制代次被封存）。 */
  'PAUSED',
  /** 请求被显式取消。取消不保证 provider 停止运算，也不保证免除已产生费用。 */
  'ABORTED',
  /** 模型输出未通过 responseSchema 或游戏自有约束。 */
  'INVALID_OUTPUT',
  /** 请求已发出但无法判断 provider 是否成功；不得无提示地重新付费生成。 */
  'REQUEST_OUTCOME_UNKNOWN',
  /** 存档与当前游戏版本/SDK 主版本不兼容。 */
  'SAVE_INCOMPATIBLE',
  /** manifest 未声明存档能力；调用 checkpoint/saveAck/saveLatest 的非致命结果，调用方应忽略并继续关闭。 */
  'SAVE_UNSUPPORTED',
  /** 协议层校验失败：Schema、大小上限、未知字段、未知主版本。 */
  'PROTOCOL_INVALID',
  /** 运行代次或控制租约不匹配，拒绝迟到写入。 */
  'STALE_RUNTIME',
  /**
   * 目录后台不可达（断网、代理错误、后台重启、超时）。
   *
   * 必须与「没有匹配的审批记录」分开：前者是环境问题、稍后可重试，
   * 后者是业务结论。混用会把每次网络抖动都显示成"没审批"，带偏排查方向。
   */
  'CATALOG_UNREACHABLE',
  /**
   * 未预期内部错误。新增错误码必须新增到本表并在协议评审中声明，
   * 不得用任意字符串充当错误码。
   */
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ProtocolError {
  code: ErrorCode
  /** 面向玩家的简短说明（可本地化），不得包含敏感信息。 */
  message: string
  /** 是否可能在稍后重试成功；取消、凭据、暂停类错误为 false。 */
  retryable: boolean
  /** 可选的结构化细节，例如缺失的能力名、需要的 slot。 */
  details?: Record<string, string | number | boolean>
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/**
 * 可由错误码推导的默认可重试语义；Host 可覆盖为更严格的值。
 */
export const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  CAPABILITY_UNAVAILABLE: false,
  MODEL_UNAVAILABLE: false,
  CREDENTIAL_REQUIRED: false,
  RATE_LIMIT: true,
  BUDGET_EXCEEDED: false,
  PAUSED: true,
  ABORTED: false,
  INVALID_OUTPUT: true,
  REQUEST_OUTCOME_UNKNOWN: false,
  SAVE_INCOMPATIBLE: false,
  SAVE_UNSUPPORTED: false,
  PROTOCOL_INVALID: false,
  STALE_RUNTIME: false,
  CATALOG_UNREACHABLE: true,
  INTERNAL: false,
}

export function protocolError(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean>,
): ProtocolError {
  const base: ProtocolError = { code, message, retryable: DEFAULT_RETRYABLE[code] }
  return details === undefined ? base : { ...base, details }
}
