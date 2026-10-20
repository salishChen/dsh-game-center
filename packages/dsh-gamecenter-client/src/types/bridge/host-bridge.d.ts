/** UTF-8 字节数（浏览器无 Buffer，用 TextEncoder；与协议包 utf8ByteLength 等价）。 */
/** @param {string} text @returns {number} */
export function utf8ByteLength(text: string): number;
/** @typedef {{[key: string]: unknown}} JsonRecord */
/**
 * @typedef {object} HandshakeExpectation
 * @property {unknown} window 本运行实例的 iframe 的 contentWindow
 * @property {string} runtimeInstanceId
 * @property {string} nonce 一次性握手 nonce
 * @property {number} generation
 */
/**
 * @typedef {object} HandshakeRejection
 * @property {false} ok
 * @property {string} code
 * @property {string} message
 */
/**
 * 校验一次握手引导消息。
 *
 * @param {{data: unknown, source: unknown, expected: HandshakeExpectation}} args
 * @returns {{ok: true, generation: number} | HandshakeRejection}
 */
export function verifyHandshake({ data, source, expected }: {
    data: unknown;
    source: unknown;
    expected: HandshakeExpectation;
}): {
    ok: true;
    generation: number;
} | HandshakeRejection;
/**
 * 创建一个滑动窗口频率限制器（纯内存，随运行实例销毁而丢弃）。
 *
 * @param {{windowMs?: number, max?: number, now?: () => number}} [options]
 * @returns {{tryAcquire: () => boolean, reset: () => void, size: () => number}}
 */
export function createRateLimiter(options?: {
    windowMs?: number;
    max?: number;
    now?: () => number;
}): {
    tryAcquire: () => boolean;
    reset: () => void;
    size: () => number;
};
/**
 * 一个可 JSON 序列化的值（仅用于本模块类型标注，不引入协议包依赖）。
 * 用 interface + 联合成员避免 TS 的自引用类型别名限制。
 * @typedef {null | boolean | number | string | JsonValueArray | JsonValueRecord} JsonValueLike
 * @typedef {JsonValueLike[]} JsonValueArray
 * @typedef {{[key: string]: JsonValueLike}} JsonValueRecord
 */
/**
 * 出站错误信封。
 * @typedef {object} OutboundErrorEnvelope
 * @property {1} bridgeVersion
 * @property {string} requestId
 * @property {false} ok
 * @property {{code: string, message: string, retryable: boolean, currentRevision?: number}} error
 */
/**
 * 出站成功信封。
 * @typedef {object} OutboundOkEnvelope
 * @property {1} bridgeVersion
 * @property {string} requestId
 * @property {true} ok
 * @property {JsonValueLike} payload
 */
/**
 * 校验 Bridge 入站信封。返回规范化后的对象或错误码，绝不抛异常给调用方。
 *
 * @param {unknown} raw
 * @returns {{ok: true, requestId: string, method: string, payload: JsonValueLike}
 *   | {ok: false, code: string, message: string}}
 */
export function parseInbound(raw: unknown): {
    ok: true;
    requestId: string;
    method: string;
    payload: JsonValueLike;
} | {
    ok: false;
    code: string;
    message: string;
};
/**
 * 构造出站错误信封（游戏可安全读取：不含凭据、不含栈、不含内部路径）。
 *
 * @param {string} requestId
 * @param {{code: string, message: string, retryable?: boolean, currentRevision?: number}} error
 * @returns {OutboundErrorEnvelope}
 */
export function outboundError(requestId: string, error: {
    code: string;
    message: string;
    retryable?: boolean;
    currentRevision?: number;
}): OutboundErrorEnvelope;
/**
 * 构造出站成功信封。payload 必须已是 JSON。
 *
 * @param {string} requestId
 * @param {JsonValueLike} payload
 * @returns {OutboundOkEnvelope}
 */
export function outboundOk(requestId: string, payload: JsonValueLike): OutboundOkEnvelope;
/**
 * 生成一次性 nonce（浏览器与测试都可用）。
 * @returns {string} 48 位十六进制字符串
 */
