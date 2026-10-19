/**
 * 构造 `gameCenter` 命名空间的 contribution。
 * 与 `packages/dsh-gamecenter/src/remote/contribution-shape.ts` 语义对齐，
 * 但补齐了 typert 侧 `validateInvocation` 要求的 `id` / `service` / codec 字段。
 * @returns {WireContribution}
 */
export function createGameCenterContribution(): WireContribution;
/**
 * 本地复刻**两道闸门**的形状校验，用于装载前自查。
 *
 * - 网关侧 `requireStrictCodec`：`codec.mode` / `result.mode` 必须 `"strict"`；
 * - typert 侧 `validateInvocation`：`id` / `service` 必填，`result` 与每个参数的
 *   `codec` 过 `validateCodec`（strict 需 `typeSymbol` 非空 + `create` 是函数），
 *   `wire` 不可重复，`cancellation.parameter` 必须 `"signal"`，`mode` 只能是 `"stream"`，
 *   `scope` 只允许 direct 且须选中唯一 lookup 参数。
 *
 * @param {WireContribution} contribution
 * @returns {{endpoint: string, field: string, reason: string}[]} 空数组表示合格
 */
export function validateContributionShape(contribution: WireContribution): {
    endpoint: string;
    field: string;
    reason: string;
}[];
/**
 * 挂载 `gameCenter`。**调用方必须是已注入 `remote` 服务的 Client 插件上下文。**
 *
 * @param {any} ctx Cordis 插件上下文（需有 `ctx.remote.$mount`）
 * @param {{contribution?: WireContribution, logger?: {warn: (m: unknown) => void}}} [options]
 * @returns {Promise<{ok: true, dispose: () => Promise<void>} | {ok: false, code: string, message: string}>}
 */
export function mountGameCenterRemote(ctx: any, options?: {
    contribution?: WireContribution;
    logger?: {
        warn: (m: unknown) => void;
    };
}): Promise<{
    ok: true;
    dispose: () => Promise<void>;
} | {
    ok: false;
    code: string;
    message: string;
}>;
/**
 * 把 Host 的**失败形状**统一成 `{code, message}`，或返回 `null` 表示成功。
 *
 * 【为什么必须分开识别三种形状】
 * 实读 `packages/dsh-gamecenter/src/remote/game-center-service.ts` 的 wire 输出接口，
 * Host 四个方法的失败标记**不统一**：
 *
 * | 方法 | 成功 | 失败 |
 * | --- | --- | --- |
 * | `handshake` | `{ok:true, generation, tokenDigest, state}` | `{ok:false, errorCode, message}` |
 * | `saveAck` | `{accepted:true, state?, lastPersistedRevision?}` | `{accepted:false, error:{code,message}, …}` |
 * | `pause` | `{accepted:true, state?, timeoutMs}` | `{accepted:false, timeoutMs, error:{code,message}}` |
 * | `leaseStatus` | `{state, generation, expiresAt, lastPersistedRevision}` | `{absent:true}`（不是失败） |
 *
 * 早期实现只判 `result.ok === false` 并读 `result.error?.code`，造成两个真实后果：
 * 1. `handshake` 的失败码丢失 —— Host 用 `errorCode`，代码读 `error.code`，一律成 `UNKNOWN`；
 * 2. `saveAck` / `pause` 的失败被当成成功 —— 它们没有 `ok` 字段而是 `accepted`，
 *    条件不成立、不抛错，`{accepted:false, error:{code:'STALE_RUNTIME'}}` 原样返回给调用方。
 *
 * 第 2 条会让"旧代次拒写"这类诊断把失败静默画成成功，所以必须逐形状识别。
 * 本函数只读字段，不做任何值转换，也不把 `tokenDigest` 等凭据类字段带进消息。
 *
 * @param {any} result Host wire 返回值
 * @returns {{code: string, message: string} | null}
 */
export function remoteFailureOf(result: any): {
    code: string;
    message: string;
} | null;
/**
 * 五个方法的 Client 侧包装：把 Host 的失败形状统一成抛异常，或返回原始结果。
 *
 * @param {any} remoteService `ctx.remote.gameCenter`（挂载成功后才有）
 * @returns {{handshake: Function, pause: Function, saveAck: Function, leaseStatus: Function, modelCatalog: Function}}
 */
