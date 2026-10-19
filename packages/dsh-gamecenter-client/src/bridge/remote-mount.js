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
export const MOUNT_ERRORS = Object.freeze({
  NO_REMOTE_SERVICE: 'MOUNT_NO_REMOTE_SERVICE',
  INVALID_CONTRIBUTION: 'MOUNT_INVALID_CONTRIBUTION',
  MOUNT_THREW: 'MOUNT_THREW',
});

/**
 * @typedef {object} WireParameter
 * @property {string} name
 * @property {string} wire
 * @property {'json'} source
 * @property {{mode: 'strict', typeSymbol: string, create: () => unknown}} codec
 */

/**
 * @typedef {object} WireCodec
 * @property {'strict'} mode
 * @property {string} typeSymbol
 * @property {() => unknown} create
 */

/**
 * @typedef {object} WireDescriptor
 * @property {string} id typert 要求的全局唯一 invocation id
 * @property {string} service typert 要求的 service key
 * @property {string} namespace
 * @property {string} method
 * @property {{kind: 'direct'}} invocation
 * @property {WireParameter[]} parameters
 * @property {WireCodec} result
 * @property {{parameter: 'signal'} | {signal?: string}} [cancellation]
 */

/**
 * @typedef {object} WireContribution
 * @property {string} package
 * @property {WireDescriptor[]} descriptors
 */

/** Host 侧五个方法的 wire 形参名（必须与 Host 形参逐一对应）。 */
const METHODS_WITH_INPUT = ['handshake', 'pause', 'saveAck', 'leaseStatus'];

/**
 * 本包贡献者的身份键，用作 invocation id 前缀与 `service` 字段。
 *
 * 【取值依据与「不是缺陷」的澄清】DSH Host工程师 提示过：Client descriptor 的 `service`
 * 与 Host 侧 Cordis 服务键不同。我独立核实后确认**这不阻断调用**：
 * - 调用期 Host 用的是**自己 SRC 生成的** descriptor：`dsh-api-gateway/lib/index.js`
 *   `prepareInvocation` 里 `receiverContext.get(descriptor.service)`，那个 descriptor 来自
 *   `srcDescriptor()` 的 `service: binding.serviceKey`（Host 侧真实 Cordis 服务键）。
 * - Client 侧上线只发 `connection.rpc.call("/api", endpoint, { args: prepared.args }, signal)`，
 *   **`service` 字段根本不过 wire**。
 * - typert `validateInvocation` 对 `service` 只查非空，不查它等于哪个真实服务键。
 *
 * 即便如此仍取 `gameCenter`：与 Host 侧 `packages/dsh-gamecenter/src/dsh-adapter/protocol.ts`
 * 的 `SERVICE_KEY = 'gameCenter'` 同名，消除将来对账时的歧义，也避免下一个人误以为
 * 这个字段会被 Host 采用。
 */
const SERVICE_KEY = 'gameCenter';

/**
 * 构造一个两头都能过的 strict codec。
 *
 * 网关 `requireStrictCodec` 只认 `mode === "strict"`；
 * typert `validateCodec` 对 strict 还要求 `typeSymbol` 非空 + `create` 是函数。
 * 参数不经 Client 编码（gateway 无 `.encode(` 调用点），所以 `create` 只要存在即可，
 * 这里给恒等函数，明确表示「不对值做转换」。
 *
 * @param {string} name 用于 typeSymbol 的可读后缀
 * @returns {WireCodec}
 */
function strictCodec(name) {
  return {
    mode: 'strict',
    typeSymbol: `@dsh-gamecenter/client#${name}`,
    create: () => undefined,
  };
}

/**
 * 构造 `gameCenter` 命名空间的 contribution。
 * 与 `packages/dsh-gamecenter/src/remote/contribution-shape.ts` 语义对齐，
 * 但补齐了 typert 侧 `validateInvocation` 要求的 `id` / `service` / codec 字段。
 * @returns {WireContribution}
 */
