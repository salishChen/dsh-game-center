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
 * 2. **按主机分流，不是全局固定优先级**（2026-10-30 实测修正）：
 *    - **内网/回环主机**（LAN 后台、`127.0.0.1`、`10/8`、`172.16/12`、`192.168/16`、`.local`）→
 *      **只走直连**。代理在那条路上没有意义（代理出不去内网），回退只会多花时间。
 *    - **公网主机**（`raw.githubusercontent.com` 等）且进程环境里确实有代理 →
 *      **代理优先**。实测同一台机器：经代理 14 MB / 2.8 s（≈5 MB/s），直连 15 s 拿不到首字节。
 *      原来的"直连优先"在受限网络里等于每个文件先白扔一个空闲超时再回退。
 *    - 公网且没有代理变量 → 直连优先（原行为）。
 * 3. 回退那一路使用**更短的空闲超时**（`FALLBACK_IDLE_MS`），因为它是"备用路"，
 *    不该把主路的预算耗光。
 * 4. 两次都失败时，抛出**以主路错误为 cause** 的合并错误，message 里带上两次的错误文本，
 *    调用方一眼能看出是哪两段路都不通。
 *
 * 只实现 GET：本插件对后台与制品仓库全部是只读拉取，没有 POST/PUT 的需求，
 * 少一条路径就少一处能绕过代理策略的口子。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
/** 单次请求（含重定向链里的每一跳）的超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 回退那一路的空闲超时：它是备用路，不该耗光主路的预算。 */
const FALLBACK_IDLE_MS = 5_000;
/** 最多跟随的重定向跳数。 */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
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
]);
/** 把 `RequestInit.headers` 的三种形态（Headers / 数组 / 普通对象）收敛成普通对象。 */
function headerRecord(headers) {
    const out = {};
    if (!headers)
        return out;
    if (typeof headers.forEach === 'function') {
        ;
        headers.forEach((value, key) => {
            out[key] = value;
        });
        return out;
    }
    if (Array.isArray(headers)) {
        for (const pair of headers) {
            const key = pair[0];
            const value = pair[1];
            if (typeof key === 'string' && typeof value === 'string')
                out[key] = value;
        }
        return out;
    }
    for (const [key, value] of Object.entries(headers)) {
        out[key] = String(value);
    }
    return out;
}
/** 把 node 的原始响应头搬进标准 `Headers`（可多值）。 */
function toHeaders(raw) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(raw)) {
        if (value === undefined)
            continue;
        if (Array.isArray(value)) {
            for (const item of value)
                headers.append(key, item);
        }
        else {
            headers.set(key, value);
        }
    }
    return headers;
}
/** 单个 HTTP 响应收成标准 `Response`（body 已验证整块进内存，调用方直接 `.json()`）。 */
function toResponse(status, rawHeaders, chunks) {
    // `Response` 构造器禁止 204/205/304 携带 body，这些状态码按空体返回。
    const bodyAllowed = !(status === 204 || status === 205 || status === 304);
    return new Response(bodyAllowed ? Buffer.concat(chunks) : null, {
        status,
        headers: toHeaders(rawHeaders),
    });
}
/** 把 `AbortSignal` 的取消原因包成 `AbortError`（调用方按 name 判定"是被取消，不是网络坏"）。 */
function abortError(signal) {
    const reason = signal.reason;
    const detail = reason instanceof Error ? reason.message : reason === undefined ? 'aborted' : String(reason);
    const err = new Error(`请求已取消：${detail}`);
    err.name = 'AbortError';
    return err;
}
/**
 * 用 `node:http`/`node:https` 发一次 GET，**完全不读代理环境变量**。
 *
 * 超时语义是**空闲**：`request.setTimeout` 挂在 socket 上，只要还有数据到达就会重置，
 * 因此"慢但持续"的下载不会被误杀，只有真的卡住（`timeoutMs` 内一个字节都没有）才
 * `destroy()` 并以带 `ETIMEDOUT` code 的错误 reject —— 这对 14 MB 的 `dist/game.js`
 * 是必需语义，按总时长掐会把"慢链路"和"断链"混成一件事。
 *
 * 同时尊重 `init.signal`：调用方的取消会真正 `destroy()` 掉 socket。
 * 之前这里完全没处理 signal，外层 15s 总预算 abort 之后请求还在后台跑，
 * 返回值却已经是"超时"，既误导排查又漏 socket。
 */
