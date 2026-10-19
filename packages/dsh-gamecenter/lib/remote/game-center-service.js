/**
 * Host Remote 服务：`gameCenter` 命名空间（**本项目拟新增协议**，DSH 中不存在）。
 *
 * ## 实装 DSH 支撑（0.2.1-rc.2 / build 332895e0…，全部只读核实）
 *
 * 1. Host 业务服务用法：继承 `TypertRemoteService`（`super(ctx, serviceKey, options?)`
 *    → `this.typertRemote = bindTypertRemote(this, name, options)`），用 `@Remote`
 *    标记公开实例方法。出处 `dsh-typert-protocol/lib/index.js`。
 * 2. Gateway 发现：`TypertGatewayService.collectSrcClaims()` 遍历
 *    `ctx.reflect.props` 中 `type === "service"` 的项，读 `typertRemote.namespace`
 *    与 `remoteMethods()`，据此把 `<namespace>/<method>` 声明为 SRC 端点。
 *    出处 `dsh-api-gateway/lib/index.js`。
 * 3. 取消语义：方法的**最后一个** `AbortSignal` 参数是 descriptor 元数据，由 Gateway
 *    在已解码业务参数之后注入，不是 wire 参数。出处 api-gateway README 与
 *    `prepareInvocation` 的 `src-json` 参数构造。**因此本服务把 `signal`
 *    放在最后一位，且不把它计入 wire 参数。**
 * 4. 返回类型必须是无损 JSON（`isRemoteJsonValue`），不能返回 `undefined`、
 *    `Uint8Array`、函数或类实例。
 *
 * ## 与 Client 的接线契约
 *
 * | 方法 | 入参（wire） | 出参（JSON） |
 * | --- | --- | --- |
 * | `handshake` | `{runtimeInstanceId, nonce, gameId, gameVersion, sdkVersion, bridgeVersion}` | `{ok, generation?, runtimeToken?, tokenDigest?, state?, errorCode?, message?}` |
 * | `saveAck` | `{runtimeToken, revision, generation?}` | `{accepted, state?, lastPersistedRevision?, error?}` |
 * | `pause` | `{runtimeToken, reason, generation?}` | `{accepted, state?, timeoutMs, error?}` |
 * | `leaseStatus` | `{runtimeToken}` | `{absent:true} \| {state, generation, expiresAt, lastPersistedRevision}` |
 * | `modelCatalog` | `{}` | `{available, entries[], failures[]}` |
 *
 * **身份绑定（2026-10-19 安全修复）**：`pause` / `saveAck` / `leaseStatus` 一律用
 * 调用方持有的 `runtimeToken` 解析租约，`gameId`/`saveId` **由 Host 从租约读出**，
 * **不再接受调用方自报**。凭证在 `handshake` 响应里下发一次，Host 只存 SHA-256 摘要；
 * 它作用域限于该运行实例，封存或过期即失效，**游戏 iframe 不得接触**。
 *
 * **generation 的来源与用途**：由 `handshake` 下发。请求里携带它是**可选**的，
 * 只用于检测迟到写入——与凭证对应租约的代次不符时返回 `STALE_RUNTIME`。
 * **授权不依赖代次**：早期用「按代次全局查找」当身份是缺陷（跨存档写入 +
 * 第二轮诊断误判），见 `docs/phase0-host.md` §14。
 *
 * **失败形状（三种，不统一，Client 必须都处理）**：
 * `handshake` 用 `{ok:false, errorCode, message}`；`saveAck`/`pause` 用
 * `{accepted:false, …, error:{code, message}}`；`leaseStatus` 对无效凭证统一回
 * `{absent:true}`（不区分原因，避免探测）。
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { REMOTE_NAMESPACE, SERVICE_KEY } from "../dsh-adapter/protocol.js";
import { LeaseRegistry } from "../runtime/lease.js";
import { readModelCatalog } from "../ai/model-catalog.js";
/**
 * 服务实现。刻意与装饰器分离：
 * - `GameCenterCore` 是**纯逻辑**，可在 Node 单测里直接调用；
 * - `defineGameCenterService()` 才把 `@Remote` 装上去，需要真实的协议模块。
 */