export function createGameCenterContribution() {
  /** @type {WireDescriptor[]} */
  const descriptors = METHODS_WITH_INPUT.map((method) => ({
    id: `@dsh-gamecenter/client#gameCenter.${method}`,
    service: SERVICE_KEY,
    namespace: 'gameCenter',
    method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: strictCodec(`${method}.input`) }],
    result: strictCodec(`${method}.result`),
  }));

  // modelCatalog 无业务参数；Host 形参只有末尾 AbortSignal，故必须声明 cancellation。
  descriptors.push({
    id: '@dsh-gamecenter/client#gameCenter.modelCatalog',
    service: SERVICE_KEY,
    namespace: 'gameCenter',
    method: 'modelCatalog',
    invocation: { kind: 'direct' },
    parameters: [],
    result: strictCodec('modelCatalog.result'),
    cancellation: { parameter: 'signal' },
  });

  return { package: '@dsh-gamecenter/client', descriptors };
}

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
export function validateContributionShape(contribution) {
  /** @type {{endpoint: string, field: string, reason: string}[]} */
  const violations = [];
  /**
   * @param {string} endpoint
   * @param {string} field
   * @param {string} reason
   */
  const push = (endpoint, field, reason) => {
    violations.push({ endpoint, field, reason });
  };

  if (typeof contribution.package !== 'string' || contribution.package.length === 0) {
    push('*', 'package', 'package 必须是非空字符串');
  } else if (contribution.package.includes('#')) {
    push('*', 'package', 'package 名不能含 "#"（typert validateSegment）');
  }
  if (!Array.isArray(contribution.descriptors)) {
    push('*', 'descriptors', 'descriptors 必须是数组');
    return violations;
  }

  /** @type {Set<string>} */
  const endpoints = new Set();
  /** @type {Set<string>} */
  const ids = new Set();

  /**
   * typert `validateWireName`：禁 `.` / `..`，且必须匹配 `/^[A-Za-z0-9_$.-]+$/`。
   * @param {string} endpoint
   * @param {string} field
   * @param {unknown} value
   */
  const checkWireName = (endpoint, field, value) => {
    if (typeof value !== 'string' || value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
      push(endpoint, field, `必须是合法 wire name（仅 A-Za-z0-9_$.- 且不为 "." / ".."），实际 ${JSON.stringify(value)}`);
    }
  };

  /**
   * typert `validateSegment`：非空且不含 `#`。
   * @param {string} endpoint
   * @param {string} field
   * @param {unknown} value
   */
  const checkSegment = (endpoint, field, value) => {
    if (typeof value !== 'string' || value.length === 0 || value.includes('#')) {
      push(endpoint, field, `必须非空且不含 "#"，实际 ${JSON.stringify(value)}`);
    }
  };

  /**
   * typert `validateCodec`：`src-json` 直接放行；`strict` 要求 typeSymbol 非空 + create 是函数。
   * @param {any} codec
   * @param {string} endpoint
   * @param {string} field
   */
  const checkTypertCodec = (codec, endpoint, field) => {
    if (codec === undefined || codec === null) return;
    if (codec.mode === 'src-json') return;
    if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
      push(endpoint, field, 'typert 要求 codec 的 typeSymbol 非空');
    }
    if (typeof codec.create !== 'function') {
      push(endpoint, field, 'typert 要求 strict codec 有 create() 工厂');
    }
  };

  for (const descriptor of contribution.descriptors) {
    const endpoint = `${descriptor.namespace}/${descriptor.method}`;

    // —— typert validateInvocation：必填身份字段 ——
    // id 只过 validateNonempty，**不校验字符集**（含 "#" 合法）。
    if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
      push(endpoint, 'id', 'typert 要求非空 invocation id');
    } else if (ids.has(descriptor.id)) {
      push(endpoint, 'id', `invocation id "${descriptor.id}" 重复`);
    } else {
      ids.add(descriptor.id);
    }
    checkSegment(endpoint, 'service', descriptor.service);
    checkWireName(endpoint, 'namespace', descriptor.namespace);
    checkWireName(endpoint, 'method', descriptor.method);

    // —— 网关 validateContribution：endpoint 唯一 ——
    if (endpoints.has(endpoint)) push(endpoint, '*', '重复的 namespace+method');
    endpoints.add(endpoint);

    if (descriptor.invocation?.kind !== 'direct') {
      push(endpoint, 'invocation.kind', '本项目只使用 direct');
    }

    // —— 网关 requireStrictInputs：**只查 parameters / uplink / context invocation** ——
    // 注意：网关**不校验 result.mode**（测试与发布负责人指出）。
    // result 由 typert 的 validateCodec 管，见下方 checkTypertCodec。
    /** @type {Set<string>} */
    const wires = new Set();
    for (const parameter of descriptor.parameters ?? []) {
      checkWireName(endpoint, 'parameter.name', parameter.name);
      checkWireName(endpoint, 'parameter.wire', parameter.wire);
      if (typeof parameter.wire === 'string' && parameter.wire.length > 0) {
        if (wires.has(parameter.wire)) {
          push(endpoint, parameter.wire, `wire 字段 "${parameter.wire}" 重复`);
        } else {
          wires.add(parameter.wire);
        }
      }
      // 参数 codec：网关要求 strict，typert 要求 strict 还要 typeSymbol + create
      if (parameter.codec?.mode !== 'strict') {
        push(endpoint, parameter.wire, '网关要求 codec.mode 必须是 "strict"');
      } else {
        checkTypertCodec(parameter.codec, endpoint, parameter.wire);
      }
    }

    // result：网关不管；typert 的 validateCodec 才管
    checkTypertCodec(descriptor.result, endpoint, 'result');
    if (descriptor.result?.mode !== 'strict' && descriptor.result?.mode !== 'src-json') {
      push(endpoint, 'result', 'result.mode 只能是 "strict" 或 "src-json"（typert validateCodec）');
    }

    if (descriptor.cancellation !== undefined) {
      const parameter = /** @type {any} */ (descriptor.cancellation).parameter;
      if (parameter !== 'signal') {
        push(endpoint, 'cancellation.parameter', 'typert 要求 cancellation.parameter 必须是 "signal"');
      }
    }
    if (/** @type {any} */ (descriptor).mode !== undefined && /** @type {any} */ (descriptor).mode !== 'stream') {
      push(endpoint, 'mode', 'typert 只接受 mode: "stream"');
    }
    if (/** @type {any} */ (descriptor).scope !== undefined) {
      push(endpoint, 'scope', '本项目不使用 scoped 路径，不要填 scope');
    }
  }
  return violations;
}

