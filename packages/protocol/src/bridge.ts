/**
 * Client Bridge 协议（基线 §6、§7）。
 *
 * 边界：小游戏运行在受限 iframe + 专用 MessagePort 中，
 * 不获得 Cordis ctx、DSH RPC 对象、主窗口 DOM、文件系统、Git token 或 API key。
 * Bridge 只提供白名单操作，每条消息做 Schema、大小、频率与状态校验。
 */

import type { JsonValue } from './json.js'
import type { AIOperation } from './capabilities.js'

/** Bridge 方法白名单：不在本表的方法一律视为 PROTOCOL_INVALID。 */
export const BRIDGE_METHODS = [
  'handshake',
  'ai.generate',
  'ai.cancel',
  'save.checkpoint',
  'lifecycle.ready',
  'lifecycle.pauseAck',
] as const

export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

export interface GameMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
  /** 图片输入以资产 id 引用，不允许内联任意 URL。 */
  assetIds?: string[]
}

export interface AiGenerateRequest {
  slot: string
  operation: AIOperation
  /** 只在 {player, gameId, saveId} 范围内有意义，由宿主组合成幂等键。 */
  operationId: string
  messages: GameMessage[]
  /** 期望的结构化输出；不意味着每个 provider 都有原生结构化输出。 */
  responseSchema?: JsonValue
}

export interface AiGenerateResult {
  operationId: string
  /** 经宿主验证后的文本或结构化载荷；不是可执行代码。 */
  output: JsonValue
  /** 实际 provider/model，用于界面显示与审计。 */
  binding: { providerId: string; modelId: string }
  /** 是否由原生结构化输出产生（false 表示返回后验证）。 */
  structuredNative: boolean
}

export interface InboundEnvelope {
  bridgeVersion: 1
  /** 每次调用唯一，用于配对响应与幂等去重。 */
  requestId: string
  method: BridgeMethod
  payload: JsonValue
}

export type OutboundEnvelope =
  | { bridgeVersion: 1; requestId: string; ok: true; payload: JsonValue }
  | {
      bridgeVersion: 1
      requestId: string
      ok: false
      error: { code: string; message: string; retryable: boolean }
    }

/**
 * 存档槽位（saveId）冻结值——Host 租约、Client 本地租约、`saveLatest` 查询的**唯一**来源。
 *
 * - `default`：正式安装的游戏。同一 gameId 下的"继续游戏"按此槽位读回上一局；
 * - `preview`：本地受控预览。与正式存档隔离，预览不得写入或读到正式槽位。
 *
 * 槽位是**存档身份**，不是运行身份：`runtimeInstanceId` 每次启动都不同，
 * 绝不能拿它充当 saveId（那会让续玩永远读不到检查点）。
 */
export const SAVE_SLOTS = Object.freeze({
  default: 'save-default',
  preview: 'save-preview',
} as const)

export type SaveSlot = (typeof SAVE_SLOTS)[keyof typeof SAVE_SLOTS]

/** 存档槽位合法性：1~128 字符，且不得含路径分隔符（与 `validateSaveLatestRequest` 同一口径）。 */
export function isSaveIdShapeValid(saveId: unknown): saveId is string {
  return (
    typeof saveId === 'string' &&
    saveId.length > 0 &&
    saveId.length <= 128 &&
    !saveId.includes('/') &&
    !saveId.includes('\\')
  )
}

/**
 * 握手载荷。沙箱下 iframe origin 可能是 `null`，
 * 因此不能仅通过 event.origin 认证：必须校验确定的 event.source、一次性 nonce 和运行实例，
 * 再建立专用 MessagePort。
 */
export interface HandshakeRequest {
  runtimeInstanceId: string
  nonce: string
  /**
   * 启动令牌 `launchToken`：Client Bridge 在**每次启动**时生成的一次性、不可猜的随机值
   * （≥128 位熵，如 32 字节 base64url），只在本 Client 进程内存中持有。
   *
   * 用途（2026-10-20 生命周期修复，PM 冻结契约）：
   * - `abandonRuntime` 用它证明"我就是这个启动的发起者"，Host **不得**仅凭
   *   `gameId`/`saveId`/`runtimeInstanceId` 允许任意调用方撤销别的实例；
   * - Host 在握手中绑定期望令牌摘要，未确认的握手超时回收后，旧令牌摘要永久失效
   *   （不得复活旧凭证、不得回退代次）。
   *
   * **隔离要求**：该值绝不进入游戏 iframe、不进日志、不进 UI 文案、不进错误 message。
   * Host 只存摘要（与 `runtimeToken` 同一条纪律）。
   */
  launchToken: string
  /** 游戏自报 id 与版本，仅作交叉校验；权威值来自 Host 已安装版本。 */
  gameId: string
  gameVersion: string
  sdkVersion: string
  bridgeVersion: 1
  /**
   * 存档槽位（协议冻结，取值见 `SAVE_SLOTS`）。
   *
   * **阶段1 收尾变更**：Host 原先在缺省时回退 `saveId = runtimeInstanceId`，
   * 而 Client 续玩查询用固定槽位，于是 Host 租约槽位每次运行都不同、
   * `saveLatest` 永远 `absent`（"关闭保存→重开恢复"结构上不成立）。
   * 现在槽位由调用方显式给出并按 `isSaveIdShapeValid` 校验；
   * Client 的握手、本地租约、续玩查询必须使用同一个值。
   */
  saveId: string
}

