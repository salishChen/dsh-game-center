/**
 * 最小化 `node:http` / `node:https` 环境声明。
 *
 * 本仓库不引入 `@types/node`（tsconfig 里 `types: []`），各 node 内置模块都在
 * `src/types/*.d.ts` 里按需手写最小面。这里只声明 `remote/direct-http.ts` 用到的部分：
 * 发起 GET、设置超时、销毁请求、按块收 body、读状态码与响应头。
 */
declare module 'node:http' {
  export interface IncomingHttpHeaders {
    [key: string]: string | string[] | undefined
  }

  export interface IncomingMessage {
    statusCode?: number | undefined
    headers: IncomingHttpHeaders
    on(event: 'data', listener: (chunk: Uint8Array) => void): this
    on(event: 'end', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    resume(): void
  }

  export interface RequestOptions {
    protocol?: string | undefined
    hostname?: string | undefined
    port?: number | string | undefined
    path?: string | undefined
    method?: string | undefined
    headers?: Record<string, string> | undefined
  }

  export interface ClientRequest {
    setTimeout(milliseconds: number, callback: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'timeout', listener: () => void): this
    end(callback?: () => void): void
    destroy(error?: Error): void
  }

  export function request(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest
}

declare module 'node:https' {
  import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'

  export function request(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest
}