/**
 * 挂载 `gameCenter`。**调用方必须是已注入 `remote` 服务的 Client 插件上下文。**
 *
 * @param {any} ctx Cordis 插件上下文（需有 `ctx.remote.$mount`）
 * @param {{contribution?: WireContribution, logger?: {warn: (m: unknown) => void}}} [options]
 * @returns {Promise<{ok: true, dispose: () => Promise<void>} | {ok: false, code: string, message: string}>}
 */
export async function mountGameCenterRemote(ctx, options = {}) {
  const contribution = options.contribution ?? createGameCenterContribution();

  const violations = validateContributionShape(contribution);
  if (violations.length > 0) {
    const first = violations[0];
    const where = first === undefined ? '未知位置' : `${first.endpoint} ${first.field} —— ${first.reason}`;
    return {
      ok: false,
      code: MOUNT_ERRORS.INVALID_CONTRIBUTION,
      message: `contribution 形状不合格：${where}`,
    };
  }

  const remote = ctx?.remote;
  if (remote === undefined || remote === null || typeof remote.$mount !== 'function') {
    return {
      ok: false,
      code: MOUNT_ERRORS.NO_REMOTE_SERVICE,
      message: '当前 Client 装配没有提供 remote.$mount；本插件需要 inject ["remote"]。',
    };
  }

  try {
    const dispose = await remote.$mount(contribution);
    return {
      ok: true,
      dispose: async () => {
        try {
          await dispose();
        } catch (error) {
          options.logger?.warn(`gameCenter: 卸载 Remote 失败（已忽略）：${String(error)}`);
        }
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: MOUNT_ERRORS.MOUNT_THREW,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

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
export function remoteFailureOf(result) {
  if (result === null || typeof result !== 'object') return null;

  // handshake 及通用错误风格：{ok:false, errorCode/error:{code}, message/error:{message}}
  if (result.ok === false) {
    const nested = result.error;
    const hasNested = nested !== null && typeof nested === 'object';
    const code =
      (typeof result.errorCode === 'string' && result.errorCode.length > 0 && result.errorCode) ||
      (hasNested && typeof nested.code === 'string' && nested.code.length > 0 && nested.code) ||
      'UNKNOWN';
    const message =
      (typeof result.message === 'string' && result.message.length > 0 && result.message) ||
      (hasNested && typeof nested.message === 'string' && nested.message.length > 0 && nested.message) ||
      'gameCenter 调用失败';
    return { code, message };
  }

  // saveAck / pause 风格：{accepted:false, error:{code,message}, …}
  if (result.accepted === false) {
    const nested = result.error;
    const hasNested = nested !== null && typeof nested === 'object';
    return {
      code: hasNested && typeof nested.code === 'string' && nested.code.length > 0 ? nested.code : 'UNKNOWN',
      message:
        hasNested && typeof nested.message === 'string' && nested.message.length > 0
          ? nested.message
          : 'gameCenter 调用被拒绝',
    };
  }

  // leaseStatus 的 {absent:true} 是「没有该租约」，不是失败，交由调用方判断。
  return null;
}

/**
 * 五个方法的 Client 侧包装：把 Host 的失败形状统一成抛异常，或返回原始结果。
 *
 * @param {any} remoteService `ctx.remote.gameCenter`（挂载成功后才有）
 * @returns {{handshake: Function, pause: Function, saveAck: Function, leaseStatus: Function, modelCatalog: Function}}
 */
export function createGameCenterClient(remoteService) {
  /**
   * @param {string} method
   * @param {unknown[]} args
   * @returns {Promise<any>}
   */
  const call = async (method, args) => {
    const fn = remoteService?.[method];
    if (typeof fn !== 'function') {
      const error = new Error(`gameCenter.${method} 未挂载`);
      /** @type {any} */ (error).code = 'MOUNT_INVALID_CONTRIBUTION';
      throw error;
    }
    const result = await fn.call(remoteService, ...args);

    // 1. 顶层信封错误判定（如网关直接返回 { ok: false, error: { code, message } }）
    const outerFailure = remoteFailureOf(result);
    if (outerFailure !== null) {
      const error = new Error(outerFailure.message);
      /** @type {any} */ (error).code = outerFailure.code;
      throw error;
    }

    // 2. 网关信封解包：真实 /api 路由返回 { ok: true, value: <业务结果> }
    // 严密判定：信封恰好只有两个自有键 ['ok', 'value']，避免误伤恰好含 value 属性的业务对象
    let unwrapped = result;
    const isEnvelope =
      result !== null &&
      typeof result === 'object' &&
      result.ok === true &&
      Object.hasOwn(result, 'value') &&
      Object.keys(result).length === 2;
    if (isEnvelope) {
      unwrapped = result.value;
    }

    // 3. 业务层错误判定（如内层 value 为 { ok: false, errorCode: ... } 或 { accepted: false, error: ... }）
    const innerFailure = remoteFailureOf(unwrapped);
    if (innerFailure !== null) {
      const error = new Error(innerFailure.message);
      /** @type {any} */ (error).code = innerFailure.code;
      throw error;
    }

    return unwrapped;
  };

  return {
    /** @param {any} input @returns {Promise<any>} */
    handshake: (input) => call('handshake', [input]),
    /** @param {any} input @returns {Promise<any>} */
    pause: (input) => call('pause', [input]),
    /** @param {any} input @returns {Promise<any>} */
    saveAck: (input) => call('saveAck', [input]),
    /** @param {any} input @returns {Promise<any>} */
    leaseStatus: (input) => call('leaseStatus', [input]),
    /** @returns {Promise<any>} */
    modelCatalog: () => call('modelCatalog', []),
  };
}