export class GameCenterCore {
    registry = new LeaseRegistry();
    /**
     * 暂停超时目标（基线 §8.1 建议 3 秒）。声明为产品目标而非硬承诺，
     * 需以目标 DSH 与游戏引擎实测调整。
     */
    pauseTimeoutMs = 3000;
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    get ttlMs() {
        return this.deps.ttlMs ?? 30_000;
    }
    /**
     * 统一的运行身份解析入口。
     *
     * **先判存在、再求摘要**：早期版本直接对入参求摘要，于是空串会得到
     * 「空串的 sha256」——一个合法摘要，令「凭证缺失」永远退化报成
     * 「凭证无效」。现在把存在性检查放在摘要之前，两种原因可区分。
     */
    resolveRuntime(runtimeToken) {
        if (typeof runtimeToken !== 'string' || runtimeToken.length === 0) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: '缺少运行凭证。',
                details: { reason: 'credential-missing' },
            };
        }
        return this.registry.resolveByToken(this.deps.digestToken(runtimeToken), this.deps.nowMs());
    }
    handshake(input) {
        if (input.bridgeVersion !== 1) {
            return { ok: false, errorCode: 'PROTOCOL_INVALID', message: 'bridgeVersion 不受支持。' };
        }
        if (input.runtimeInstanceId.length === 0 || input.gameId.length === 0) {
            return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '缺运行实例或游戏标识。' };
        }
        const saveId = input.runtimeInstanceId;
        const generation = this.deps.nextGeneration?.(input.gameId, saveId) ?? this.peekGeneration(input.gameId) + 1;
        const token = this.deps.createToken();
        const acquired = this.registry.acquire({
            gameId: input.gameId,
            saveId,
            ttlMs: this.ttlMs,
            generation,
            runtimeInstanceId: input.runtimeInstanceId,
            tokenDigest: this.deps.digestToken(token),
            nowMs: this.deps.nowMs(),
        });
        if (!acquired.ok) {
            return { ok: false, errorCode: acquired.code, message: acquired.message };
        }
        const running = this.registry.markRunning(input.gameId, saveId, generation, this.deps.nowMs(), this.ttlMs);
        if (!running.ok) {
            return { ok: false, errorCode: running.code, message: running.message };
        }
        // **凭证原文只在本次握手响应里下发一次**；Host 侧只保留摘要，
        // 后续 pause/saveAck/leaseStatus 必须回传原文，Host 摘要比对后据此定位租约。
        // 它不是 DSH 凭据：作用域限于本运行实例，封存或过期即失效，不能用于任何其他租约。
        return {
            ok: true,
            generation,
            runtimeToken: token,
            tokenDigest: acquired.lease.tokenDigest,
            state: 'running',
        };
    }
    /** 进程内代次推进：取该游戏所有存档的最大代次，避免进程内回退。 */
    peekGeneration(gameId) {
        let max = 0;
        for (const lease of this.registry.all()) {
            if (lease.gameId !== gameId)
                continue;
            if (lease.generation > max)
                max = lease.generation;
        }
        return max;
    }
    saveAck(input) {
        // **身份绑定**：先用调用方持有的运行凭证解析出租约，`gameId`/`saveId` 一律取自租约。
        const resolved = this.resolveRuntime(input.runtimeToken);
        if (!resolved.ok) {
            return { accepted: false, error: { code: resolved.code, message: resolved.message } };
        }
        const { lease } = resolved;
        if (typeof input.gameId === 'string' && input.gameId !== lease.gameId) {
            return {
                accepted: false,
                state: lease.state,
                lastPersistedRevision: lease.lastPersistedRevision,
                error: { code: 'PROTOCOL_INVALID', message: '声明的 gameId 与运行凭证不符。' },
            };
        }
        if (typeof input.saveId === 'string' && input.saveId !== lease.saveId) {
            return {
                accepted: false,
                state: lease.state,
                lastPersistedRevision: lease.lastPersistedRevision,
                error: { code: 'PROTOCOL_INVALID', message: '声明的 saveId 与运行凭证不符。' },
            };
        }
        // 代次由调用方声明只为**检测迟到写入**；真正的身份来自凭证，不来自代次。
        if (typeof input.generation === 'number' && input.generation !== lease.generation) {
            return {
                accepted: false,
                state: lease.state,
                lastPersistedRevision: lease.lastPersistedRevision,
                error: { code: 'STALE_RUNTIME', message: '保存确认携带的运行代次与凭证不符。' },
            };
        }
        const confirmed = this.registry.confirmPause(lease.gameId, lease.saveId, lease.generation, input.revision);
        const current = this.registry.get(lease.gameId, lease.saveId);
        const currentFields = current === undefined
            ? {}
            : { state: current.state, lastPersistedRevision: current.lastPersistedRevision };
        if (!confirmed.ok) {
            return {
                accepted: false,
                ...currentFields,
                error: { code: confirmed.code, message: confirmed.message },
            };
        }
        return { accepted: true, ...currentFields };
    }
    pause(input) {
        // **身份绑定**：同 saveAck，先按凭证解析；`gameId`/`saveId` 取自租约。
        const resolved = this.resolveRuntime(input.runtimeToken);
        if (!resolved.ok) {
            return {
                accepted: false,
                timeoutMs: this.pauseTimeoutMs,
                error: { code: resolved.code, message: resolved.message },
            };
        }
        const { lease } = resolved;
        if (typeof input.gameId === 'string' && input.gameId !== lease.gameId) {
            return {
                accepted: false,
                timeoutMs: this.pauseTimeoutMs,
                error: { code: 'PROTOCOL_INVALID', message: '声明的 gameId 与运行凭证不符。' },
            };
        }
        if (typeof input.saveId === 'string' && input.saveId !== lease.saveId) {
            return {
                accepted: false,
                timeoutMs: this.pauseTimeoutMs,
                error: { code: 'PROTOCOL_INVALID', message: '声明的 saveId 与运行凭证不符。' },
            };
        }
        if (typeof input.generation === 'number' && input.generation !== lease.generation) {
            return {
                accepted: false,
                timeoutMs: this.pauseTimeoutMs,
                error: { code: 'STALE_RUNTIME', message: '暂停请求携带的运行代次与凭证不符。' },
            };
        }
        const begun = this.registry.beginPause(lease.gameId, lease.saveId, lease.generation);
        if (!begun.ok) {
            return {
                accepted: false,
                timeoutMs: this.pauseTimeoutMs,
                error: { code: begun.code, message: begun.message },
            };
        }
        const after = this.registry.get(lease.gameId, lease.saveId);
        return {
            accepted: true,
            ...(after === undefined ? {} : { state: after.state }),
            timeoutMs: this.pauseTimeoutMs,
        };
    }
    /**
     * 租约状态：**只允许查询自己凭证对应的租约**。
     *
     * 早期版本接受调用方自报的 `{gameId, saveId}`，那会泄露（并放大为可探测）
     * 其他存档的运行元数据；现在身份同样来自凭证。支持可选声明进行交叉核验。
     */
    leaseStatus(input) {
        const resolved = this.resolveRuntime(input.runtimeToken);
        if (!resolved.ok) {
            // 凭证无效与"该租约不存在"对外一律回 `absent`，不区分原因，避免探测。
            return { absent: true };
        }
        const { lease } = resolved;
        if ((typeof input.gameId === 'string' && input.gameId !== lease.gameId) ||
            (typeof input.saveId === 'string' && input.saveId !== lease.saveId)) {
            return { absent: true };
        }
        return {
            state: lease.state,
            generation: lease.generation,
            expiresAt: lease.expiresAt,
            lastPersistedRevision: lease.lastPersistedRevision,
        };
    }
    async modelCatalog(llm, signal) {
        if (signal?.aborted === true) {
            return { entries: [], failures: [], available: false };
        }
        return readModelCatalog(llm);
    }
    /** 供测试与审计读取内部状态（不跨 wire）。 */
    inspect(gameId) {
        return gameId === undefined ? this.registry.all() : this.registry.all().filter((l) => l.gameId === gameId);
    }
}
/** 被 `@Remote` 标记的公开方法名（顺序即声明顺序）。 */
export const REMOTE_METHODS = ['handshake', 'saveAck', 'pause', 'leaseStatus', 'modelCatalog'];
const Base = TypertRemoteService;
/**
 * 核心方法装配为 Typert Remote 服务类。
 *
 * 使用 TypeScript 标准装饰器（Stage 3）@Remote 标记公开端点。
 * 运行时由 Gateway 的 collectSrcClaims() 扫描原型方法并在 /api/gameCenter/* 认领端点。
 */
