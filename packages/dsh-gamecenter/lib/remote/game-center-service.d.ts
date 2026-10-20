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
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { LeaseRegistry, type LeaseRecord, type LeaseViolation } from '../runtime/lease.ts';
import { type ModelCatalogResult } from '../ai/model-catalog.ts';
import type { DshLlmLike, MinimalContext } from '../dsh-adapter/context.ts';
import type { CatalogListWireRequest, CatalogListWireResult, CatalogInstallWireRequest, CatalogInstallWireResult, GameBundleWireRequest, GameBundleWireResult, SaveLatestWireRequest, SaveLatestWireResult, SaveCheckpointWireRequest, SaveCheckpointWireResult, PreviewListWireResult, PreviewBundleWireRequest, PreviewBundleWireResult, ApprovedRelease, CatalogMachineEntry, AbandonRuntimeRequest, AbandonRuntimeResult } from '@dsh-gamecenter/protocol';
import { SaveStore } from '../storage/save-store.ts';
/** 服务用到的 Host 上下文（扩展自最小 Context）。 */
export interface GameCenterHostContext extends MinimalContext {
    /** DSH `ctx.llm`；未激活时为 undefined（只读目录会如实返回 available:false）。 */
    llm?: DshLlmLike;
}
export interface GameCenterServiceDeps {
    /** 当前时间注入（测试可控）。 */
    nowMs: () => number;
    /** 租约 TTL。 */
    ttlMs?: number;
    /** 已用最大代次读取（持久层负责；进程内默认按已登记租约推进）。 */
    nextGeneration?: (gameId: string, saveId: string) => number;
    /** 运行凭证摘要函数。 */
    digestToken: (token: string) => string;
    /** 生成一次性 token。 */
    createToken: () => string;
}
export interface HandshakeWireInput {
    runtimeInstanceId: string;
    nonce: string;
    /**
     * 启动令牌 launchToken：Client Bridge 在每次启动时生成的不可猜随机值。
     */
    launchToken: string;
    gameId: string;
    gameVersion: string;
    sdkVersion: string;
    bridgeVersion: number;
    /**
     * **必填**存档槽位（协议 `SAVE_SLOTS`：正式 `save-default`，预览 `save-preview`）。
     *
     * 历史：缺省时 Host 回退 `saveId = runtimeInstanceId`，导致每次运行的存档槽位都不同，
     * Client 的"继续游戏"按固定槽位查永远 `absent`。现在缺失或形状非法即 `PROTOCOL_INVALID`，
     * Host 不再以运行身份隐式充当存档身份。
     */
    saveId: string;
}
export interface HandshakeWireOutput {
    ok: boolean;
    generation?: number;
    /**
     * 运行凭证**原文**，只在握手响应下发一次。
     * 它是本运行实例的能力凭证（不是 DSH 凭据）：作用域限于该租约，
     * 封存或过期即失效，且只能影响它自己的租约。
     * 游戏 iframe **不得**接触它——由 Client Bridge 持有。
     */
    runtimeToken?: string;
    /** 运行凭证摘要，供审计/日志比对；不代表任何授权能力。 */
    tokenDigest?: string;
    state?: string;
    errorCode?: string;
    message?: string;
}
export interface SaveAckWireInput {
    /** 握手时下发的运行凭证原文；**身份由它确定**，不由 gameId/saveId 自报。 */
    runtimeToken: string;
    revision: number;
    /** 可选：声明调用方认为的代次，仅用于检测迟到写入；与凭证不符即 STALE_RUNTIME。 */
    generation?: number;
    /** 可选：声明调用方所属的 gameId，若提供则与租约凭证交叉核验；不符即 PROTOCOL_INVALID。 */
    gameId?: string;
    /** 可选：声明调用方所属的 saveId，若提供则与租约凭证交叉核验；不符即 PROTOCOL_INVALID。 */
    saveId?: string;
}
export interface SaveAckWireOutput {
    accepted: boolean;
    state?: string;
    lastPersistedRevision?: number;
    error?: {
        code: string;
        message: string;
    };
}
export interface PauseWireInput {
    runtimeToken: string;
    reason: string;
    /** 可选：同 saveAck，用于检测迟到的暂停。 */
    generation?: number;
    /** 可选：同 saveAck，交叉核验 gameId。 */
    gameId?: string;
    /** 可选：同 saveAck，交叉核验 saveId。 */
    saveId?: string;
}
export interface PauseWireOutput {
    accepted: boolean;
    state?: string;
    timeoutMs: number;
    error?: {
        code: string;
        message: string;
    };
}
export interface LeaseStatusWireInput {
    /** 只能查询自己凭证对应的租约；不接受伪造。 */
    runtimeToken: string;
    /** 可选：声明调用方所属的 gameId，不符即回 absent。 */
    gameId?: string;
    /** 可选：声明调用方所属的 saveId，不符即回 absent。 */
    saveId?: string;
}
export interface LeaseStatusWireOutput {
    absent?: true;
    state?: string;
    generation?: number;
    expiresAt?: string;
    lastPersistedRevision?: number;
}
/**
 * 服务实现。刻意与装饰器分离：
 * - `GameCenterCore` 是**纯逻辑**，可在 Node 单测里直接调用；
 * - `defineGameCenterService()` 才把 `@Remote` 装上去，需要真实的协议模块。
 */
