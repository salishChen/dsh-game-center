import type { HttpFetcher } from '@dsh-gamecenter/catalog';
export interface ResilientFetcherOptions {
    /** 单次请求超时（毫秒），默认 15s。 */
    timeoutMs?: number | undefined;
    /** 回退通道；默认全局 `fetch`（会套环境代理）。测试可注入。 */
    proxyFetch?: HttpFetcher | undefined;
}
/** 失败发生在哪一步 —— 空等 14 秒与连不上是两种处置。 */
export type TransportPhase = 'connect' | 'headers' | 'body' | 'verify' | 'unknown';
export type TransportAttempt = {
    /** 稳定枚举（§11.8）：说法不统一就没法按路分组统计 */
    route: 'direct' | 'proxy' | 'mirror';
    /** 只有 proxy 这一路带：实际用的代理 host:port，或 off(...) 的原因 */
    proxy?: string;
    phase: TransportPhase;
    cause: string;
    elapsedMs: number;
    /** 只有直连这一路能拿到：TCP 层解析/连接到的 IP */
    resolvedIp?: string;
};
export type TransportFailure = Error & {
    code: 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNREACHABLE';
    host: string;
    path: string;
    proxy: string;
    elapsedMs: number;
    attempts: TransportAttempt[];
    /** 成功那一路；只有失败对象，所以恒为空，保留给调用方回填（服务层知道走通了哪条） */
    winnerRoute?: TransportAttempt['route'];
};
/**
 * 是否本机/内网主机 —— 这类主机只有直连有意义。
 *
 * `NO_PROXY` 里的 CIDR 写法（`192.168.0.0/16`）undici **不解析**，只认精确主机与域名后缀，
 * 所以"内网不该走代理"这件事必须在代码里判，不能指望环境变量。
 */
export declare function isInternalHost(hostname: string): boolean;
/**
 * 把任意错误铺成一行可读文本（含 `cause` 的 code 与 message）。
 * 安装链路把这段文本直接放进给用户看的 message 里。
 */
export declare function describeFetchError(err: unknown): string;
/**
 * 创建按主机分流的 fetcher。
 *
 * - 内网/回环主机：只直连（代理连不到内网，回退纯属浪费）。
 * - 公网主机 + 进程环境里有代理：代理优先，失败才直连（受限网络里这才是快路）。
 * - 公网主机 + 没有代理：直连优先，失败才回退 `proxyFetch`（原行为）。
 *
 * @returns `(url, init) => Promise<Response>`；非 GET 一律立刻抛错。
 */
export declare function createResilientFetcher(options?: ResilientFetcherOptions): HttpFetcher;
