import type { ApprovedRelease, CatalogMachineEntry } from '@dsh-gamecenter/protocol';
import { GameCenterCore, type GameCenterService, type HttpFetcher } from './remote/game-center-service.ts';
import { SaveStore, type SaveStorageBackend } from './storage/save-store.ts';
export * from './storage/save-store.ts';
export * from './storage/sqlite-save-backend.ts';
/**
 * ## 为什么这里**没有** `import '@dsh-gamecenter/client'`（曾加过，已移除）
 *
 * 我原先以为「Host 产物 import Client 包就能让 Client 的 bundle 被发现」，因此加过一条
 * 裸副作用导入当"发现锚点"。**这个判断是错的**，由测试与发布负责人按源码复刻后证伪，
 * 我重读源码确认：
 *
 * - `locatePkgJson` 第 765 行：
 *   `const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName)`
 *   → `expectedPackageName` **恒等于该 Loader 条目的 name**；
 * - 第 793-809 行 `nearestPackage` 要求 `pkg.name === expectedPackageName`。
 *
 * 所以只有 Loader 条目名本身才是发现依据；Host 是否 import 该包**不影响**发现。
 * Client 必须有自己的 Loader 条目——那两条条目写在 `cordis.patch.yml` 里。
 *
 * 为什么移除而不是保留：
 * 1. 它对发现**无任何作用**（上面已证），留着只能误导后来者；
 * 2. 任何形式的导入（含副作用导入）都会让 Client 的 Host 半在 **Host 启动时被执行一次**，
 *    这是测试与发布负责人指出的真实风险；
 * 3. 它还是 TypeScript 的校验盲区：实测对**仅副作用导入**，tsc 不校验模块能否解析
 *    （值导入报 TS2307，副作用导入 exit 0），所以它连"能解析"都证明不了。
 *
 * `package.json` 仍保留 `@dsh-gamecenter/client` 依赖，但**不是**为了导入，而是作为
 * 解析保险：若真实 Loader 给的 `baseUrl` 落在本包目录而非 profile，则该条目名
 * 仍能经由本包的 `node_modules` 链解析到。这是待 DSH-REAL 验证的**保险**，不是已知必需。
 */
