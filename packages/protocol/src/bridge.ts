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
 * 握手载荷。沙箱下 iframe origin 可能是 `null`，
 * 因此不能仅通过 event.origin 认证：必须校验确定的 event.source、一次性 nonce 和运行实例，
 * 再建立专用 MessagePort。
 */
export interface HandshakeRequest {
  runtimeInstanceId: string
  nonce: string
  /** 游戏自报 id 与版本，仅作交叉校验；权威值来自 Host 已安装版本。 */
  gameId: string
  gameVersion: string
  sdkVersion: string
  bridgeVersion: 1
}

export interface HandshakeResponse {
  ok: boolean
  /** 成功时下发的一次性运行凭证；只对本运行代次有效，关闭后失效。 */
  runtimeToken?: string
  generation?: number
  /** 宿主判定为不可运行时的原因码。 */
  errorCode?: string
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