let GameCenterService = (() => {
    let _classSuper = Base;
    let _instanceExtraInitializers = [];
    let _handshake_decorators;
    let _saveAck_decorators;
    let _pause_decorators;
    let _leaseStatus_decorators;
    let _modelCatalog_decorators;
    return class GameCenterService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _handshake_decorators = [Remote];
            _saveAck_decorators = [Remote];
            _pause_decorators = [Remote];
            _leaseStatus_decorators = [Remote];
            _modelCatalog_decorators = [Remote];
            __esDecorate(this, null, _handshake_decorators, { kind: "method", name: "handshake", static: false, private: false, access: { has: obj => "handshake" in obj, get: obj => obj.handshake }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveAck_decorators, { kind: "method", name: "saveAck", static: false, private: false, access: { has: obj => "saveAck" in obj, get: obj => obj.saveAck }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _pause_decorators, { kind: "method", name: "pause", static: false, private: false, access: { has: obj => "pause" in obj, get: obj => obj.pause }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _leaseStatus_decorators, { kind: "method", name: "leaseStatus", static: false, private: false, access: { has: obj => "leaseStatus" in obj, get: obj => obj.leaseStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _modelCatalog_decorators, { kind: "method", name: "modelCatalog", static: false, private: false, access: { has: obj => "modelCatalog" in obj, get: obj => obj.modelCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        core = __runInitializers(this, _instanceExtraInitializers);
        hostCtx;
        constructor(ctx, core) {
            super(ctx, SERVICE_KEY, { namespace: REMOTE_NAMESPACE });
            this.core = core;
            this.hostCtx = ctx;
        }
        handshake(input) {
            return this.core.handshake(input);
        }
        saveAck(input) {
            return this.core.saveAck(input);
        }
        pause(input) {
            return this.core.pause(input);
        }
        leaseStatus(input) {
            return this.core.leaseStatus(input);
        }
        /**
         * 只读模型目录。`signal` 是 Gateway 注入的取消信号，位于参数表最后，
         * **不是 wire 参数**（api-gateway README「支持取消的 Remote 方法」）。
         */
        async modelCatalog(signal) {
            return this.core.modelCatalog(this.hostCtx.llm, signal);
        }
    };
})();
export { GameCenterService };
/**
 * 把核心方法装配成 Typert Remote 服务类实例。
 * 协议模块不可用或 Context 缺失时显式抛错，严禁静默失败。
 */
export function defineGameCenterService(core, ctx) {
    if (typeof ctx.effect !== 'function') {
        throw new TypeError('@dsh-gamecenter/host: ctx 缺少 effect 方法，无法装配 Cordis 插件');
    }
    return new GameCenterService(ctx, core);
}
//# sourceMappingURL=game-center-service.js.map