/** Cordis 注入声明：只读模型目录需要 `llm`。 */
export declare const inject: readonly string[];
/** 握手未确认扫描间隔（默认 1000ms；与 LEASE_ACK_WINDOW_MS 3000ms 构成 4000ms 硬上界）。 */
export declare const SCAN_INTERVAL_MS = 1000;
export interface HostPluginOptions {
    /** 显式绝对数据目录路径；必须为绝对路径，未提供且无 storageBackend 时显式抛错拒绝启动 */
    dataDir?: string | undefined;
    /** 受信宿主 playerId；缺失或非法时显式抛错拒绝启动 */
    playerId?: string | undefined;
    /** 游戏安装目录；缺省位于 dataDir/games */
    gameLibraryDir?: string | undefined;
    /** 预览目录路径 */
    previewDir?: string | undefined;
    /** 已审批发布列表 */
    approvals?: readonly ApprovedRelease[] | undefined;
    /** 目录模式，默认 'fixture' */
    catalogMode?: ('github' | 'fixture') | undefined;
    /** 目录 fixture 列表 */
    catalogFixtureEntries?: readonly CatalogMachineEntry[] | undefined;
    /** 租约 TTL 毫秒。 */
    ttlMs?: number | undefined;
    /** 自定义存储后端（测试/对账注入用） */
    storageBackend?: SaveStorageBackend | undefined;
    /** 握手未确认租约扫描周期毫秒，默认 1000ms（SCAN_INTERVAL_MS）。 */
    scanIntervalMs?: number | undefined;
    /** 时间注入函数（测试/对账使用）。 */
    nowMs?: (() => number) | undefined;
    /** 目录仓库所有者与仓库名，默认 salishChen/dsh-game-center-warehouse */
    catalogRepo?: {
        owner: string;
        repo: string;
    } | undefined;
    /** 访问目录仓库的 GitHub Token（可选，缺省为匿名只读） */
    catalogGithubToken?: string | undefined;
    /** 目录 HTTP 请求拉取器（测试/对账注入用） */
    catalogFetcher?: HttpFetcher | undefined;
    /**
     * 远端目录/上报共用 endpoint（契约 §3 条款 14），例如 `https://games.example.com/v1`。
     * 为空 → 远端目录与上报整体静默；设置它才能切到 `catalogMode: 'remote'`。
     */
    catalogBaseUrl?: string | undefined;
    /**
     * 产物下载主机前缀（默认官方 `https://raw.githubusercontent.com`）。
     * 官方 raw 域名在本机线路不可达时，配置成可用镜像前缀，例如
     * `https://ghfast.top/https://raw.githubusercontent.com`（亦可用环境变量
     * `DSH_GAMECENTER_RAW_BASE`）。镜像只搬字节：安装阶段仍在本地重算摘要。
     */
    rawBaseUrl?: string | undefined;
    /** 见 `game-center-service.ts` 的 `reportDownloadFailures`：迁移确认前默认关闭。 */
    reportDownloadFailures?: boolean | undefined;
    /** 装机级 installId；缺省时读/建 `<gameLibraryDir>/.install-id`（用户不可见）。 */
    installId?: string | undefined;
    /** 显式覆盖的运行版本对（测试/对账注入用）；未提供时从 argv[2] 与自身 package.json 解析 */
    runningVersions?: {
        gameCenter: string;
        dsh: string;
    } | null | undefined;
    /** 受控媒体拉取的主机白名单 */
    allowedMediaHosts?: readonly string[] | undefined;
    /** 自定义媒体 HTTP fetcher（测试/对账注入用） */
    mediaFetcher?: ((url: string) => Promise<{
        ok: boolean;
        status: number;
        headers: {
            get(k: string): string | null;
        };
        arrayBuffer(): Promise<ArrayBuffer>;
    }>) | undefined;
    /** 自定义 DNS 解析钩子（测试/对账注入用） */
    dnsLookup?: ((hostname: string) => Promise<{
        address: string;
        family: number;
    }>) | undefined;
    /** 是否开启媒体拉取（默认 false 安全禁用，返回 MEDIA_UNAVAILABLE） */
    mediaSecurityVerified?: boolean | undefined;
}
export interface HostPluginApi {
    readonly core: GameCenterCore;
    readonly saveStore: SaveStore;
    readonly service: GameCenterService;
    readonly playerId: string;
    readonly dataDir?: string | undefined;
    readonly gameLibraryDir: string;
    /** 是否成功实例化 Remote 服务。 */
    readonly remoteMounted: boolean;
    readonly scanIntervalMs: number;
    readonly dispose: () => void;
}
/**
 * 受信宿主 playerId 安全解析。
 *
 * 规则（PM 2026-10-20 硬要求）：
 * 1. 优先从 options.playerId 获取；
 * 2. 其次从宿主上下文 ctx 获取（如 ctx.playerId 或 ctx.user?.id）；
 * 3. 缺失或包含路径穿越字符（'..', '/', '\'）坚决抛错拒启，严禁静默回退 default-player。
 */
export declare function resolvePlayerId(ctx: unknown, options?: HostPluginOptions): string;
/**
 * 宿主数据目录安全解析。
 *
 * 规则（PM 2026-10-20 硬要求）：
 * 1. 必须由 options.dataDir 显式配置绝对路径；
 * 2. 缺失或非绝对路径显式抛错拒绝启动；
 * 3. 禁止未核实环境变量盲目猜测真实 profile 路径，禁止落入 cwd。
 */
export declare function resolveDataDir(options?: HostPluginOptions): string;
/**
 * 运行凭证摘要（**密码学摘要**）。
 *
 * 历史：早期是 `noncrypto-fnv1a64`（无依赖、仅用于"不存原文"）。现在凭证成为
 * **身份认证依据**（`pause`/`saveAck`/`leaseStatus`/`saveCheckpoint` 靠它定位租约），
 * 非密码学摘要在攻击者可控输入下可被碰撞/预映像，**不足以承担认证**，
 * 因此改用 `node:crypto` 的 SHA-256。
 * 只存摘要、不存原文；原文仅在握手响应里下发一次给 Client Bridge。
 */
export declare function digestToken(token: string): string;
/**
 * 插件主体。返回对外 API 便于探针断言，Cordis 会忽略返回值。
 */
export declare function apply(ctx: unknown, options?: HostPluginOptions): HostPluginApi;
