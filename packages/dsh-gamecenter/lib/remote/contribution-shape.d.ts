/**
 * Client 侧外部 contribution 的**形状契约**（供界面与运行时工程师手写时对齐）。
 *
 * 全部结论来自实装源码只读核实（0.2.1-rc.2 / build 332895e0…）。
 *
 * ## 两道闸门（顺序本身就是结论）
 *
 * `dsh-api-gateway/lib/client.browser.js` @63022 `mountContribution`：
 *   1. `this.validateContribution(contribution)`  ← 先
 *   2. `callerCtx.typert.remotes.register(contribution)` ← 后
 *
 * **网关道（第 1 道）**：`validateContribution` 对每个 descriptor 无条件调 `requireStrictInputs`，
 * 它只查三处 codec —— `parameters[].codec`、`uplink.codec`、`invocation.kind === "context"` 时的
 * `invocation.codec`；`requireStrictCodec` 要求 `codec.mode === "strict"`。
 * **不查 `result`。**
 *
 * **typert 道（第 2 道）**：`dsh-typert-registry/lib/client.browser.js` `validateInvocation` 要求
 * `id` / `service` / `namespace` / `method` 非空且符合字符集；
 * `validateCodec` 对 `src-json` 直接 return，对 `strict` 要求 `typeSymbol` 非空 + `create` 是函数。
 * `cancellation.parameter` 必须等于 `"signal"`。
 *
 * 因为网关道先跑，**参数 codec 不能用 src-json**；但 `result` 网关道不查，
 * typert 道又放行 src-json，所以 result 可以用 src-json。
 *
 * ## 本地校验器必须同时复刻两道
 *
 * 只复刻网关道会漏掉 `id`/`service`/`typeSymbol`/`create`/`cancellation.parameter`
 * —— 这些在 typert 道才查，漏掉就会让"照此手写"在 registry 阶段挂掉。
 *
 * ## 诚实边界
 *
 * 本文件是「按源码核对后的形状 + 本地校验器」，不是已跑通的端到端证据。
 * 真实 `$mount` 需要在装载后的 DSH 里执行，尚未做。
 */
/** 参数来源：本项目的五个方法都用普通 JSON 参数。 */
export interface WireParameter {
    /** 业务参数名（Host 方法里的形参名）。 */
    name: string;
    /** wire 上的字段名。 */
    wire: string;
    source: 'json';
    /**
     * 网关道要求 `mode: 'strict'`；typert 道对 strict 还要求 `typeSymbol` + `create`。
     */
    codec: StrictCodec;
}
export interface StrictCodec {
    mode: 'strict';
    /** typert `validateCodec` 要求非空。 */
    typeSymbol: string;
    /**
     * typert `validateCodec` 要求是函数。
     * 注意：Client 侧**不执行**参数编码（gateway 无 `.encode(` 调用点），
     * 这里的存在性只是过闸门所需，不要在此写业务逻辑。
     */
    create: () => unknown;
}
export interface WireDescriptor {
    /**
     * typert 道要求非空。允许含 `#`（只过 `validateNonempty`）。
     * 约定：`<package>#<namespace>.<method>`。
     */
    id: string;
    /**
     * typert 道要求非空且**不含 `#`**（走 `validateSegment`）。
     * 取 Cordis 服务键，与 Host 侧保持一致。
     */
    service: string;
    /** 走 `validateWireName`：仅 `[A-Za-z0-9_$.-]`，且不得是 `.` / `..`。 */
    namespace: string;
    /** 同上。 */
    method: string;
    invocation: {
        kind: 'direct';
    };
    parameters: WireParameter[];
    /**
     * 结果 codec。网关道不查它；typert 道接受 `strict` 或 `src-json`。
     * 本项目统一用 strict，便于日后接 `decode`。
     */
    result: {
        mode: 'strict';
        decode?: (value: unknown) => unknown;
    };
    /**
     * 是否支持取消。**必须填**，否则 Host 不会把 AbortSignal 注入到方法末位参数
     * （`dsh-api-gateway/lib/index.js` 第 1210 行 `if (descriptor.cancellation !== void 0) args.push(signal)`）。
     * typert 道要求 `parameter === "signal"`。
     */
    cancellation?: {
        parameter: 'signal';
    };
}
export interface WireContribution {
    /** 唯一包标识；typert 道拒绝含 `#` 且拒绝同名重复注册。 */
    package: string;
    descriptors: WireDescriptor[];
}
/** `gameCenter` 命名空间五个方法对应的 descriptor（与 Host 侧实现一一对应）。 */
export declare function gameCenterDescriptors(): WireDescriptor[];
export declare function createGameCenterContribution(): WireContribution;
export interface ShapeViolation {
    endpoint: string;
    /** 违反的是哪一道闸门，便于定位。 */
    gate: 'gateway' | 'typert';
    field: string;
    reason: string;
}
/**
 * 同时复刻**两道**闸门的本地校验器。
 *
 * - 网关道：参数/uplink/context 的 codec 必须 strict（不查 result）；
 * - typert 道：id / service / namespace / method、codec 的 typeSymbol+create、
 *   wire 字段查重、cancellation.parameter === 'signal'。
 *
 * 返回空数组表示两层都会通过（仍不代表真实 `$mount` 成功）。
 */
export declare function validateContributionShape(contribution: WireContribution): ShapeViolation[];