export interface HandshakeResponse {
  ok: boolean
  /** 成功时下发的一次性运行凭证；只对本运行代次有效，关闭后失效。 */
  runtimeToken?: string
  generation?: number
  /** 宿主判定为不可运行时的原因码。 */
  errorCode?: string
}

// ————————————————————————————————————————————————————————————————
// 生命周期：放弃未完成启动 + 有界未确认握手回收（2026-10-20，PM 冻结契约）
// ————————————————————————————————————————————————————————————————

/**
 * 租约"启动未确认"的窗口语义（`T_ack`）。
 *
 * 【为什么不是"玩家 3 秒不操作就回收"】
 * 玩家在目录里停一会儿完全正常，**绝不能**因为无人操作就回收活跃租约。
 * 因此窗口只覆盖"租约已创建但尚未被客户端确认拿到"的短暂阶段：
 *
 * 1. Host `handshake` 成功后租约处于 `pending`（尚未 `running`，不接受业务写入）；
 * 2. 客户端拿到握手响应后**立即**发起确认（`leaseStatus` 或 `pause`/`saveCheckpoint`/`saveAck`
 *    任一携带该 `runtimeToken` 的调用，客户端启动成功后也会自动主动确认一次）；
 * 3. 确认到达后租约进入 `running`，此后 `T_ack` 不再适用——玩家静止多久都不会被回收；
 * 4. 若在 `T_ack` 内没有任何确认到达（客户端崩溃、请求被 abort、网络丢失），
 *    Host 必须**主动**回收：不等待"下一次业务请求"顺带清理，而是由租约注册表的
 *    定时 sweep（或读取时惰性 sweep）触发，最后稳定状态不得留下 `running` 租约。
 *
 * 【上限与判据】
 * - `LEASE_ACK_WINDOW_MS` 是**唯一**的未确认窗口，任何实现不得自行放宽；
 * - 客户端已 `abandonRuntime` 的实例立即回收（快路径），不必等满窗口；
 * - 回收只能**封存并清理**该租约：不得让旧 `runtimeToken` 复活，
 *   不得让新一代次回退，不得改写 SQLite 里已落盘的 revision。
 */
export const LEASE_ACK_WINDOW_MS = 3000

/** 回收原因码（Host 内部审计用，不等于 wire 错误码）。 */
export const LEASE_RECLAIM_REASONS = ['abandoned', 'unconfirmed-timeout', 'closed'] as const

export type LeaseReclaimReason = (typeof LEASE_RECLAIM_REASONS)[number]

/**
 * `abandonRuntime` 入参。**必须同时出示** `launchToken` 与 `runtimeInstanceId`：
 * Host 用两值交叉校验"调用者就是这次启动的发起者"，
 * 只给出 `gameId`/`saveId` 的调用一律拒绝，不能撤销别人的实例。
 */
export interface AbandonRuntimeRequest {
  /** 本次启动由 Client 生成的不可猜令牌（与握手中同一个值）。 */
  launchToken: string
  /** 本次启动的运行实例标识（与握手中同一个值）。 */
  runtimeInstanceId: string
}

export type AbandonRuntimeResult =
  | { ok: true; abandoned: true; reclaimed: boolean }
  | { ok: false; errorCode: 'PROTOCOL_INVALID' | 'ABANDON_FORBIDDEN' | 'INTERNAL'; message: string }

/** `launchToken` 形状：32~256 位可见 ASCII，禁止空白与控制字符（避免日志注入）。 */
export function isLaunchTokenShapeValid(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 32 && token.length <= 256 && /^[\x21-\x7e]+$/.test(token)
}

/** 校验 `abandonRuntime` 入参形状；身份是否匹配由 Host 交叉校验判定，不在协议层。 */
export function validateAbandonRuntimeRequest(input: unknown): WireViolationLike[] {
  const violations: WireViolationLike[] = []
  if (typeof input !== 'object' || input === null) {
    return [{ field: '*', reason: '入参必须是对象' }]
  }
  const raw = input as Record<string, unknown>
  if (!isLaunchTokenShapeValid(raw.launchToken)) {
    violations.push({
      field: 'launchToken',
      reason: 'launchToken 必须是 32~256 位无空白可见 ASCII 的不可猜随机值',
    })
  }
  if (typeof raw.runtimeInstanceId !== 'string' || raw.runtimeInstanceId.length === 0 || raw.runtimeInstanceId.length > 128) {
    violations.push({ field: 'runtimeInstanceId', reason: 'runtimeInstanceId 必须是 1~128 字符的非空字符串' })
  }
  return violations
}

/** 与 `wiring.ts` 的 `WireViolation` 同形（避免两文件循环引用，这里单独声明）。 */
export interface WireViolationLike {
  field: string
  reason: string
}

/**
 * 规范化大小估计：以 JSON 序列化后的 UTF-8 字节数为准。
 * 用于 BRIDGE_MAX_MESSAGE_BYTES 校验（浏览器端用 TextEncoder 实现同义函数）。
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}
