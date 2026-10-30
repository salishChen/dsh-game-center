import { attachWhaleHistory } from './storage/whale-history.js';
import { WhaleWallet, attachWhaleMeter } from './storage/whale-wallet.js';
/**
 * Host 插件入口（DSH Cordis 插件形态）。
 *
 * ## 实装装载形态（只读核实 0.2.1-rc.2 / 332895e0…）
 *
 * 参考同版本内置 Host 插件 `@deepseek-ai/dsh-api-remotes` 与
 * `@deepseek-ai/dsh-host-plugin-inventory`：
 * - `package.json` 的 `main`/`exports["."]` 指向 `lib/index.js`，`type: "module"`；
 * - 模块导出 `apply(ctx)` 与 `inject`（`export { apply, inject }`）；
 * - Host 插件不需要 `dsh.client` 字段（那是 Client bundle 的声明）。
 *
 * ## 本插件注入什么
 *
 * 只注入 `llm`（可选读取模型目录）。**不注入** `typertGateway`：
 * 按 `collectSrcClaims()` 的实现，Gateway 会主动扫描 `ctx.reflect.props` 里的
 * service 并读 `typertRemote.namespace`，因此本服务不需要反向依赖 Gateway，
 * 也不会因为 Gateway 未激活而阻塞装载。
 *
 * ## 不做的事
 *
 * - 不改 DSH 安装目录、不写玩家 profile、不启动替代服务器。
 * - 不在装载时发起任何模型调用（含 `stream()`）；`modelCatalog` 只在被调用时读目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { isMinimalContext } from "./dsh-adapter/context.js";
import { GameCenterCore, defineGameCenterService, } from "./remote/game-center-service.js";
import { resolveHostRuntimeVersions } from "./runtime/host-runtime-version.js";
import { SaveStore, MemorySaveBackend } from "./storage/save-store.js";
import { SqliteSaveBackend } from "./storage/sqlite-save-backend.js";
export * from "./storage/save-store.js";
export * from "./storage/sqlite-save-backend.js";
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
export const inject = ['llm'];
/** 握手未确认扫描间隔（默认 1000ms；与 LEASE_ACK_WINDOW_MS 3000ms 构成 4000ms 硬上界）。 */
export const SCAN_INTERVAL_MS = 1000;
/**
 * 受信宿主 playerId 安全解析。
 *
 * 规则（PM 2026-10-20 硬要求）：
 * 1. 优先从 options.playerId 获取；
 * 2. 其次从宿主上下文 ctx 获取（如 ctx.playerId 或 ctx.user?.id）；
 * 3. 缺失或包含路径穿越字符（'..', '/', '\'）坚决抛错拒启，严禁静默回退 default-player。
 */
export function resolvePlayerId(ctx, options = {}) {
    const candidate = options.playerId;
    if (!candidate || typeof candidate !== 'string' || candidate.trim().length === 0) {
        throw new TypeError('@dsh-gamecenter/host: 缺少必要配置 options.playerId（无法解析受信宿主 playerId，未显式配置），拒绝启动');
    }
    const trimmed = candidate.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
        throw new TypeError(`@dsh-gamecenter/host: 解析到的 playerId 非法或包含路径穿越字符: '${trimmed}'`);
    }
    return trimmed;
}
/**
 * 宿主数据目录安全解析。
 *
 * 规则（PM 2026-10-20 硬要求）：
 * 1. 必须由 options.dataDir 显式配置绝对路径；
 * 2. 缺失或非绝对路径显式抛错拒绝启动；
 * 3. 禁止未核实环境变量盲目猜测真实 profile 路径，禁止落入 cwd。
 */
export function resolveDataDir(options = {}) {
    const dir = options.dataDir;
    if (!dir || typeof dir !== 'string' || dir.trim().length === 0) {
        throw new TypeError('@dsh-gamecenter/host: 缺少必要配置 options.dataDir（必须为绝对路径），未配置可靠数据目录时禁止启动');
    }
    const trimmed = dir.trim();
    if (!path.isAbsolute(trimmed)) {
        throw new TypeError(`@dsh-gamecenter/host: options.dataDir 必须为绝对路径，收到: '${dir}'`);
    }
    return path.resolve(trimmed);
}
/**
 * 运行凭证摘要（**密码学摘要**）。
 *
 * 历史：早期是 `noncrypto-fnv1a64`（无依赖、仅用于"不存原文"）。现在凭证成为
 * **身份认证依据**（`pause`/`saveAck`/`leaseStatus`/`saveCheckpoint` 靠它定位租约），
 * 非密码学摘要在攻击者可控输入下可被碰撞/预映像，**不足以承担认证**，
 * 因此改用 `node:crypto` 的 SHA-256。
 * 只存摘要、不存原文；原文仅在握手响应里下发一次给 Client Bridge。
 */
