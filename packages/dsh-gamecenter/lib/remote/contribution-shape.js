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
/** Cordis 服务键：与 Host 侧 `SERVICE_KEY` 一致，避免端到端对账歧义。 */
const SERVICE_KEY = 'gameCenter';
const PACKAGE = '@dsh-gamecenter/client';
function strictCodec(name) {
    return {
        mode: 'strict',
        typeSymbol: `${PACKAGE}#${name}`,
        // Client 不执行参数编码，create 仅需存在。
        create: () => undefined,
    };
}
/** `gameCenter` 命名空间五个方法对应的 descriptor（与 Host 侧实现一一对应）。 */
export function gameCenterDescriptors() {
    const direct = (method) => ({
        id: `${PACKAGE}#gameCenter.${method}`,
        service: SERVICE_KEY,
        namespace: 'gameCenter',
        method,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'input', wire: 'input', source: 'json', codec: strictCodec(`${method}.input`) }],
        result: { mode: 'strict' },
    });
    return [
        direct('handshake'),
        direct('pause'),
        direct('saveAck'),
        direct('leaseStatus'),
        {
            id: `${PACKAGE}#gameCenter.modelCatalog`,
            service: SERVICE_KEY,
            namespace: 'gameCenter',
            method: 'modelCatalog',
            invocation: { kind: 'direct' },
            // 零 wire 参数：Host 形参只有末尾的 AbortSignal。
            parameters: [],
            result: { mode: 'strict' },
            // Host 只在 cancellation 非空时注入 signal（dsh-api-gateway/lib/index.js:1210）。
            cancellation: { parameter: 'signal' },
        },
    ];
}
export function createGameCenterContribution() {
    return { package: PACKAGE, descriptors: gameCenterDescriptors() };
}
/** `validateWireName`：`/^[A-Za-z0-9_$.-]+$/` 且不得是 `.` / `..`。 */
function isValidWireName(value) {
    if (typeof value !== 'string')
        return false;
    if (value === '.' || value === '..')
        return false;
    return /^[A-Za-z0-9_$.-]+$/.test(value);
}
/** `validateSegment`：非空且不含 `#`。 */
function isValidSegment(value) {
    return typeof value === 'string' && value.length > 0 && !value.includes('#');
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
export function validateContributionShape(contribution) {
    const violations = [];
    if (!isValidSegment(contribution.package)) {
        violations.push({
            endpoint: '*',
            gate: 'typert',
            field: 'package',
            reason: 'package 必须非空且不含 "#"',
        });
    }
    const seenEndpoints = new Set();
    for (const descriptor of contribution.descriptors) {
        const endpoint = `${descriptor.namespace}/${descriptor.method}`;
        // ---- 网关道 ----
        for (const parameter of descriptor.parameters) {
            if (parameter.codec?.mode !== 'strict') {
                violations.push({
                    endpoint,
                    gate: 'gateway',
                    field: parameter.wire,
                    reason: 'codec.mode 必须是 "strict"（requireStrictInputs）',
                });
            }
        }
        if (descriptor.invocation.kind !== 'direct') {
            violations.push({
                endpoint,
                gate: 'gateway',
                field: 'invocation.kind',
                reason: '本项目只使用 direct 调用',
            });
        }
        // ---- typert 道 ----
        if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
            violations.push({
                endpoint,
                gate: 'typert',
                field: 'id',
                reason: 'descriptor.id 必须非空（validateNonempty）',
            });
        }
        if (!isValidSegment(descriptor.service)) {
            violations.push({
                endpoint,
                gate: 'typert',
                field: 'service',
                reason: 'service 必须非空且不含 "#"（validateSegment）',
            });
        }
        if (!isValidWireName(descriptor.namespace)) {
            violations.push({
                endpoint,
                gate: 'typert',
                field: 'namespace',
                reason: 'namespace 必须匹配 [A-Za-z0-9_$.-] 且不是 "." / ".."（validateWireName）',
            });
        }
        if (!isValidWireName(descriptor.method)) {
            violations.push({
                endpoint,
                gate: 'typert',
                field: 'method',
                reason: 'method 必须匹配 [A-Za-z0-9_$.-]（validateWireName）',
            });
        }
        if (seenEndpoints.has(endpoint)) {
            violations.push({
                endpoint,
                gate: 'gateway',
                field: '*',
                reason: '同一次挂载里重复的 namespace+method',
            });
        }
        seenEndpoints.add(endpoint);
        const wires = new Set();
        for (const parameter of descriptor.parameters) {
            if (!isValidWireName(parameter.name)) {
                violations.push({
                    endpoint,
                    gate: 'typert',
                    field: 'parameter.name',
                    reason: 'parameter.name 必须匹配 [A-Za-z0-9_$.-]（validateWireName）',
                });
            }
            if (!isValidWireName(parameter.wire)) {
                violations.push({
                    endpoint,
                    gate: 'typert',
                    field: 'parameter.wire',
                    reason: 'parameter.wire 必须匹配 [A-Za-z0-9_$.-]（validateWireName）',
                });
            }
            if (wires.has(parameter.wire)) {
                violations.push({
                    endpoint,
                    gate: 'typert',
                    field: parameter.wire,
                    reason: 'wire 字段在同一方法内重复',
                });
            }
            wires.add(parameter.wire);
            // strict codec 在 typert 道要求 typeSymbol 非空 + create 是函数。
            const codec = parameter.codec;
            if (codec?.mode === 'strict') {
                if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
                    violations.push({
                        endpoint,
                        gate: 'typert',
                        field: `${parameter.wire}.typeSymbol`,
                        reason: 'strict codec 的 typeSymbol 必须非空',
                    });
                }
                if (typeof codec.create !== 'function') {
                    violations.push({
                        endpoint,
                        gate: 'typert',
                        field: `${parameter.wire}.create`,
                        reason: 'strict codec 必须有 create() 工厂',
                    });
                }
            }
        }
        if (descriptor.cancellation !== undefined && descriptor.cancellation.parameter !== 'signal') {
            violations.push({
                endpoint,
                gate: 'typert',
                field: 'cancellation.parameter',
                reason: 'cancellation.parameter 必须是 "signal"',
            });
        }
    }
    return violations;
}
//# sourceMappingURL=contribution-shape.js.map