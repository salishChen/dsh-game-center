/**
 * DSH Host 上下文的**最小结构类型**与运行时适配层。
 *
 * 为什么不用 `any` 也不用 DSH 的 .d.ts：
 * - 本包不 vendor DSH 类型包（安装目录只读，且版本 nightly，类型会漂移）；
 * - 但用 `any` 会让 `@Remote` 装饰器签名、`ctx.typertGateway` 拼写错误在编译期静默通过，
 *   阶段0 必须能靠 `tsc` 捕获拼写/签名错误。
 *
 * 因此这里只声明**本包实际用到的成员**，每个成员都标注了实装源码出处（0.2.1-rc.2 /
 * build 332895e0f7c9d4dbfb29729f5eb367fa263ff986）。任何超出本文件的 DSH 能力
 * 都视为「未核实」，不得在业务代码里直接调用。
 */

/** 可同步清理资源的最小 Context（Cordis）。 */
export interface MinimalContext {
  /**
   * Cordis effect：注册清理函数。同步回调返回同步 disposer。
   * 出处：`@deepseek-ai/cordis`（本包只用到同步形态）。
   */
  effect(execute: () => (() => void) | void, label?: string): unknown;
}

/**
 * `@deepseek-ai/dsh-typert-protocol` 的 `TypertRemoteService` 实例面。
 * 出处：`dsh-typert-protocol/lib/index.js` `class TypertRemoteService extends Service`，
 * 构造函数 `super(ctx, serviceKey)` + `this.typertRemote = bindTypertRemote(...)`。
 */
export interface TypertRemoteServiceLike extends MinimalContext {
  readonly name: string
  readonly ctx: unknown
  readonly typertRemote: {
    readonly service: unknown
    readonly serviceKey: string
    readonly namespace: string
  } | undefined
}

/**
 * Host 侧 `@Remote` 标记读取函数。
 * 出处：`dsh-typert-protocol/lib/index.js` `remoteMethods(service)`，
 * 返回 `{ method, exportName?, mode?, resources? }[]` 的**副本**。
 */
export interface RemoteMarker {
  readonly method: string
  readonly exportName?: string
  readonly mode?: 'stream'
}

export interface TypertProtocolLike {
  Remote: unknown
  TypertRemoteService: unknown
  remoteMethods: (service: unknown) => RemoteMarker[]
}

/** 真实的 @deepseek-ai/dsh-typert-protocol 模块，未知时保持 undefined。 */
export interface TypertProtocolLoader {
  /** 返回协议模块；加载失败返回 null（不抛，便于探针如实报告）。 */
  load(): TypertProtocolLike | null
}

/**
 * `ctx.typertGateway`（`TypertGatewayService`）本包用到的成员。
 * 出处：`dsh-api-gateway/lib/index.js` `var TypertGatewayService = class extends Service`
 * （`super(ctx, "typertGateway")`，`static inject = ["typert", "remoteAccess"]`）。
 *
 * 注意：本包**不直接调用** gateway；服务通过 `TypertRemoteService` 绑定后由 Gateway
 * 自行发现。这里保留类型只用于探针断言「Gateway 是否已激活」。
 */
export interface TypertGatewayLike {
  readonly name: string
}

/**
 * DSH `ctx.llm` 的本包最小子集（只读模型目录）。
 * 出处：设计基线 §1 已核实的 `listProviders()` / `listModels(provider)` /
 * `resolveModelInfo(provider, model)`；**本会话未执行真实调用**（付费/无需付费都未调用），
 * 因此这里只声明形状，实际可用性为 `AUTH-PENDING`。
 */
export interface DshLlmLike {
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<any>
  prepareCall?(config: { provider: string; model: string; reasoningEffort?: string }, signal?: AbortSignal): Promise<{ config: any; stream(options: any): AsyncIterable<any> }>
  listProviders(): Promise<unknown[]>
  listModels(provider: string): Promise<unknown[]>
}

export function isMinimalContext(value: unknown): value is MinimalContext {
  return typeof value === 'object' && value !== null && typeof (value as MinimalContext).effect === 'function'
}

export function isTypertGatewayLike(value: unknown): value is TypertGatewayLike {
  return typeof value === 'object' && value !== null && (value as TypertGatewayLike).name === 'typertGateway'
}

/**
 * 判断一个值是否是 `TypertRemoteService` 实例（结构化判断，不用 instanceof，
 * 避免跨副本类身份问题 —— DSH 自身也采用结构化判别）。
 */
export function isTypertRemoteServiceLike(value: unknown): value is TypertRemoteServiceLike {
  if (typeof value !== 'object' || value === null) return false
  const binding = (value as TypertRemoteServiceLike).typertRemote
  return typeof binding === 'object' && binding !== null && typeof binding.namespace === 'string'
}
