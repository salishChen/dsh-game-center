/**
 * 直连优先的 HTTP fetcher（后台目录 / 审批校验 / 产物下载共用）。
 *
 * ## 为什么需要它（真实故障，2026-10-28 定位）
 *
 * Node 24 在 `NODE_USE_ENV_PROXY=1` 时会自动给全局 `fetch` 套上 `EnvHttpProxyAgent`，
 * 把 `HTTP_PROXY` / `HTTPS_PROXY` 里的代理应用到**每一个**请求上。而 `NO_PROXY` 的惯例写法
 * 里常有 CIDR（`192.168.0.0/16`、`10.0.0.0/8`），undici 并不解析 CIDR，只认精确主机名
 * 与域名后缀 —— 于是"内网本来就不该走代理"的意图静默落空。
 *
 * 后果不是报"连不上"，而是先变成 `TypeError: fetch failed`（cause:
 * `connect ECONNREFUSED 127.0.0.1:7080`，本机代理没开），再被安装链路里的
 * `catch { console.warn(...) }` 吞掉，最后以「未找到…审批记录」(`UNAPPROVED_RELEASE`)
 * 呈现给用户 —— **网络故障被伪装成"没审批"**，排查方向直接被带偏。
 *
 * ## 策略
 *
 * 1. **先直连**：用 `node:http` / `node:https` 发请求。这两个模块根本不读代理环境变量，
 *    所以 LAN 后台（`http://192.168.x.x:18080`）永远直连，跟代理开没开无关。
 * 2. **直连失败（网络类错误）才回退**：用全局 `fetch` 再试一次 —— 那条会走环境代理，
 *    照顾"确实只能靠代理出网"的机器（例如后台在公网、公司网强制代理）。
 * 3. 两次都失败时，抛出**以直连错误为 cause** 的合并错误，message 里带上两次的错误文本，
 *    调用方一眼能看出是哪两段路都不通。
 *
 * 只实现 GET：本插件对后台与制品仓库全部是只读拉取，没有 POST/PUT 的需求，
 * 少一条路径就少一处能绕过代理策略的口子。
 */
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { HttpFetcher } from '@dsh-gamecenter/catalog'

/** 单次请求（含重定向链里的每一跳）的超时。 */
const DEFAULT_TIMEOUT_MS = 15_000
/** 最多跟随的重定向跳数。 */
const MAX_REDIRECTS = 3
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 视为"直连这条路不通、值得回退代理"的错误码。 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EADDRNOTAVAIL',
])

export interface ResilientFetcherOptions {
  /** 单次请求超时（毫秒），默认 15s。 */
  timeoutMs?: number | undefined
  /** 回退通道；默认全局 `fetch`（会套环境代理）。测试可注入。 */
  proxyFetch?: HttpFetcher | undefined
}

/** 把 `RequestInit.headers` 的三种形态（Headers / 数组 / 普通对象）收敛成普通对象。 */
function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (typeof (headers as Headers).forEach === 'function') {
    ;(headers as Headers).forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const pair of headers as readonly (readonly [string, string])[]) {
      const key = pair[0]
      const value = pair[1]
      if (typeof key === 'string' && typeof value === 'string') out[key] = value
    }
    return out
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key] = String(value)
  }
  return out
}

/** 把 node 的原始响应头搬进标准 `Headers`（可多值）。 */
function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

/** 单个 HTTP 响应收成标准 `Response`（body 已验证整块进内存，调用方直接 `.json()`）。 */
function toResponse(
  status: number,
  rawHeaders: Record<string, string | string[] | undefined>,
  chunks: readonly Uint8Array[],
): Response {
  // `Response` 构造器禁止 204/205/304 携带 body，这些状态码按空体返回。
  const bodyAllowed = !(status === 204 || status === 205 || status === 304)
  return new Response(bodyAllowed ? Buffer.concat(chunks) : null, {
    status,
    headers: toHeaders(rawHeaders),
  })
}

/**
 * 用 `node:http`/`node:https` 发一次 GET，**完全不读代理环境变量**。
 * 15 秒没有响应就 `destroy()` 并以带 `ETIMEDOUT` code 的错误 reject。
 */
function sendOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const isHttps = target.protocol === 'https:'
    if (!isHttps && target.protocol !== 'http:') {
      reject(new Error(`direct-http 只支持 http/https：${url}`))
      return
    }
    const send = isHttps ? httpsRequest : httpRequest
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: headerRecord(init.headers),
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0
        const chunks: Uint8Array[] = []
        response.on('data', (chunk) => {
          chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            resolve(toResponse(status, response.headers, chunks))
          } catch (err) {
            reject(err)
          }
        })
        response.on('error', reject)
      },
    )
    request.setTimeout(timeoutMs, () => {
      const err = new Error(`直连超时：${timeoutMs}ms 内没有响应（${url}）`)
      ;(err as { code?: string }).code = 'ETIMEDOUT'
      request.destroy(err)
    })
    request.on('error', reject)
    request.end()
  })
}

/** 跟随最多 `hops` 次重定向；相对 `location` 按当前 URL 解析。 */
async function requestFollowingRedirects(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  hops: number,
): Promise<Response> {
  const response = await sendOnce(url, init, timeoutMs)
  if (!REDIRECT_STATUS.has(response.status)) return response
  const location = response.headers.get('location')
  if (!location || hops <= 0) return response
  const next = new URL(location, url).toString()
  return requestFollowingRedirects(next, init, timeoutMs, hops - 1)
}

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 是否属于"这条路不通"的网络类错误（只有这类才值得回退到代理通道）。 */
function looksLikeNetworkFailure(err: unknown): boolean {
  const code = errorCodeOf(err)
  if (code && NETWORK_ERROR_CODES.has(code)) return true
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|timed\s?out/i.test(
    text,
  )
}

/**
 * 把任意错误铺成一行可读文本（含 `cause` 的 code 与 message）。
 * 安装链路把这段文本直接放进给用户看的 message 里。
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = errorCodeOf(cause)
    return `${err.message}（cause: ${code ? `${code} ` : ''}${cause.message}）`
  }
  return err.message
}

/**
 * 创建直连优先的 fetcher。
 *
 * @returns `(url, init) => Promise<Response>`；非 GET 一律立刻抛错。
 */
export function createResilientFetcher(options: ResilientFetcherOptions = {}): HttpFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const proxyFetch: HttpFetcher =
    options.proxyFetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      throw new Error(
        `direct-http 只实现 GET（收到 ${method}）：本插件对后台与制品仓库全部是只读拉取，没有写接口`,
      )
    }

    let directFailure: unknown
    try {
      return await requestFollowingRedirects(url, init, timeoutMs, MAX_REDIRECTS)
    } catch (err) {
      directFailure = err
      if (!looksLikeNetworkFailure(err)) throw err
    }

    try {
      return await proxyFetch(url, init)
    } catch (proxyFailure) {
      const merged = new Error(
        `直连失败：${describeFetchError(directFailure)}；回退 fetch 也失败：${describeFetchError(proxyFailure)}`,
      )
      ;(merged as { cause?: unknown }).cause = directFailure
      throw merged
    }
  }
}