export declare class GameCenterCore {
    readonly registry: LeaseRegistry;
    /**
     * 暂停超时目标（基线 §8.1 建议 3 秒）。声明为产品目标而非硬承诺，
     * 需以目标 DSH 与游戏引擎实测调整。
     */
    readonly pauseTimeoutMs = 3000;
    private readonly deps;
    constructor(deps: GameCenterServiceDeps);
    private get ttlMs();
    /** 当前注入的时间（毫秒），支持测试受控时间。 */
    nowMs(): number;
    /**
     * 统一的运行身份解析入口。
     *
     * **先判存在、再求摘要**：早期版本直接对入参求摘要，于是空串会得到
     * 「空串的 sha256」——一个合法摘要，令「凭证缺失」永远退化报成
     * 「凭证无效」。现在把存在性检查放在摘要之前，两种原因可区分。
     */
    resolveRuntime(runtimeToken: unknown): {
        ok: true;
        lease: LeaseRecord;
    } | LeaseViolation;
    handshake(input: HandshakeWireInput): HandshakeWireOutput;
    /** 进程内代次推进：取该游戏该存档槽位的最大代次，避免进程内回退与不同槽位互相顶高代次。 */
    peekGeneration(gameId: string, saveId?: string): number;
    abandonRuntime(input: AbandonRuntimeRequest): AbandonRuntimeResult;
    saveAck(input: SaveAckWireInput): SaveAckWireOutput;
    pause(input: PauseWireInput): PauseWireOutput;
    /**
     * 租约状态：**只允许查询自己凭证对应的租约**。
     *
     * 早期版本接受调用方自报的 `{gameId, saveId}`，那会泄露（并放大为可探测）
     * 其他存档的运行元数据；现在身份同样来自凭证。支持可选声明进行交叉核验。
     */
    leaseStatus(input: LeaseStatusWireInput): LeaseStatusWireOutput;
    modelCatalog(llm: DshLlmLike | undefined, signal?: AbortSignal): Promise<ModelCatalogResult>;
    /** 供测试与审计读取内部状态（不跨 wire）。 */
    inspect(gameId?: string): LeaseRecord[];
    /**
     * 主动扫描并回收未确认超时的握手租约（T_ack 超时）。
     * 仅回收处于 pending 态且超期的租约；已 running 租约永不误回收。
     */
    sweepUnconfirmed(nowMs?: number): LeaseRecord[];
}
/** 被 `@Remote` 标记的公开方法名（完全对齐 protocol GAMECENTER_REMOTE_METHODS）。 */
export declare const REMOTE_METHODS: readonly ["handshake", "pause", "saveAck", "leaseStatus", "modelCatalog", "catalogList", "catalogInstall", "gameBundle", "saveLatest", "saveCheckpoint", "previewList", "previewBundle", "abandonRuntime"];
declare const Base: typeof TypertRemoteService;
export interface GameCenterServiceOptions {
    playerId: string;
    saveStore: SaveStore;
    gameLibraryDir: string;
    previewDir?: string | undefined;
    approvals?: readonly ApprovedRelease[] | undefined;
    catalogMode?: ('github' | 'fixture') | undefined;
    catalogFixtureEntries?: readonly CatalogMachineEntry[] | undefined;
}
/**
 * 核心方法装配为 Typert Remote 服务类。
 *
 * 使用 TypeScript 标准装饰器（Stage 3）@Remote 标记公开端点。
 * 运行时由 Gateway 的 collectSrcClaims() 扫描原型方法并在 /api/gameCenter/* 认领端点。
 */
export declare class GameCenterService extends Base {
    readonly core: GameCenterCore;
    private readonly hostCtx;
    readonly playerId: string;
    readonly saveStore: SaveStore;
    readonly gameLibraryDir: string;
    readonly previewDir?: string | undefined;
    readonly approvals: readonly ApprovedRelease[];
    readonly catalogMode: 'github' | 'fixture';
    readonly catalogFixtureEntries: readonly CatalogMachineEntry[];
    constructor(ctx: Context, core: GameCenterCore, options: GameCenterServiceOptions);
    handshake(input: HandshakeWireInput): HandshakeWireOutput;
    saveAck(input: SaveAckWireInput): SaveAckWireOutput;
    pause(input: PauseWireInput): PauseWireOutput;
    leaseStatus(input: LeaseStatusWireInput): LeaseStatusWireOutput;
    /**
     * 只读模型目录。`signal` 是 Gateway 注入的取消信号，位于参数表最后，
     * **不是 wire 参数**（api-gateway README「支持取消的 Remote 方法」）。
     */
    modelCatalog(signal: AbortSignal): Promise<ModelCatalogResult>;
    catalogList(input?: CatalogListWireRequest): Promise<CatalogListWireResult>;
    catalogInstall(input: CatalogInstallWireRequest): Promise<CatalogInstallWireResult>;
    gameBundle(input: GameBundleWireRequest): Promise<GameBundleWireResult>;
    saveLatest(input: SaveLatestWireRequest): Promise<SaveLatestWireResult>;
    saveCheckpoint(input: SaveCheckpointWireRequest): Promise<SaveCheckpointWireResult>;
    previewList(): Promise<PreviewListWireResult>;
    previewBundle(input: PreviewBundleWireRequest): Promise<PreviewBundleWireResult>;
    abandonRuntime(input: AbandonRuntimeRequest): Promise<AbandonRuntimeResult>;
}
/**
 * 把核心方法装配成 Typert Remote 服务类实例。
 * 协议模块不可用或 Context 缺失时显式抛错，严禁静默失败。
 */
export declare function defineGameCenterService(core: GameCenterCore, ctx: GameCenterHostContext, options?: Partial<GameCenterServiceOptions>): GameCenterService;
export {};