export function createNonce(): string;
/**
 * 生成本次启动的 `launchToken`（协议 2026-10-20 冻结，`abandonRuntime` 必填入参）。
 *
 * 【为什么与 `createNonce()` 分开】两者都走同一个 CSPRNG 守卫，但用途与形状不同：
 * nonce 是 iframe 握手配对的一次性凭证依据；launchToken 是"我是这次启动的发起者"
 * 的身份依据，`abandonRuntime` 靠它做交叉校验——可猜就意味着别人能撤销我们的实例。
 * 无 CSPRNG 时两者都直接抛错，绝不静默降级到 `Math.random()`。
 *
 * 形状约束来自协议 `isLaunchTokenShapeValid()`：32~256 位**可见 ASCII**、无空白与控制字符。
 * 32 字节转 base64url 得 43 字符（只含 A-Za-z0-9-_），天然满足。
 *
 * 隔离纪律（与 `runtimeToken` 同级）：只在本 Client 进程内存中持有，
 * **绝不**进入游戏 iframe 的 URL/srcdoc、不进日志、不进 UI 文案、不进错误 message。
 *
 * @returns {string} 43 位 base64url 字符串（32 字节熵）
 * @throws {Error} 当运行时没有 CSPRNG（`crypto.getRandomValues`）时
 */
export function createLaunchToken(): string;
/**
 * 专用 MessagePort Bridge 的**Host 侧**（父窗口）校验器（基线 §6、§7）。
 *
 * 【拟新增协议，不是 DSH 既有 API】
 *
 * 安全要点（每一条都对应验收场景「游戏尝试跨存档访问或调用主 DSH API」）：
 * 1. 沙箱 iframe 的 origin 可能是 `null`，**不能**用 `event.origin` 认证；
 *    引导消息必须校验确定的 `event.source`、一次性 nonce 与运行实例 id。
 * 2. 握手成功后立刻 `port.start()` 并只接受该端口上的消息；其他来源的
 *    `postMessage` 一律丢弃。
 * 3. 每条消息做：可 JSON 序列化 → 字节上限 → 方法白名单 → 状态/代次。
 * 4. 频率限制：滑动窗口内超过配额直接拒绝，不排队。
 * 5. 游戏**拿不到**任何 DSH 对象：本模块只接受结构化 JSON，返回值也只回
 *    JSON，绝不把 `ctx`、RPC、DOM 节点或凭据放进消息。
 *
 * 注意：本文件**不 import 协议包**。它跑在浏览器 bundle 里，而浏览器静态外部表
 * 只提供 react/react-dom/cordis/zod/dsh-client-store/dsh-client-ui-* 等固定包名；
 * 引入 workspace 包会在运行时 require 失败。协议常量在此以本地镜像维护，
 * 由 test/bridge-constants.test.mjs 断言与 packages/protocol 同源。
 */
/** 与 packages/protocol 的 BRIDGE_METHODS 同源，禁止在此单方面新增方法。 */
export const BRIDGE_METHODS: readonly string[];
/** 与 packages/protocol 的 BRIDGE_MAX_MESSAGE_BYTES 同源（256 KiB）。 */
export const BRIDGE_MAX_MESSAGE_BYTES: number;
/** 频率窗口（ms）与窗口内允许的请求数。 */
export const RATE_WINDOW_MS: 1000;
export const RATE_MAX_REQUESTS: 20;
/** 握手引导消息的唯一 tag，避免与其他插件的 postMessage 混淆。 */
export const HANDSHAKE_TAG: "dsh-gamecenter:hello";
export type JsonRecord = {
    [key: string]: unknown;
};
export type HandshakeExpectation = {
    /**
     * 本运行实例的 iframe 的 contentWindow
     */
    window: unknown;
    runtimeInstanceId: string;
    /**
     * 一次性握手 nonce
     */
    nonce: string;
    generation: number;
};
export type HandshakeRejection = {
    ok: false;
    code: string;
    message: string;
};
/**
 * 一个可 JSON 序列化的值（仅用于本模块类型标注，不引入协议包依赖）。
 * 用 interface + 联合成员避免 TS 的自引用类型别名限制。
 */
export type JsonValueLike = null | boolean | number | string | JsonValueArray | JsonValueRecord;
/**
 * 一个可 JSON 序列化的值（仅用于本模块类型标注，不引入协议包依赖）。
 * 用 interface + 联合成员避免 TS 的自引用类型别名限制。
 */
export type JsonValueArray = JsonValueLike[];
/**
 * 一个可 JSON 序列化的值（仅用于本模块类型标注，不引入协议包依赖）。
 * 用 interface + 联合成员避免 TS 的自引用类型别名限制。
 */
export type JsonValueRecord = {
    [key: string]: JsonValueLike;
};
/**
 * 出站错误信封。
 */
export type OutboundErrorEnvelope = {
    bridgeVersion: 1;
    requestId: string;
    ok: false;
    error: {
        code: string;
        message: string;
        retryable: boolean;
        currentRevision?: number;
    };
};
/**
 * 出站成功信封。
 */
export type OutboundOkEnvelope = {
    bridgeVersion: 1;
    requestId: string;
    ok: true;
    payload: JsonValueLike;
};