export function digestToken(token) {
    return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}
/**
 * 生成 32 字节随机运行凭证（base64url）。
 * 必须用 `randomBytes`：`Math.random` 可预测，不能作为能力凭证。
 */
function createToken() {
    return randomBytes(32).toString('base64url');
}
/**
 * 插件主体。返回对外 API 便于探针断言，Cordis 会忽略返回值。
 */
export function apply(ctx, options = {}) {
    if (!isMinimalContext(ctx)) {
        throw new TypeError('@dsh-gamecenter/host: apply() 需要 Cordis Context（缺少 effect）');
    }
    // 1. 受信身份校验（未注入直接抛错拒绝启动）
    const playerId = resolvePlayerId(ctx, options);
    // 2. 存储后端与游戏目录解析
    let saveStore;
    let gameLibraryDir;
    let dataDir;
    if (options.storageBackend) {
        saveStore = new SaveStore(options.storageBackend);
        gameLibraryDir = options.gameLibraryDir ?? (options.dataDir ? path.join(path.resolve(options.dataDir), 'games') : path.join(os.tmpdir(), 'dsh-games-test'));
    }
    else {
        dataDir = resolveDataDir(options);
        fs.mkdirSync(dataDir, { recursive: true });
        gameLibraryDir = options.gameLibraryDir ?? path.join(dataDir, 'games');
        fs.mkdirSync(gameLibraryDir, { recursive: true });
        const sqliteBackend = new SqliteSaveBackend({
            dbPath: path.join(dataDir, 'gamecenter.sqlite'),
        });
        saveStore = new SaveStore(sqliteBackend);
    }
    const core = new GameCenterCore({
        nowMs: options.nowMs ?? (() => Date.now()),
        digestToken,
        createToken,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    });
    const hostCtx = ctx;
    const runningVersions = options.runningVersions !== undefined
        ? options.runningVersions
        : resolveHostRuntimeVersions(process.argv, import.meta.url);
    const service = defineGameCenterService(core, hostCtx, {
        playerId,
        saveStore,
        wallet: new WhaleWallet(dataDir ? path.join(dataDir, 'gamecenter-wallet.sqlite') : ':memory:', playerId),
        gameLibraryDir,
        previewDir: options.previewDir,
        approvals: options.approvals,
        catalogMode: options.catalogMode ?? (options.catalogBaseUrl || process.env.DSH_GAMECENTER_BACKEND_URL || true ? 'remote' : 'github'),
        catalogFixtureEntries: options.catalogFixtureEntries,
        catalogRepo: options.catalogRepo,
        catalogGithubToken: options.catalogGithubToken,
        catalogFetcher: options.catalogFetcher,
        catalogBaseUrl: options.catalogBaseUrl ?? (process.env.DSH_GAMECENTER_BACKEND_URL || 'http://192.168.3.222:18080/v1'),
        rawBaseUrl: options.rawBaseUrl ?? process.env.DSH_GAMECENTER_RAW_BASE,
        reportDownloadFailures: options.reportDownloadFailures,
        installId: options.installId,
        runningVersions,
        allowedMediaHosts: options.allowedMediaHosts,
        mediaFetcher: options.mediaFetcher,
        dnsLookup: options.dnsLookup,
        mediaSecurityVerified: options.mediaSecurityVerified,
    });
    const history = attachWhaleHistory(ctx, service.wallet);
    service.startWalletHistory = history.start;
    const detachMeter = attachWhaleMeter(ctx, service.wallet);
    const scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
    let timer;
    let disposed = false;
    ctx.effect(() => {
        timer = setInterval(() => {
            try {
                core.sweepUnconfirmed();
            }
            catch (e) {
                console.warn('@dsh-gamecenter/host: sweepUnconfirmed failed:', e);
            }
        }, scanIntervalMs);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            const maybeTimer = timer;
            maybeTimer.unref?.();
        }
        return () => {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            if (!disposed) {
                history.dispose();
                detachMeter();
                service.wallet.close();
            }
            disposed = true;
        };
    }, 'gamecenter: host service lifetime');
    return {
        core,
        saveStore,
        service,
        playerId,
        dataDir,
        gameLibraryDir,
        remoteMounted: service !== null,
        scanIntervalMs,
        dispose: () => {
            if (!disposed) {
                history.dispose();
                detachMeter();
                service.wallet.close();
            }
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            disposed = true;
        },
    };
}
//# sourceMappingURL=index.js.map