function sendOnce(url, init, timeoutMs) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        }
        catch (err) {
            reject(err);
            return;
        }
        const isHttps = target.protocol === 'https:';
        if (!isHttps && target.protocol !== 'http:') {
            reject(new Error(`direct-http 只支持 http/https：${url}`));
            return;
        }
        const signal = init.signal ?? undefined;
        if (signal?.aborted === true) {
            reject(abortError(signal));
            return;
        }
        const send = isHttps ? httpsRequest : httpRequest;
        let settled = false;
        // 失败要能自证"卡在哪一步"：没连上 / 没等到首字节 / 传到一半断，三种处置完全不同。
        let phase = 'connect';
        let resolvedIp;
        const tag = (err) => {
            if (typeof err !== 'object' || err === null)
                return;
            err.phase = phase;
            if (resolvedIp !== undefined)
                err.resolvedIp = resolvedIp;
        };
        const settle = (fn) => {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            fn();
        };
        const onAbort = () => {
            const err = abortError(signal);
            settle(() => reject(err));
            request.destroy(err);
        };
        const request = send({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: headerRecord(init.headers),
        }, (response) => {
            phase = 'headers';
            const status = response.statusCode ?? 0;
            const chunks = [];
            response.on('data', (chunk) => {
                phase = 'body';
                chunks.push(chunk);
            });
            response.on('end', () => {
                settle(() => {
                    try {
                        resolve(toResponse(status, response.headers, chunks));
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
            response.on('error', (err) => {
                tag(err);
                settle(() => reject(err));
            });
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        // 手写的 node:http 环境声明里没有 'socket' 这个重载，这里按结构类型挂一次即可。
        const socketTarget = request;
        socketTarget.on('socket', (socket) => {
            const record = socket;
            const capture = () => {
                if (typeof record.remoteAddress === 'string' && record.remoteAddress !== '') {
                    resolvedIp = record.remoteAddress;
                }
            };
            capture();
            record.once?.('connect', capture);
        });
        request.setTimeout(timeoutMs, () => {
            const err = new Error(`直连空闲超时：${timeoutMs}ms 内没有任何数据（${url}）`);
            err.code = 'ETIMEDOUT';
            tag(err);
            request.destroy(err);
        });
        request.on('error', (err) => {
            tag(err);
            settle(() => reject(err));
        });
        request.end();
    });
}
/** 跟随最多 `hops` 次重定向；相对 `location` 按当前 URL 解析。 */
async function requestFollowingRedirects(url, init, timeoutMs, hops) {
    const response = await sendOnce(url, init, timeoutMs);
    if (!REDIRECT_STATUS.has(response.status))
        return response;
    const location = response.headers.get('location');
    if (!location || hops <= 0)
        return response;
    const next = new URL(location, url).toString();
    return requestFollowingRedirects(next, init, timeoutMs, hops - 1);
}
function errorCodeOf(err) {
    if (typeof err !== 'object' || err === null)
        return undefined;
    const code = err.code;
    return typeof code === 'string' ? code : undefined;
}
/** 是否属于"这条路不通"的网络类错误（只有这类才值得回退到另一条通道）。 */
function looksLikeNetworkFailure(err) {
    const code = errorCodeOf(err);
    if (code && NETWORK_ERROR_CODES.has(code))
        return true;
    // 全局 fetch 只抛 `TypeError: fetch failed`，真正的原因在 `cause` 里。
    if (typeof err === 'object' && err !== null) {
        const cause = err.cause;
        const causeCode = errorCodeOf(cause);
        if (causeCode && NETWORK_ERROR_CODES.has(causeCode))
            return true;
    }
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|EADDRNOTAVAIL|socket hang up|timed\s?out|fetch failed/i.test(text);
}
/** 进程环境里配置的代理地址（原样返回，用于错误指纹；没有则空串）。 */
function envProxyValue() {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
        const value = process.env[name];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return '';
}
/** 代理的"可归因描述"：变量设了不等于生效，`NODE_USE_ENV_PROXY` 关掉时 undici 直接忽略它。 */
function describeProxy() {
    const value = envProxyValue();
    if (value === '')
        return 'off(no-env)';
    const applies = process.env.NODE_USE_ENV_PROXY;
    if (applies !== undefined && applies !== '' && applies !== '0' && applies !== 'false') {
        return `on(${value}, src=env)`;
    }
    return `on(${value}, src=env)`;
}
function isTimeoutLike(err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return /ETIMEDOUT|timed?\s?out|TimeoutError|空闲超时/i.test(text);
}
function phaseOf(err) {
    const tagged = err?.phase;
    if (tagged === 'connect' || tagged === 'headers' || tagged === 'body' || tagged === 'verify')
        return tagged;
    return 'unknown';
}
function ipOf(err) {
    const tagged = err?.resolvedIp;
    return typeof tagged === 'string' && tagged !== '' ? tagged : undefined;
}
/**
 * `attempts[].cause` 的取值规则（§11.8）：**永远非空**。
 * `phase` 落到 `unknown` 时，必须写明"为什么观测不到"，否则空 cause 的 unknown
 * 在聚合上与"根本没采集"无法区分。
 */
function describeAttemptCause(err) {
    const base = describeFetchError(err).trim();
    const text = base === '' ? '不明错误（错误对象没有可读文本）' : base;
    if (phaseOf(err) !== 'unknown')
        return text;
    const cause = err?.cause;
    if (errorCodeOf(cause) !== undefined)
        return text;
    return `${text}（无 cause code：拿不到可观测阶段，标 unknown 而非猜 headers）`;
}
/** 组装传输失败。**结构化字段在对象上，不在 message 里**（§11.8）：message 只留一行给人看，
 * `attempts` 才能按 route/phase 分组统计（"代理挂得多"与"两边都挂"处置完全不同）。
 */
function buildTransportFailure(url, summary, proxyDescriptor, attempts, elapsedMs) {
    let host = '';
    let path = '';
    try {
        const parsed = new URL(url);
        host = parsed.hostname;
        path = `${parsed.pathname}${parsed.search}`;
    }
    catch {
        host = url;
    }
    // 只要有一路不是"超时"，就按不可达报 —— 超时是可重试的，不可达通常要改配置。
    const code = attempts.every((item) => isTimeoutLike(item.cause))
        ? 'UPSTREAM_TIMEOUT'
        : 'UPSTREAM_UNREACHABLE';
    const err = new Error(`${code}: ${summary}（${host}，${elapsedMs}ms，proxy=${proxyDescriptor}）`);
    err.code = code;
    err.host = host;
    err.path = path;
    err.proxy = proxyDescriptor;
    err.elapsedMs = elapsedMs;
    err.attempts = attempts;
    return err;
}
/** 进程环境里是否配置了可用的代理（决定公网主机走哪条优先）。 */
function hasEnvProxy() {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
        const value = process.env[name];
        if (typeof value === 'string' && value.trim() !== '')
            return true;
    }
    return false;
}
/**
 * 是否本机/内网主机 —— 这类主机只有直连有意义。
 *
 * `NO_PROXY` 里的 CIDR 写法（`192.168.0.0/16`）undici **不解析**，只认精确主机与域名后缀，
 * 所以"内网不该走代理"这件事必须在代码里判，不能指望环境变量。
 */
export function isInternalHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost'))
        return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1')
        return true;
    // IPv6 链路本地(fe80::/10) 与唯一本地地址(fc00::/7) 同样是"本机/内网"
    if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host))
        return true;
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan'))
        return true;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!ipv4)
        return false;
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10 || a === 0)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    // 链路本地 / CGNAT
    if (a === 169 && b === 254)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true;
    return false;
}
/**
 * 把任意错误铺成一行可读文本（含 `cause` 的 code 与 message）。
 * 安装链路把这段文本直接放进给用户看的 message 里。
 */
