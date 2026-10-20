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
 * | `handshake` | `{runtimeInstanceId, nonce, gameId, gameVersion, sdkVersion, bridgeVersion, saveId}` | `{ok, generation?, runtimeToken?, tokenDigest?, state?, errorCode?, message?}` |
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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { REMOTE_NAMESPACE, SERVICE_KEY } from "../dsh-adapter/protocol.js";
import { LeaseRegistry } from "../runtime/lease.js";
import { readModelCatalog } from "../ai/model-catalog.js";
import { validateCatalogInstallRequest, validateSaveLatestRequest, validateSaveCheckpointRequest, validateGameBundleFiles, validatePreviewBundleRequest, validateAbandonRuntimeRequest, decideCheckpointAdmission, isSafeBundlePath, bundleContentBytes, GAME_PREVIEW_LABEL, GAMECENTER_REMOTE_METHODS, isSaveIdShapeValid, isLaunchTokenShapeValid, LEASE_ACK_WINDOW_MS, } from '@dsh-gamecenter/protocol';
import { listCatalog, prepareInstall, readInstalledBundle, } from '@dsh-gamecenter/catalog';
import { SaveStore } from "../storage/save-store.js";
import { SqliteSaveBackend } from "../storage/sqlite-save-backend.js";
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
    /** 当前注入的时间（毫秒），支持测试受控时间。 */
    nowMs() {
        return this.deps.nowMs();
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
        if (!input || typeof input !== 'object') {
            return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '握手入参必须是对象。' };
        }
        if (input.bridgeVersion !== 1) {
            return { ok: false, errorCode: 'PROTOCOL_INVALID', message: 'bridgeVersion 不受支持。' };
        }
        if (typeof input.runtimeInstanceId !== 'string' ||
            input.runtimeInstanceId.length === 0 ||
            typeof input.gameId !== 'string' ||
            input.gameId.length === 0) {
            return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '缺运行实例或游戏标识。' };
        }
        if (!isLaunchTokenShapeValid(input.launchToken)) {
            return {
                ok: false,
                errorCode: 'PROTOCOL_INVALID',
                message: '缺少或非法的 launchToken：必须是 32~256 位无空白可见 ASCII 的不可猜随机值。',
            };
        }
        // **存档槽位必须由调用方显式给出**（协议 `SAVE_SLOTS`）。
        // 历史缺陷：缺省时回退 `saveId = runtimeInstanceId`，租约槽位每次运行都不同，
        // Client 按固定槽位 `saveLatest` 永远 absent，"关闭保存→重开恢复"结构上不成立。
        // 现在缺失或形状非法一律 PROTOCOL_INVALID，不再隐式拿运行身份当存档身份。
        if (!isSaveIdShapeValid(input.saveId)) {
            return {
                ok: false,
                errorCode: 'PROTOCOL_INVALID',
                message: '缺少或非法的 saveId：握手必须显式指定存档槽位（正式 save-default / 预览 save-preview）。',
            };
        }
        if (this.registry.hasAbandoned(input.runtimeInstanceId)) {
            return {
                ok: false,
                errorCode: 'PROTOCOL_INVALID',
                message: '该运行实例已被主动放弃 (runtime-abandoned)，拒绝握手。',
            };
        }
        const saveId = input.saveId.trim();
        const generation = this.deps.nextGeneration?.(input.gameId, saveId) ?? this.peekGeneration(input.gameId, saveId) + 1;
        const token = this.deps.createToken();
        const acquired = this.registry.acquire({
            gameId: input.gameId,
            saveId,
            ttlMs: this.ttlMs,
            generation,
            runtimeInstanceId: input.runtimeInstanceId,
            tokenDigest: this.deps.digestToken(token),
            launchTokenDigest: this.deps.digestToken(input.launchToken),
            nowMs: this.deps.nowMs(),
        });
        if (!acquired.ok) {
            return { ok: false, errorCode: acquired.code, message: acquired.message };
        }
        // 注意：握手成功只创建 pending 租约，等待客户端首次确认调用，转为 running
        return {
            ok: true,
            generation,
            runtimeToken: token,
            tokenDigest: acquired.lease.tokenDigest,
            state: 'pending',
        };
    }
    /** 进程内代次推进：取该游戏该存档槽位的最大代次，避免进程内回退与不同槽位互相顶高代次。 */
    peekGeneration(gameId, saveId) {
        let max = 0;
        for (const lease of this.registry.all()) {
            if (lease.gameId !== gameId)
                continue;
            if (saveId !== undefined && lease.saveId !== saveId)
                continue;
            if (lease.generation > max)
                max = lease.generation;
        }
        return max;
    }
    abandonRuntime(input) {
        const violations = validateAbandonRuntimeRequest(input);
        if (violations.length > 0) {
            return {
                ok: false,
                errorCode: 'PROTOCOL_INVALID',
                message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
            };
        }
        const launchTokenDigest = this.deps.digestToken(input.launchToken);
        return this.registry.abandonRuntime(input.runtimeInstanceId, launchTokenDigest, this.deps.nowMs());
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
    /**
     * 主动扫描并回收未确认超时的握手租约（T_ack 超时）。
     * 仅回收处于 pending 态且超期的租约；已 running 租约永不误回收。
     */
    sweepUnconfirmed(nowMs) {
        return this.registry.sweepUnconfirmed(nowMs ?? this.nowMs());
    }
}
/** 被 `@Remote` 标记的公开方法名（完全对齐 protocol GAMECENTER_REMOTE_METHODS）。 */
export const REMOTE_METHODS = GAMECENTER_REMOTE_METHODS;
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
    let _catalogList_decorators;
    let _catalogInstall_decorators;
    let _gameBundle_decorators;
    let _saveLatest_decorators;
    let _saveCheckpoint_decorators;
    let _previewList_decorators;
    let _previewBundle_decorators;
    let _abandonRuntime_decorators;
    return class GameCenterService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _handshake_decorators = [Remote];
            _saveAck_decorators = [Remote];
            _pause_decorators = [Remote];
            _leaseStatus_decorators = [Remote];
            _modelCatalog_decorators = [Remote];
            _catalogList_decorators = [Remote];
            _catalogInstall_decorators = [Remote];
            _gameBundle_decorators = [Remote];
            _saveLatest_decorators = [Remote];
            _saveCheckpoint_decorators = [Remote];
            _previewList_decorators = [Remote];
            _previewBundle_decorators = [Remote];
            _abandonRuntime_decorators = [Remote];
            __esDecorate(this, null, _handshake_decorators, { kind: "method", name: "handshake", static: false, private: false, access: { has: obj => "handshake" in obj, get: obj => obj.handshake }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveAck_decorators, { kind: "method", name: "saveAck", static: false, private: false, access: { has: obj => "saveAck" in obj, get: obj => obj.saveAck }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _pause_decorators, { kind: "method", name: "pause", static: false, private: false, access: { has: obj => "pause" in obj, get: obj => obj.pause }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _leaseStatus_decorators, { kind: "method", name: "leaseStatus", static: false, private: false, access: { has: obj => "leaseStatus" in obj, get: obj => obj.leaseStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _modelCatalog_decorators, { kind: "method", name: "modelCatalog", static: false, private: false, access: { has: obj => "modelCatalog" in obj, get: obj => obj.modelCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _catalogList_decorators, { kind: "method", name: "catalogList", static: false, private: false, access: { has: obj => "catalogList" in obj, get: obj => obj.catalogList }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _catalogInstall_decorators, { kind: "method", name: "catalogInstall", static: false, private: false, access: { has: obj => "catalogInstall" in obj, get: obj => obj.catalogInstall }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _gameBundle_decorators, { kind: "method", name: "gameBundle", static: false, private: false, access: { has: obj => "gameBundle" in obj, get: obj => obj.gameBundle }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveLatest_decorators, { kind: "method", name: "saveLatest", static: false, private: false, access: { has: obj => "saveLatest" in obj, get: obj => obj.saveLatest }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveCheckpoint_decorators, { kind: "method", name: "saveCheckpoint", static: false, private: false, access: { has: obj => "saveCheckpoint" in obj, get: obj => obj.saveCheckpoint }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _previewList_decorators, { kind: "method", name: "previewList", static: false, private: false, access: { has: obj => "previewList" in obj, get: obj => obj.previewList }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _previewBundle_decorators, { kind: "method", name: "previewBundle", static: false, private: false, access: { has: obj => "previewBundle" in obj, get: obj => obj.previewBundle }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _abandonRuntime_decorators, { kind: "method", name: "abandonRuntime", static: false, private: false, access: { has: obj => "abandonRuntime" in obj, get: obj => obj.abandonRuntime }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        core = __runInitializers(this, _instanceExtraInitializers);
        hostCtx;
        playerId;
        saveStore;
        gameLibraryDir;
        previewDir;
        approvals;
        catalogMode;
        catalogFixtureEntries;
        constructor(ctx, core, options) {
            super(ctx, SERVICE_KEY, { namespace: REMOTE_NAMESPACE });
            this.core = core;
            this.hostCtx = ctx;
            this.playerId = options.playerId;
            this.saveStore = options.saveStore;
            this.gameLibraryDir = options.gameLibraryDir;
            this.previewDir = options.previewDir;
            this.approvals = options.approvals ?? [];
            this.catalogMode = options.catalogMode ?? 'fixture';
            this.catalogFixtureEntries = options.catalogFixtureEntries ?? [];
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
        async catalogList(input) {
            return listCatalog({
                mode: this.catalogMode,
                approvals: this.approvals,
                gameLibraryDir: this.gameLibraryDir,
                fixtureEntries: this.catalogFixtureEntries,
                refresh: input?.refresh,
            });
        }
        async catalogInstall(input) {
            const violations = validateCatalogInstallRequest(input);
            if (violations.length > 0) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
                };
            }
            const approval = this.approvals.find((a) => a.gameId === input.gameId && a.commit === input.commit);
            if (!approval) {
                return {
                    ok: false,
                    errorCode: 'UNAPPROVED_RELEASE',
                    message: `未找到游戏 ${input.gameId} 对应提交 ${input.commit} 的审批记录`,
                };
            }
            return prepareInstall({
                entry: {
                    schemaVersion: 1,
                    gameId: input.gameId,
                    source: {
                        ref: 'HEAD',
                        repository: approval.repository,
                        commit: input.commit,
                        manifestPath: 'gamecenter.json',
                        manifestDigest: input.manifestDigest,
                        bundleDigest: input.bundleDigest,
                    },
                    title: input.gameId,
                    summary: '',
                    version: '1.0.0',
                },
                approvals: this.approvals,
                gameLibraryDir: this.gameLibraryDir,
                stagingDir: path.join(this.gameLibraryDir, '.staging'),
            });
        }
        async gameBundle(input) {
            if (!input || typeof input !== 'object' || typeof input.gameId !== 'string' || typeof input.commit !== 'string') {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: '入参必须包含非空的 gameId 与 commit',
                };
            }
            return readInstalledBundle({
                gameLibraryDir: this.gameLibraryDir,
                gameId: input.gameId,
                commit: input.commit,
            });
        }
        async saveLatest(input) {
            const violations = validateSaveLatestRequest(input);
            if (violations.length > 0) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
                };
            }
            const readRes = await this.saveStore.readCheckpoint(input.gameId, input.saveId, {
                playerId: this.playerId,
            });
            if (!readRes.ok) {
                if (readRes.message.includes('未找到存档文件')) {
                    return { ok: true, absent: true };
                }
                return {
                    ok: false,
                    errorCode: readRes.code,
                    message: readRes.message,
                };
            }
            return {
                ok: true,
                absent: false,
                gameId: readRes.save.gameId,
                saveId: readRes.save.saveId,
                revision: readRes.save.revision,
                installedCommit: readRes.save.installedCommit,
                state: readRes.save.state,
                elapsedGameMs: readRes.save.elapsedGameMs,
                rngState: readRes.save.rngState,
            };
        }
        async saveCheckpoint(input) {
            const violations = validateSaveCheckpointRequest(input);
            if (violations.length > 0) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
                    retryable: false,
                };
            }
            // 统一走**同一个**身份解析入口 `GameCenterCore.resolveRuntime()`：
            // 早期这里写的是 `this.core.resolveRuntime(...)`，而 `GameCenterCore` 上根本没有该方法
            // （核心只持有 deps），一旦走到这一支就抛 TypeError，被接管的旧实例凭证写入因此
            // 以 PROTOCOL_INVALID（甚至网关层的未预期异常）返回，而不是确定性的 STALE_RUNTIME。
            // 探针 N7e 抓到该缺陷；修复后同一路径返回 STALE_RUNTIME / token-superseded。
            const resolved = this.core.resolveRuntime(input.runtimeToken);
            if (!resolved.ok) {
                return {
                    ok: false,
                    errorCode: resolved.code,
                    message: resolved.message,
                    retryable: false,
                };
            }
            const { lease } = resolved;
            if (typeof input.gameId === 'string' && input.gameId !== lease.gameId) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: '声明的 gameId 与运行凭证不符。',
                    retryable: false,
                };
            }
            if (typeof input.saveId === 'string' && input.saveId !== lease.saveId) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: '声明的 saveId 与运行凭证不符。',
                    retryable: false,
                };
            }
            const currentNowMs = this.core.nowMs();
            const admissionInput = typeof input.generation === 'number'
                ? { generation: input.generation, nowMs: currentNowMs }
                : { nowMs: currentNowMs };
            const admission = decideCheckpointAdmission({
                state: lease.state,
                sealed: lease.sealed,
                generation: lease.generation,
                expiresAtMs: Date.parse(lease.expiresAt),
            }, admissionInput);
            if (!admission.ok) {
                const errorCode = admission.errorCode === 'PAUSED' ? 'STALE_RUNTIME' : admission.errorCode;
                return {
                    ok: false,
                    errorCode,
                    message: admission.message,
                    retryable: false,
                };
            }
            // 暂停期间写保护：绑定单轮授权最终操作，拒绝额外检查点写入（允许同一 operationId 幂等重试）
            if (lease.state === 'pausing') {
                if (lease.authorizedFinalOperationId !== undefined &&
                    lease.authorizedFinalOperationId !== input.operationId) {
                    return {
                        ok: false,
                        errorCode: 'PROTOCOL_INVALID',
                        message: `暂停期间只允许授权的最终检查点操作 (${lease.authorizedFinalOperationId}) 及其幂等重试，拒绝额外写入 (${input.operationId})。`,
                        retryable: false,
                    };
                }
            }
            const writeRes = await this.saveStore.writeCheckpoint({
                playerId: this.playerId,
                gameId: lease.gameId,
                saveId: lease.saveId,
                generation: lease.generation,
                activeGeneration: lease.generation,
                isSealed: lease.sealed,
                installedCommit: input.installedCommit ?? 'e4905dbe4a738a8406b39013292d6a545ab3a356',
                gameStateSchemaVersion: input.gameStateSchemaVersion ?? 1,
                elapsedGameMs: input.elapsedGameMs,
                rngState: input.rngState,
                modelBindings: {},
                state: input.state,
                operationId: input.operationId,
                expectedRevision: input.expectedRevision,
            });
            if (!writeRes.ok) {
                const errRes = {
                    ok: false,
                    errorCode: writeRes.code,
                    message: writeRes.message,
                    retryable: writeRes.code === 'RATE_LIMIT',
                };
                if (typeof writeRes.currentRevision === 'number') {
                    errRes.currentRevision = writeRes.currentRevision;
                }
                return errRes;
            }
            if (lease.state === 'pausing') {
                lease.authorizedFinalOperationId = input.operationId;
            }
            lease.lastPersistedRevision = writeRes.revision;
            return {
                ok: true,
                revision: writeRes.revision,
                idempotentReplay: writeRes.idempotentReplay,
            };
        }
        async previewList() {
            if (!this.previewDir) {
                return { ok: true, configured: false, entries: [] };
            }
            try {
                const stat = await fs.promises.stat(this.previewDir);
                if (!stat.isDirectory()) {
                    return { ok: true, configured: false, entries: [] };
                }
            }
            catch {
                return { ok: true, configured: false, entries: [] };
            }
            const entries = [];
            try {
                const subdirs = await fs.promises.readdir(this.previewDir, { withFileTypes: true });
                for (const sub of subdirs) {
                    if (!sub.isDirectory())
                        continue;
                    const manifestPath = path.join(this.previewDir, sub.name, 'gamecenter.json');
                    try {
                        const raw = await fs.promises.readFile(manifestPath, 'utf-8');
                        const manifest = JSON.parse(raw);
                        entries.push({
                            previewId: sub.name,
                            gameId: manifest.id,
                            name: manifest.name,
                            version: manifest.version,
                            source: 'fixture',
                            label: GAME_PREVIEW_LABEL,
                            installable: false,
                        });
                    }
                    catch {
                        // 跳过无效子目录
                    }
                }
                return { ok: true, configured: true, entries };
            }
            catch (e) {
                return {
                    ok: false,
                    errorCode: 'INTERNAL',
                    message: `读取预览目录失败: ${e instanceof Error ? e.message : String(e)}`,
                };
            }
        }
        async previewBundle(input) {
            if (!this.previewDir) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: '未配置预览目录 previewDir',
                };
            }
            const violations = validatePreviewBundleRequest(input);
            if (violations.length > 0) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
                };
            }
            const targetDir = path.join(this.previewDir, input.previewId);
            let manifest;
            try {
                const raw = await fs.promises.readFile(path.join(targetDir, 'gamecenter.json'), 'utf-8');
                manifest = JSON.parse(raw);
            }
            catch (e) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: `读取预览目录 manifest 失败: ${e instanceof Error ? e.message : String(e)}`,
                };
            }
            const bundleFiles = [];
            const walk = async (dir) => {
                let items;
                try {
                    items = await fs.promises.readdir(dir, { withFileTypes: true });
                }
                catch {
                    return { ok: false, error: `无法读取目录 ${dir}` };
                }
                for (const item of items) {
                    const full = path.join(dir, item.name);
                    if (item.isSymbolicLink()) {
                        return { ok: false, error: `检测到符号链接 ${full}，禁止包含在游戏产物中` };
                    }
                    if (item.isDirectory()) {
                        const subRes = await walk(full);
                        if (!subRes.ok)
                            return subRes;
                    }
                    else if (item.isFile()) {
                        const rel = path.relative(targetDir, full).replace(/\\/g, '/');
                        if (!isSafeBundlePath(rel)) {
                            return { ok: false, error: `文件路径不安全或后缀不在白名单：${rel}` };
                        }
                        const content = await fs.promises.readFile(full, 'utf-8');
                        bundleFiles.push({ path: rel, content });
                    }
                }
                return { ok: true };
            };
            const walkRes = await walk(targetDir);
            if (!walkRes.ok) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: walkRes.error ?? '扫描预览文件失败',
                };
            }
            const fileViolations = validateGameBundleFiles(bundleFiles);
            if (fileViolations.length > 0) {
                return {
                    ok: false,
                    errorCode: 'PROTOCOL_INVALID',
                    message: fileViolations.map((v) => `${v.field}: ${v.reason}`).join('; '),
                };
            }
            let totalBytes = 0;
            for (const f of bundleFiles) {
                totalBytes += bundleContentBytes(f.content);
            }
            return {
                ok: true,
                source: 'fixture',
                previewId: input.previewId,
                gameId: manifest.id,
                version: manifest.version,
                entryPath: manifest.runtime.entry,
                files: bundleFiles,
                totalBytes,
            };
        }
        async abandonRuntime(input) {
            return this.core.abandonRuntime(input);
        }
    };
})();
export { GameCenterService };
/**
 * 把核心方法装配成 Typert Remote 服务类实例。
 * 协议模块不可用或 Context 缺失时显式抛错，严禁静默失败。
 */
export function defineGameCenterService(core, ctx, options = {}) {
    if (typeof ctx.effect !== 'function') {
        throw new TypeError('@dsh-gamecenter/host: ctx 缺少 effect 方法，无法装配 Cordis 插件');
    }
    const fullOptions = {
        playerId: options.playerId ?? 'test-host-player',
        saveStore: options.saveStore ?? new SaveStore(new SqliteSaveBackend({ dbPath: ':memory:' })),
        gameLibraryDir: options.gameLibraryDir ?? path.join(os.tmpdir(), 'dsh-games-test'),
        previewDir: options.previewDir,
        approvals: options.approvals ?? [],
        catalogMode: options.catalogMode ?? 'fixture',
        catalogFixtureEntries: options.catalogFixtureEntries ?? [],
    };
    return new GameCenterService(ctx, core, fullOptions);
}
//# sourceMappingURL=game-center-service.js.map