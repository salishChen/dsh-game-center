import type { WalletStatusRequest, WalletStatusResult, WalletActionWireRequest, WalletActionWireResult } from '@dsh-gamecenter/protocol';
import { WhaleWallet } from '../storage/whale-wallet.js';
import { type ArenaActionRequest, type ArenaActionResult } from '@dsh-gamecenter/protocol';
import type { LandlordActionRequest, LandlordActionResult } from '@dsh-gamecenter/protocol';
import type { SetAiBindingRequest, RuntimeControlRequest, SetAiBindingResult, RuntimeControlResult, CancelAiRequest } from '@dsh-gamecenter/protocol';
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { LeaseRegistry, type LeaseRecord, type LeaseViolation } from '../runtime/lease.ts';
import { type ModelCatalogResult } from '../ai/model-catalog.ts';
import type { DshLlmLike, MinimalContext } from '../dsh-adapter/context.ts';
import type { CatalogListWireRequest, CatalogListWireResult, CatalogInstallWireRequest, CatalogInstallWireResult, CatalogUninstallWireRequest, CatalogUninstallWireResult, GameBundleWireRequest, GameBundleWireResult, SaveLatestWireRequest, SaveLatestWireResult, SaveCheckpointWireRequest, SaveCheckpointWireResult, PreviewListWireResult, PreviewBundleWireRequest, PreviewBundleWireResult, ApprovedRelease, CatalogMachineEntry, GameManifestV1, AbandonRuntimeRequest, AbandonRuntimeResult, RuntimeVersionObservation, MediaFetchRequest, MediaFetchResult, AiGenerateWireRequest, AiGenerateWireResult } from '@dsh-gamecenter/protocol';
import { type HttpFetcher, type InstallSourceFile } from '@dsh-gamecenter/catalog';
export { listCatalog, prepareInstall, uninstallGamePackage, readInstalledBundle, calculateManifestDigest, calculateBundleDigest, verifyManifestDigest, verifyBundleDigest, type HttpFetcher, type InstallSourceFile, } from '@dsh-gamecenter/catalog';
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
    commit?: string;
    previewId?: string;
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
    saveAck(input: SaveAckWireInput, manifest?: GameManifestV1 | null): SaveAckWireOutput;
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
export declare const REMOTE_METHODS: readonly ["handshake", "pause", "saveAck", "leaseStatus", "modelCatalog", "catalogList", "catalogInstall", "catalogUninstall", "gameBundle", "saveLatest", "saveCheckpoint", "previewList", "previewBundle", "abandonRuntime", "mediaFetch", "aiGenerate", "walletStatus", "walletAction", "setAiBinding", "suspendRuntime", "resumeRuntime", "cancelAi", "landlordAction", "arenaAction"];
declare const Base: typeof TypertRemoteService;
export declare const DEFAULT_ALLOWED_MEDIA_HOSTS: readonly string[];
export type MediaHttpFetcher = (url: string, options?: {
    signal?: AbortSignal | null | undefined;
    redirect?: 'manual' | 'follow' | undefined;
    credentials?: 'omit' | undefined;
}) => Promise<{
    ok: boolean;
    status: number;
    url?: string;
    headers: {
        get(key: string): string | null;
    };
    body?: ReadableStream<Uint8Array> | null;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;
export declare const DEFAULT_CATALOG_REPO: {
    readonly owner: "salishChen";
    readonly repo: "dsh-game-center-warehouse";
};
export interface FetchCommitArtifactsOptions {
    repository: string;
    commit: string;
    fetcher?: HttpFetcher | undefined;
    token?: string | undefined;
    timeoutMs?: number | undefined;
    maxSingleFileBytes?: number | undefined;
    maxTotalBytes?: number | undefined;
    /**
     * 产物主机前缀，默认 `https://raw.githubusercontent.com`。
     * 用于换成可用镜像（例如 `https://ghfast.top/https://raw.githubusercontent.com`）；
     * 镜像不被信任，安装阶段仍会本地重算 manifestDigest / bundleDigest。
     */
    rawBase?: string | undefined;
}
export interface FetchCommitArtifactsResult {
    ok: boolean;
    errorCode?: string;
    message?: string;
    /** §11.8/§11.9 的结构化失败诊断（只在传输类失败时存在），供上报 `download-fail` 使用。 */
    detail?: unknown;
    bundledSource?: {
        manifestContent: string;
        files: readonly InstallSourceFile[];
    };
}
/**
 * 单个产物的下载**总时限**（毫秒），可被 `options.timeoutMs` 覆盖。
 *
 * 只作兜底：真正的"卡住"由直连通道的空闲超时判定（见 `direct-http.ts`）。
 * 15 秒的旧默认值对 14 MB 的包等于要求 0.94 MB/s 起步，慢链路必然失败。
 */
export declare const ARTIFACT_TOTAL_TIMEOUT_MS = 300000;
/** 官方产物主机；配置了 `rawBase` / `DSH_GAMECENTER_RAW_BASE` 时可换成可用镜像前缀。 */
export declare const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com";
/**
 * 归一化产物主机前缀（`rawBase`）。
 *
 * 背景（2026-10-29 实测）：`raw.githubusercontent.com` 在部分线路上**完全连不通**
 * （20 秒拿不到响应头，换超时无用），而镜像前缀
 * `https://ghfast.top/https://raw.githubusercontent.com` 13.7 秒下完 14 MB 且逐字节一致。
 * 因此把主机做成配置项，默认仍走官方域名。
 *
 * 只接受 http/https、必须有主机名、不得携带用户名密码 —— 这个值来自本机配置，
 * 但一旦被写坏就会变成任意 URL 拼装，所以仍然白名单式校验。
 * 镜像**不被信任**：它只负责搬字节，`prepareInstall` 会在本地重算两个摘要，
 * 内容被改一个字节就装不进去。
 */
export declare function normalizeRawBase(value: string | undefined): {
    ok: true;
    base: string;
} | {
    ok: false;
    message: string;
};
export declare function fetchCommitArtifacts(options: FetchCommitArtifactsOptions): Promise<FetchCommitArtifactsResult>;
/**
 * §11.9 开关的取值口径。
 *
 * 只认 `1` 会让 `true`/`yes` 变成**静默不生效**：设了、重启了、验收清单也勾了，
 * 而插件仍按关闭运行 —— 与"动作做了、作用对象不对"是同一类假通过。
 * 这里接受常见真值写法，其余一律视为关闭（未知值不该被猜成开启）。
 */
/**
 * @internal 仅供探针读取，非对外 API（见 `.botharness/report-flag-probe/probe.mjs`）。
 *
 * 导出是为了让第 ③ 步验的是**编译产物里的真实解析**，而不是脚本里复刻一遍逻辑。
 * 它不经 `packages/dsh-gamecenter/src/index.ts` 再导出，因此不在插件公开面上；
 * 请勿从 index 导出它，也不要把它当成配置读取入口。
 */
export declare function readReportDownloadFailEnv(): boolean;
export interface GameCenterServiceOptions {
    wallet?: WhaleWallet | undefined;
    playerId: string;
    saveStore: SaveStore;
    gameLibraryDir: string;
    previewDir?: string | undefined;
    approvals?: readonly ApprovedRelease[] | undefined;
    catalogMode?: ('github' | 'fixture' | 'remote') | undefined;
    catalogFixtureEntries?: readonly CatalogMachineEntry[] | undefined;
    catalogRepo?: {
        owner: string;
        repo: string;
    } | undefined;
    /**
     * 远端目录/上报共用的 endpoint（契约 §3 条款 14）。
     * 为空时远端目录与上报一起整体静默，不重试、不排队。
     */
    catalogBaseUrl?: string | undefined;
    /**
     * 产物下载主机前缀（默认 `https://raw.githubusercontent.com`）。
     * 官方 raw 域名在某些线路不可达时，配置成可用镜像前缀即可，例如
     * `https://ghfast.top/https://raw.githubusercontent.com`。
     * 镜像不被信任：安装阶段仍在本地重算 manifestDigest / bundleDigest。
     */
    rawBaseUrl?: string | undefined;
    /**
     * §11.9 `download-fail` 上报开关，**默认关闭**。
     * 后台 `report_events.kind` 是 ENUM 列，`006` 迁移（扩值 + detail 列）应用并经项目管理确认前，
     * 客户端只发旧三个 kind，否则上报会被 ENUM 拒收。见 docs/gamecenter-admin-backend.md §11.10。
     */
    reportDownloadFailures?: boolean | undefined;
    /** 装机级 installId；缺省时按 `<gameLibraryDir>/.install-id` 读取或首次生成。 */
    installId?: string | undefined;
    catalogGithubToken?: string | undefined;
    catalogFetcher?: HttpFetcher | undefined;
    runningVersions?: {
        gameCenter: string;
        dsh: string;
    } | null | undefined;
    dshObservation?: RuntimeVersionObservation | null | undefined;
    gameCenterObservation?: RuntimeVersionObservation | null | undefined;
    allowedMediaHosts?: readonly string[] | undefined;
    mediaFetcher?: MediaHttpFetcher | undefined;
    dnsLookup?: ((hostname: string) => Promise<{
        address: string;
        family: number;
    }>) | undefined;
    mediaSecurityVerified?: boolean | undefined;
    manifestResolver?: ((gameId: string, commit?: string) => Promise<GameManifestV1 | null>) | undefined;
    aiBroker?: ((slot: string, input: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;
}
export declare function isPrivateOrLoopbackIp(ip: string): boolean;
export declare class GameCenterService extends Base {
    readonly core: GameCenterCore;
    private readonly hostCtx;
    readonly playerId: string;
    startWalletHistory: (() => void) | undefined;
    readonly wallet: WhaleWallet;
    readonly saveStore: SaveStore;
    readonly gameLibraryDir: string;
    readonly previewDir?: string | undefined;
    readonly approvals: ApprovedRelease[];
    readonly catalogMode: 'github' | 'fixture' | 'remote';
    readonly catalogFixtureEntries: readonly CatalogMachineEntry[];
    readonly runningVersions?: {
        gameCenter: string;
        dsh: string;
    } | null | undefined;
    readonly dshObservation?: RuntimeVersionObservation | null | undefined;
    readonly gameCenterObservation?: RuntimeVersionObservation | null | undefined;
    readonly allowedMediaHosts: readonly string[];
    readonly mediaFetcher?: MediaHttpFetcher | undefined;
    readonly dnsLookup?: ((hostname: string) => Promise<{
        address: string;
        family: number;
    }>) | undefined;
    readonly mediaSecurityVerified: boolean;
    readonly catalogRepo: {
        owner: string;
        repo: string;
    };
    readonly catalogGithubToken?: string | undefined;
    readonly catalogFetcher?: HttpFetcher | undefined;
    readonly manifestResolver?: ((gameId: string, commit?: string) => Promise<GameManifestV1 | null>) | undefined;
    readonly aiBroker?: ((slot: string, input: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;
    readonly catalogBaseUrl?: string | undefined;
    readonly rawBaseUrl?: string | undefined;
    readonly reportDownloadFailures: boolean;
    readonly installId?: string | undefined;
    private reportClientPromise?;
    private remoteCatalogProvider?;
    /**
     * 后台/制品下载专用 fetcher：**先直连**（`node:http`/`node:https`，不读代理环境变量），
     * 直连不通才回退到全局 `fetch`（那条会套 `HTTP_PROXY`）。原因见 `remote/direct-http.ts`
     * 文件头：`NO_PROXY` 里的 CIDR 不被 undici 解析，内网后台曾被推给死代理，
     * `fetch failed` 又被吞成「未找到审批记录」。
     */
    private readonly resilientFetcher;
    private readonly aiBindings;
    private readonly landlordTables;
    private readonly arenaModes;
    private readonly arenaModeOperations;
    private readonly runtimeTargets;
    private readonly aiOperations;
    private readonly inFlightAiOperations;
    private readonly inFlightAiByRuntimeInstance;
    private abortInFlightAi;
    constructor(ctx: Context, core: GameCenterCore, options: GameCenterServiceOptions);
    /**
     * 懒初始化上报客户端：endpoint 为空 → `undefined`，远端目录与上报整体静默。
     * `installId` 首次启用时生成并本地持久化；用户看不到，也不进 UI/iframe。
     */
    private getReportClient;
    walletStatus(input: WalletStatusRequest): WalletStatusResult;
    walletAction(input: WalletActionWireRequest): Promise<WalletActionWireResult>;
    handshake(input: HandshakeWireInput): HandshakeWireOutput;
    private runtimeManifest;
    arenaAction(input: ArenaActionRequest): Promise<ArenaActionResult>;
    setAiBinding(input: SetAiBindingRequest): Promise<SetAiBindingResult>;
    landlordAction(input: LandlordActionRequest, signal?: AbortSignal): Promise<LandlordActionResult>;
    suspendRuntime(input: RuntimeControlRequest): RuntimeControlResult;
    resumeRuntime(input: RuntimeControlRequest): RuntimeControlResult;
    cancelAi(input: CancelAiRequest): {
        ok: boolean;
    };
    saveAck(input: SaveAckWireInput): Promise<SaveAckWireOutput>;
    pause(input: PauseWireInput): PauseWireOutput;
    leaseStatus(input: LeaseStatusWireInput): LeaseStatusWireOutput;
    /**
     * 只读模型目录。`signal` 是 Gateway 注入的取消信号，位于参数表最后，
     * **不是 wire 参数**（api-gateway README「支持取消的 Remote 方法」）。
     */
    modelCatalog(signal: AbortSignal): Promise<ModelCatalogResult>;
    catalogList(input?: CatalogListWireRequest): Promise<CatalogListWireResult>;
    catalogInstall(input: CatalogInstallWireRequest): Promise<CatalogInstallWireResult>;
    catalogUninstall(input: CatalogUninstallWireRequest): Promise<CatalogUninstallWireResult>;
    gameBundle(input: GameBundleWireRequest): Promise<GameBundleWireResult>;
    private getRunningVersions;
    private resolveGameManifest;
    saveLatest(input: SaveLatestWireRequest): Promise<SaveLatestWireResult>;
    saveCheckpoint(input: SaveCheckpointWireRequest): Promise<SaveCheckpointWireResult>;
    previewList(): Promise<PreviewListWireResult>;
    previewBundle(input: PreviewBundleWireRequest): Promise<PreviewBundleWireResult>;
    abandonRuntime(input: AbandonRuntimeRequest): Promise<AbandonRuntimeResult>;
    mediaFetch(input: MediaFetchRequest): Promise<MediaFetchResult>;
    aiGenerate(input: AiGenerateWireRequest, signal?: AbortSignal): Promise<AiGenerateWireResult>;
}
/**
 * 把核心方法装配成 Typert Remote 服务类实例。
 * 协议模块不可用或 Context 缺失时显式抛错，严禁静默失败。
 */
export declare function defineGameCenterService(core: GameCenterCore, ctx: GameCenterHostContext, options?: Partial<GameCenterServiceOptions>): GameCenterService;