export function describeFetchError(err) {
    if (!(err instanceof Error))
        return String(err);
    const cause = err.cause;
    if (cause instanceof Error) {
        const code = errorCodeOf(cause);
        return `${err.message}（cause: ${code ? `${code} ` : ''}${cause.message}）`;
    }
    return err.message;
}
/**
 * 创建按主机分流的 fetcher。
 *
 * - 内网/回环主机：只直连（代理连不到内网，回退纯属浪费）。
 * - 公网主机 + 进程环境里有代理：代理优先，失败才直连（受限网络里这才是快路）。
 * - 公网主机 + 没有代理：直连优先，失败才回退 `proxyFetch`（原行为）。
 *
 * @returns `(url, init) => Promise<Response>`；非 GET 一律立刻抛错。
 */
export function createResilientFetcher(options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fallbackTimeoutMs = Math.min(timeoutMs, FALLBACK_IDLE_MS);
    const proxyFetch = options.proxyFetch ?? ((url, init) => fetch(url, init));
    return async (url, init = {}) => {
        const method = (init.method ?? 'GET').toUpperCase();
        if (method !== 'GET') {
            throw new Error(`direct-http 只实现 GET（收到 ${method}）：本插件对后台与制品仓库全部是只读拉取，没有写接口`);
        }
        let hostname = '';
        try {
            hostname = new URL(url).hostname;
        }
        catch {
            // URL 解析失败交给直连通道去报具体错误。
        }
        const internal = hostname !== '' && isInternalHost(hostname);
        const proxyFirst = !internal && hasEnvProxy();
        const direct = (timeout) => requestFollowingRedirects(url, init, timeout, MAX_REDIRECTS);
        const startedAt = Date.now();
        const proxyDescriptor = describeProxy();
        if (!proxyFirst) {
            let directFailure;
            const directStartedAt = Date.now();
            try {
                return await direct(timeoutMs);
            }
            catch (err) {
                directFailure = err;
                if (!looksLikeNetworkFailure(err))
                    throw err;
            }
            const directAttempt = {
                route: 'direct',
                phase: phaseOf(directFailure),
                cause: describeAttemptCause(directFailure),
                elapsedMs: Date.now() - directStartedAt,
            };
            const directIp = ipOf(directFailure);
            if (directIp !== undefined)
                directAttempt.resolvedIp = directIp;
            // 内网主机走到这里说明直连不通。仍做一次代理回退：既能覆盖"代理能桥到内网"
            // 的异常拓扑，也能把两条路的错误一起留证（排查时比只看到一个 ECONNREFUSED 有用）。
            const proxyStartedAt = Date.now();
            try {
                return await proxyFetch(url, init);
            }
            catch (proxyFailure) {
                throw buildTransportFailure(url, `${directAttempt.cause}；回退 fetch 也失败`, proxyDescriptor, [
                    directAttempt,
                    {
                        route: 'proxy',
                        proxy: proxyDescriptor,
                        phase: phaseOf(proxyFailure),
                        cause: describeAttemptCause(proxyFailure),
                        elapsedMs: Date.now() - proxyStartedAt,
                    },
                ], Date.now() - startedAt);
            }
        }
        let proxyFailure;
        const proxyStartedAt = Date.now();
        try {
            return await proxyFetch(url, init);
        }
        catch (err) {
            proxyFailure = err;
            if (!looksLikeNetworkFailure(err))
                throw err;
        }
        const proxyAttempt = {
            route: 'proxy',
            proxy: proxyDescriptor,
            phase: phaseOf(proxyFailure),
            cause: describeAttemptCause(proxyFailure),
            elapsedMs: Date.now() - proxyStartedAt,
        };
        const directStartedAt = Date.now();
        try {
            return await direct(fallbackTimeoutMs);
        }
        catch (directFailure) {
            const directAttempt = {
                route: 'direct',
                phase: phaseOf(directFailure),
                cause: describeAttemptCause(directFailure),
                elapsedMs: Date.now() - directStartedAt,
            };
            const directIp = ipOf(directFailure);
            if (directIp !== undefined)
                directAttempt.resolvedIp = directIp;
            throw buildTransportFailure(url, `${proxyAttempt.cause}；回退直连也失败`, proxyDescriptor, [proxyAttempt, directAttempt], Date.now() - startedAt);
        }
    };
}
//# sourceMappingURL=direct-http.js.map