export function createGameCenterClient(remoteService: any): {
    handshake: Function;
    pause: Function;
    saveAck: Function;
    leaseStatus: Function;
    modelCatalog: Function;
};
/**
 * Client 侧 `gameCenter` Remote 挂载（方案 (b)）。
 *
 * 【这是本项目拟新增代码，不是 DSH API。它调用的是 DSH 的公开服务方法。】
 *
 * 形状依据（实读 0.2.1-rc.2 / `332895e0…`，可复现探针 `tools/probe-typert-rules.mjs`）：
 *
 * 【第一道闸门】`dsh-api-gateway/lib/client.browser.js`
 *   `$mount` → `mountContribution` → `validateContribution` → `requireStrictInputs`：
 *   每个 `parameter.codec.mode` 与 `descriptor.result.mode` **必须**是 `"strict"`，
 *   否则抛 `has no strict codec`。（`requireStrictCodec` 全文就这一条判定。）
 *
 * 【第二道闸门】`dsh-typert-registry/lib/client.browser.js`
 *   `RemoteStore.register(ctx, contribution)` → `this.descriptors.validate(descriptors)`
 *   → `validateInvocation(descriptor)`，**还要求**：
 *     - `descriptor.id`（非空）
 *     - `descriptor.service`（segment）
 *     - `descriptor.namespace` / `descriptor.method`（wire name）
 *     - `descriptor.result` 过 `validateCodec`
 *     - 每个 parameter 的 `name` / `wire` 合法且 `wire` 不重复
 *     - `cancellation` 若存在，`cancellation.parameter` **必须**是 `"signal"`
 *     - `mode` 若存在只能是 `"stream"`
 *     - `scope` 只能在 `invocation.kind === "direct"` 时声明，且须选中唯一 lookup 参数
 *   注意 `validateCodec`：`mode === "src-json"` 直接放行；`strict` 才要求
 *   `typeSymbol` 非空且 `create` 是函数 —— 而网关侧只认 `strict`。
 *   **两道闸门对 codec 的要求互斥：网关要 strict，typert 的 strict 又要 create() 工厂。**
 *   因此本项目选择「`strict` + 最小 `typeSymbol` + 恒等 `create()`」，两头都过。
 *
 * 【调用期】`connection.rpc.call("/api", "<namespace>/<method>", { args }, signal)`；
 *   gateway client 全文无 `.encode(` 调用点 → **参数不经 Client 编码**，
 *   真实校验在 Host 侧，wire 字段名必须与 Host 形参名一致。
 *   `descriptor.cancellation !== undefined` 时 Host 才把 AbortSignal 注入末位参数。
 *
 * 【Host 侧前提】Client 手写 contribution 只让方法"出现在 Client 上"；
 *   Host 侧必须真的用 `@Remote` 声明（`typertRemote.namespace` + `remoteMethods`），
 *   否则调用期报 `gateway/invocation-unavailable`。这条由 Host 工程师负责。
 */
/** 挂载失败的原因码（本模块自定义，便于界面区分提示）。 */
export const MOUNT_ERRORS: Readonly<{
    NO_REMOTE_SERVICE: "MOUNT_NO_REMOTE_SERVICE";
    INVALID_CONTRIBUTION: "MOUNT_INVALID_CONTRIBUTION";
    MOUNT_THREW: "MOUNT_THREW";
}>;
export type WireParameter = {
    name: string;
    wire: string;
    source: "json";
    codec: {
        mode: "strict";
        typeSymbol: string;
        create: () => unknown;
    };
};
export type WireCodec = {
    mode: "strict";
    typeSymbol: string;
    create: () => unknown;
};
export type WireDescriptor = {
    /**
     * typert 要求的全局唯一 invocation id
     */
    id: string;
    /**
     * typert 要求的 service key
     */
    service: string;
    namespace: string;
    method: string;
    invocation: {
        kind: "direct";
    };
    parameters: WireParameter[];
    result: WireCodec;
    cancellation?: {
        parameter: "signal";
    } | {
        signal?: string;
    };
};
export type WireContribution = {
    package: string;
    descriptors: WireDescriptor[];
};
