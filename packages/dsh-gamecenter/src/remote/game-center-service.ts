import type {WalletStatusRequest,WalletStatusResult,WalletActionWireRequest,WalletActionWireResult} from '@dsh-gamecenter/protocol'
import {WhaleWallet,hasWhaleWallet} from '../storage/whale-wallet.js'
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

import { generateBoard } from '../ai/board-broker.ts'
import {generateArenaBuild,arenaBuildPrompt,arenaReviewTraces} from '../ai/arena-broker.js'
import {ARENA_DUEL_BUDGET,quoteArenaPlan,type ArenaActionRequest,type ArenaActionResult,type ArenaAiTrace,type ArenaPlan,type ArenaPreviousRound,type ArenaRoundResult} from '@dsh-gamecenter/protocol'
import {summarizeCalls, type LandlordCallTrace} from '../games/landlord-review.js'
import {generateLandlordDecision} from '../ai/landlord-broker.js'
import type {LandlordActionRequest,LandlordActionResult} from '@dsh-gamecenter/protocol'
import {createLandlordGame, applyLandlordAction, landlordSeatView, localLandlordDecision, type LandlordState, type Seat} from '../games/landlord-engine.js'
import type { AiModelBinding, SetAiBindingRequest, RuntimeControlRequest, SetAiBindingResult, RuntimeControlResult, CancelAiRequest } from '@dsh-gamecenter/protocol'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dns from 'node:dns/promises'
import { Buffer } from 'node:buffer'
import { createHash,randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_NAMESPACE, SERVICE_KEY } from '../dsh-adapter/protocol.ts'
import { LeaseRegistry, type LeaseRecord, type LeaseViolation } from '../runtime/lease.ts'
import { readModelCatalog, type ModelCatalogResult } from '../ai/model-catalog.ts'
import type {
  DshLlmLike,
  MinimalContext,
  TypertRemoteServiceLike,
} from '../dsh-adapter/context.ts'
import type {
  CatalogListWireRequest,
  CatalogListWireResult,
  CatalogInstallWireRequest,
  CatalogInstallWireResult,
  CatalogUninstallWireRequest,
  CatalogUninstallWireResult,
  GameBundleWireRequest,
  GameBundleWireResult,
  GameBundleWireFile,
  SaveLatestWireRequest,
  SaveLatestWireResult,
  SaveCheckpointWireRequest,
  SaveCheckpointWireResult,
  PreviewListWireEntry,
  PreviewListWireResult,
  PreviewBundleWireRequest,
  PreviewBundleWireResult,
  ApprovedRelease,
  CatalogMachineEntry,
  GameManifestV1,
  AbandonRuntimeRequest,
  AbandonRuntimeResult,
  RuntimeVersionObservation,
  MediaFetchRequest,
  MediaFetchResult,
  MediaMime,
  AiGenerateWireRequest,
  AiGenerateWireResult,
} from '@dsh-gamecenter/protocol'
import {
  resolveRunningVersions,
  validateCatalogInstallRequest,
  validateCatalogUninstallRequest,
  validateSaveLatestRequest,
  validateSaveCheckpointRequest,
  validateGameBundleFiles,
  validatePreviewBundleRequest,
  validateAbandonRuntimeRequest,
  validateMediaFetchRequest,
  validateAiGenerateRequest,
  decideCheckpointAdmission,
  isSafeBundlePath,
  isSafeRelativePath,
  bundleContentBytes,
  GAME_BUNDLE_MAX_FILE_BYTES,
  GAME_BUNDLE_MAX_TOTAL_BYTES,
  GAME_PREVIEW_LABEL,
  GAMECENTER_REMOTE_METHODS,
  isSaveIdShapeValid,
  isLaunchTokenShapeValid,
  LEASE_ACK_WINDOW_MS,
  evaluateCompatibility,
  sdkRangeAccepts,
  hasSaveCapability,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_BYTES_PER_IMAGE,
  MEDIA_MAX_EDGE_PX,
  MEDIA_ALLOWED_MIMES,
  isAllowedMediaUrl,
} from '@dsh-gamecenter/protocol'
import {
  listCatalog,
  prepareInstall,
  readInstalledBundle,
  calculateManifestDigest,
  calculateBundleDigest,
  verifyManifestDigest,
  verifyBundleDigest,
  readOrCreateInstallId,
  RemoteReportClient,
  RemoteCatalogProvider,
  FileCatalogCacheStore,
  uninstallGamePackage,
  type HttpFetcher,
  type InstallSourceFile,
} from '@dsh-gamecenter/catalog'
export {
  listCatalog,
  prepareInstall,
  uninstallGamePackage,
  readInstalledBundle,
  calculateManifestDigest,
  calculateBundleDigest,
  verifyManifestDigest,
  verifyBundleDigest,
  type HttpFetcher,
  type InstallSourceFile,
} from '@dsh-gamecenter/catalog'
import { createResilientFetcher, describeFetchError } from './direct-http.js'
import { SaveStore } from '../storage/save-store.ts'
import { SqliteSaveBackend } from '../storage/sqlite-save-backend.ts'

/** 服务用到的 Host 上下文（扩展自最小 Context）。 */
export interface GameCenterHostContext extends MinimalContext {
  /** DSH `ctx.llm`；未激活时为 undefined（只读目录会如实返回 available:false）。 */
  llm?: DshLlmLike
}

export interface GameCenterServiceDeps {
  /** 当前时间注入（测试可控）。 */
  nowMs: () => number
  /** 租约 TTL。 */
  ttlMs?: number
  /** 已用最大代次读取（持久层负责；进程内默认按已登记租约推进）。 */
  nextGeneration?: (gameId: string, saveId: string) => number
  /** 运行凭证摘要函数。 */
  digestToken: (token: string) => string
  /** 生成一次性 token。 */
  createToken: () => string
}

export interface HandshakeWireInput {
  commit?: string
  previewId?: string
  runtimeInstanceId: string
  nonce: string
  /**
   * 启动令牌 launchToken：Client Bridge 在每次启动时生成的不可猜随机值。
   */
  launchToken: string
  gameId: string
  gameVersion: string
  sdkVersion: string
  bridgeVersion: number
  /**
   * **必填**存档槽位（协议 `SAVE_SLOTS`：正式 `save-default`，预览 `save-preview`）。
   *
   * 历史：缺省时 Host 回退 `saveId = runtimeInstanceId`，导致每次运行的存档槽位都不同，
   * Client 的"继续游戏"按固定槽位查永远 `absent`。现在缺失或形状非法即 `PROTOCOL_INVALID`，
   * Host 不再以运行身份隐式充当存档身份。
   */
  saveId: string
}

export interface HandshakeWireOutput {
  ok: boolean
  generation?: number
  /**
   * 运行凭证**原文**，只在握手响应下发一次。
   * 它是本运行实例的能力凭证（不是 DSH 凭据）：作用域限于该租约，
   * 封存或过期即失效，且只能影响它自己的租约。
   * 游戏 iframe **不得**接触它——由 Client Bridge 持有。
   */
  runtimeToken?: string
  /** 运行凭证摘要，供审计/日志比对；不代表任何授权能力。 */
  tokenDigest?: string
  state?: string
  errorCode?: string
  message?: string
}

export interface SaveAckWireInput {
  /** 握手时下发的运行凭证原文；**身份由它确定**，不由 gameId/saveId 自报。 */
  runtimeToken: string
  revision: number
  /** 可选：声明调用方认为的代次，仅用于检测迟到写入；与凭证不符即 STALE_RUNTIME。 */
  generation?: number
  /** 可选：声明调用方所属的 gameId，若提供则与租约凭证交叉核验；不符即 PROTOCOL_INVALID。 */
  gameId?: string
  /** 可选：声明调用方所属的 saveId，若提供则与租约凭证交叉核验；不符即 PROTOCOL_INVALID。 */
  saveId?: string
}

export interface SaveAckWireOutput {
  accepted: boolean
  state?: string
  lastPersistedRevision?: number
  error?: { code: string; message: string }
}

export interface PauseWireInput {
  runtimeToken: string
  reason: string
  /** 可选：同 saveAck，用于检测迟到的暂停。 */
  generation?: number
  /** 可选：同 saveAck，交叉核验 gameId。 */
  gameId?: string
  /** 可选：同 saveAck，交叉核验 saveId。 */
  saveId?: string
}

export interface PauseWireOutput {
  accepted: boolean
  state?: string
  timeoutMs: number
  error?: { code: string; message: string }
}

export interface LeaseStatusWireInput {
  /** 只能查询自己凭证对应的租约；不接受伪造。 */
  runtimeToken: string
  /** 可选：声明调用方所属的 gameId，不符即回 absent。 */
  gameId?: string
  /** 可选：声明调用方所属的 saveId，不符即回 absent。 */
  saveId?: string
}

export interface LeaseStatusWireOutput {
  absent?: true
  state?: string
  generation?: number
  expiresAt?: string
  lastPersistedRevision?: number
}

/**
 * 服务实现。刻意与装饰器分离：
 * - `GameCenterCore` 是**纯逻辑**，可在 Node 单测里直接调用；
 * - `defineGameCenterService()` 才把 `@Remote` 装上去，需要真实的协议模块。
 */
export class GameCenterCore {
  readonly registry = new LeaseRegistry()
  /**
   * 暂停超时目标（基线 §8.1 建议 3 秒）。声明为产品目标而非硬承诺，
   * 需以目标 DSH 与游戏引擎实测调整。
   */
  readonly pauseTimeoutMs = 3000
  private readonly deps: GameCenterServiceDeps

  constructor(deps: GameCenterServiceDeps) {
    this.deps = deps
  }

  private get ttlMs(): number {
    return this.deps.ttlMs ?? 30_000
  }

  /** 当前注入的时间（毫秒），支持测试受控时间。 */
  nowMs(): number {
    return this.deps.nowMs()
  }

  /**
   * 统一的运行身份解析入口。
   *
   * **先判存在、再求摘要**：早期版本直接对入参求摘要，于是空串会得到
   * 「空串的 sha256」——一个合法摘要，令「凭证缺失」永远退化报成
   * 「凭证无效」。现在把存在性检查放在摘要之前，两种原因可区分。
   */
  resolveRuntime(runtimeToken: unknown): { ok: true; lease: LeaseRecord } | LeaseViolation {
    if (typeof runtimeToken !== 'string' || runtimeToken.length === 0) {
      return {
        ok: false,
        code: 'PROTOCOL_INVALID',
        message: '缺少运行凭证。',
        details: { reason: 'credential-missing' },
      }
    }
    return this.registry.resolveByToken(this.deps.digestToken(runtimeToken), this.deps.nowMs())
  }

  handshake(input: HandshakeWireInput): HandshakeWireOutput {
    if (!input || typeof input !== 'object') {
      return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '握手入参必须是对象。' }
    }
    if (input.bridgeVersion !== 1) {
      return { ok: false, errorCode: 'PROTOCOL_INVALID', message: 'bridgeVersion 不受支持。' }
    }
    if (
      typeof input.runtimeInstanceId !== 'string' ||
      input.runtimeInstanceId.length === 0 ||
      typeof input.gameId !== 'string' ||
      input.gameId.length === 0
    ) {
      return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '缺运行实例或游戏标识。' }
    }
    if (!isLaunchTokenShapeValid(input.launchToken)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '缺少或非法的 launchToken：必须是 32~256 位无空白可见 ASCII 的不可猜随机值。',
      }
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
      }
    }
    if (this.registry.hasAbandoned(input.runtimeInstanceId)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '该运行实例已被主动放弃 (runtime-abandoned)，拒绝握手。',
      }
    }
    const saveId = input.saveId.trim()
    const generation = this.deps.nextGeneration?.(input.gameId, saveId) ?? this.peekGeneration(input.gameId, saveId) + 1
    const token = this.deps.createToken()
    const acquired = this.registry.acquire({
      gameId: input.gameId,
      saveId,
      ttlMs: this.ttlMs,
      generation,
      runtimeInstanceId: input.runtimeInstanceId,
      tokenDigest: this.deps.digestToken(token),
      launchTokenDigest: this.deps.digestToken(input.launchToken),
      nowMs: this.deps.nowMs(),
    })
    if (!acquired.ok) {
      return { ok: false, errorCode: acquired.code, message: acquired.message }
    }
    // 注意：握手成功只创建 pending 租约，等待客户端首次确认调用，转为 running
    return {
      ok: true,
      generation,
      runtimeToken: token,
      tokenDigest: acquired.lease.tokenDigest,
      state: 'pending',
    }
  }

  /** 进程内代次推进：取该游戏该存档槽位的最大代次，避免进程内回退与不同槽位互相顶高代次。 */
  peekGeneration(gameId: string, saveId?: string): number {
    let max = 0
    for (const lease of this.registry.all()) {
      if (lease.gameId !== gameId) continue
      if (saveId !== undefined && lease.saveId !== saveId) continue
      if (lease.generation > max) max = lease.generation
    }
    return max
  }

  abandonRuntime(input: AbandonRuntimeRequest): AbandonRuntimeResult {
    const violations = validateAbandonRuntimeRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }
    const launchTokenDigest = this.deps.digestToken(input.launchToken)
    return this.registry.abandonRuntime(input.runtimeInstanceId, launchTokenDigest, this.deps.nowMs())
  }

  saveAck(input: SaveAckWireInput, manifest?: GameManifestV1 | null): SaveAckWireOutput {
    // **身份绑定**：先用调用方持有的运行凭证解析出租约，`gameId`/`saveId` 一律取自租约。
    const resolved = this.resolveRuntime(input.runtimeToken)
    if (!resolved.ok) {
      return { accepted: false, error: { code: resolved.code, message: resolved.message } }
    }
    const { lease } = resolved
    if (manifest !== undefined && manifest !== null && !hasSaveCapability(manifest)) {
      return {
        accepted: false,
        state: lease.state,
        lastPersistedRevision: lease.lastPersistedRevision,
        error: { code: 'SAVE_UNSUPPORTED', message: '游戏未声明存档能力' },
      }
    }
    if (typeof input.gameId === 'string' && input.gameId !== lease.gameId) {
      return {
        accepted: false,
        state: lease.state,
        lastPersistedRevision: lease.lastPersistedRevision,
        error: { code: 'PROTOCOL_INVALID', message: '声明的 gameId 与运行凭证不符。' },
      }
    }
    if (typeof input.saveId === 'string' && input.saveId !== lease.saveId) {
      return {
        accepted: false,
        state: lease.state,
        lastPersistedRevision: lease.lastPersistedRevision,
        error: { code: 'PROTOCOL_INVALID', message: '声明的 saveId 与运行凭证不符。' },
      }
    }
    // 代次由调用方声明只为**检测迟到写入**；真正的身份来自凭证，不来自代次。
    if (typeof input.generation === 'number' && input.generation !== lease.generation) {
      return {
        accepted: false,
        state: lease.state,
        lastPersistedRevision: lease.lastPersistedRevision,
        error: { code: 'STALE_RUNTIME', message: '保存确认携带的运行代次与凭证不符。' },
      }
    }
    const confirmed = this.registry.confirmPause(lease.gameId, lease.saveId, lease.generation, input.revision)
    const current = this.registry.get(lease.gameId, lease.saveId)
    const currentFields = current === undefined
      ? {}
      : { state: current.state, lastPersistedRevision: current.lastPersistedRevision }
    if (!confirmed.ok) {
      return {
        accepted: false,
        ...currentFields,
        error: { code: confirmed.code, message: confirmed.message },
      }
    }
    return { accepted: true, ...currentFields }
  }

  pause(input: PauseWireInput): PauseWireOutput {
    // **身份绑定**：同 saveAck，先按凭证解析；`gameId`/`saveId` 取自租约。
    const resolved = this.resolveRuntime(input.runtimeToken)
    if (!resolved.ok) {
      return {
        accepted: false,
        timeoutMs: this.pauseTimeoutMs,
        error: { code: resolved.code, message: resolved.message },
      }
    }
    const { lease } = resolved
    if (typeof input.gameId === 'string' && input.gameId !== lease.gameId) {
      return {
        accepted: false,
        timeoutMs: this.pauseTimeoutMs,
        error: { code: 'PROTOCOL_INVALID', message: '声明的 gameId 与运行凭证不符。' },
      }
    }
    if (typeof input.saveId === 'string' && input.saveId !== lease.saveId) {
      return {
        accepted: false,
        timeoutMs: this.pauseTimeoutMs,
        error: { code: 'PROTOCOL_INVALID', message: '声明的 saveId 与运行凭证不符。' },
      }
    }
    if (typeof input.generation === 'number' && input.generation !== lease.generation) {
      return {
        accepted: false,
        timeoutMs: this.pauseTimeoutMs,
        error: { code: 'STALE_RUNTIME', message: '暂停请求携带的运行代次与凭证不符。' },
      }
    }
    const begun = this.registry.beginPause(lease.gameId, lease.saveId, lease.generation)
    if (!begun.ok) {
      return {
        accepted: false,
        timeoutMs: this.pauseTimeoutMs,
        error: { code: begun.code, message: begun.message },
      }
    }
    const after = this.registry.get(lease.gameId, lease.saveId)
    return {
      accepted: true,
      ...(after === undefined ? {} : { state: after.state }),
      timeoutMs: this.pauseTimeoutMs,
    }
  }

  /**
   * 租约状态：**只允许查询自己凭证对应的租约**。
   *
   * 早期版本接受调用方自报的 `{gameId, saveId}`，那会泄露（并放大为可探测）
   * 其他存档的运行元数据；现在身份同样来自凭证。支持可选声明进行交叉核验。
   */
  leaseStatus(input: LeaseStatusWireInput): LeaseStatusWireOutput {
    const resolved = this.resolveRuntime(input.runtimeToken)
    if (!resolved.ok) {
      // 凭证无效与"该租约不存在"对外一律回 `absent`，不区分原因，避免探测。
      return { absent: true }
    }
    const { lease } = resolved
    if (
      (typeof input.gameId === 'string' && input.gameId !== lease.gameId) ||
      (typeof input.saveId === 'string' && input.saveId !== lease.saveId)
    ) {
      return { absent: true }
    }
    return {
      state: lease.state,
      generation: lease.generation,
      expiresAt: lease.expiresAt,
      lastPersistedRevision: lease.lastPersistedRevision,
    }
  }

  async modelCatalog(llm: DshLlmLike | undefined, signal?: AbortSignal): Promise<ModelCatalogResult> {
    if (signal?.aborted === true) {
      return { entries: [], failures: [], available: false }
    }
    return readModelCatalog(llm)
  }

  /** 供测试与审计读取内部状态（不跨 wire）。 */
  inspect(gameId?: string): LeaseRecord[] {
    return gameId === undefined ? this.registry.all() : this.registry.all().filter((l) => l.gameId === gameId)
  }

  /**
   * 主动扫描并回收未确认超时的握手租约（T_ack 超时）。
   * 仅回收处于 pending 态且超期的租约；已 running 租约永不误回收。
   */
  sweepUnconfirmed(nowMs?: number): LeaseRecord[] {
    return this.registry.sweepUnconfirmed(nowMs ?? this.nowMs())
  }
}

/** 被 `@Remote` 标记的公开方法名（完全对齐 protocol GAMECENTER_REMOTE_METHODS）。 */
export const REMOTE_METHODS = GAMECENTER_REMOTE_METHODS

const Base = TypertRemoteService

export const DEFAULT_ALLOWED_MEDIA_HOSTS: readonly string[] = [
  'raw.githubusercontent.com',
  'github.com',
  'user-images.githubusercontent.com',
  'avatars.githubusercontent.com',
  'objects.githubusercontent.com',
  'upload.wikimedia.org',
  'cdn.akamai.steamstatic.com',
  'shared.fastly.steamstatic.com',
] as const

export type MediaHttpFetcher = (
  url: string,
  options?: { signal?: AbortSignal | null | undefined; redirect?: 'manual' | 'follow' | undefined; credentials?: 'omit' | undefined },
) => Promise<{
  ok: boolean
  status: number
  url?: string
  headers: { get(key: string): string | null }
  body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}>

export const DEFAULT_CATALOG_REPO = {
  owner: 'salishChen',
  repo: 'dsh-game-center-warehouse',
} as const

export interface FetchCommitArtifactsOptions {
  repository: string
  commit: string
  fetcher?: HttpFetcher | undefined
  token?: string | undefined
  timeoutMs?: number | undefined
  maxSingleFileBytes?: number | undefined
  maxTotalBytes?: number | undefined
  /**
   * 产物主机前缀，默认 `https://raw.githubusercontent.com`。
   * 用于换成可用镜像（例如 `https://ghfast.top/https://raw.githubusercontent.com`）；
   * 镜像不被信任，安装阶段仍会本地重算 manifestDigest / bundleDigest。
   */
  rawBase?: string | undefined
}

export interface FetchCommitArtifactsResult {
  ok: boolean
  errorCode?: string
  message?: string
  /** §11.8/§11.9 的结构化失败诊断（只在传输类失败时存在），供上报 `download-fail` 使用。 */
  detail?: unknown
  bundledSource?: {
    manifestContent: string
    files: readonly InstallSourceFile[]
  }
}

const ALLOWED_ARTIFACT_PATHS = [
  'gamecenter.json',
  'dist/index.html',
  'dist/game.js',
  'dist/style.css',
] as const

/**
 * 单个产物的下载**总时限**（毫秒），可被 `options.timeoutMs` 覆盖。
 *
 * 只作兜底：真正的"卡住"由直连通道的空闲超时判定（见 `direct-http.ts`）。
 * 15 秒的旧默认值对 14 MB 的包等于要求 0.94 MB/s 起步，慢链路必然失败。
 */
export const ARTIFACT_TOTAL_TIMEOUT_MS = 300_000

/** 官方产物主机；配置了 `rawBase` / `DSH_GAMECENTER_RAW_BASE` 时可换成可用镜像前缀。 */
export const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com'

/**
 * 官方主机失败时给一句可执行的提示。
 *
 * 现场证据（2026-10-29）：`raw.githubusercontent.com` 在某些线路上 20 秒拿不到响应头，
 * 这不是"超时太短"，调大超时也不会好，只能换主机。已在用镜像时不再重复提示。
 */
function rawBaseHint(rawBase: string): string {
  if (rawBase !== DEFAULT_RAW_BASE) return ''
  return '（若官方 raw 域名在本机线路不可达，可设置 DSH_GAMECENTER_RAW_BASE 走可用镜像）'
}

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
export function normalizeRawBase(value: string | undefined): { ok: true; base: string } | { ok: false; message: string } {
  const raw = (value ?? '').trim()
  if (raw === '') return { ok: true, base: DEFAULT_RAW_BASE }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, message: `产物主机前缀不是合法 URL: ${raw}` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: `产物主机前缀只允许 http/https: ${raw}` }
  }
  if (parsed.hostname === '') {
    return { ok: false, message: `产物主机前缀缺少主机名: ${raw}` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, message: '产物主机前缀不允许携带用户名或密码' }
  }
  // 前缀镜像形如 `https://ghfast.top/https://raw.githubusercontent.com`，
  // 其 pathname 本身含有目标 URL，因此这里只去掉尾部斜杠、按字符串拼接，
  // 不用 `url.join()`（那会把 pathname 里的 `https:` 当成路径段处理）。
  return { ok: true, base: raw.replace(/\/+$/, '') }
}

/**
 * 限定源提交产物下载器 (Source Adapter)：
 *
 * 规则：
 * 1. 严格要求 40 位小写十六进制 Git SHA，禁止使用 HEAD、分支名或标签；
 * 2. 仅支持标准 GitHub HTTPS 仓库地址，构造 raw.githubusercontent.com 确定性源；
 * 3. 严格受限文件白名单：仅允许 gamecenter.json 与 dist/ 下已知静态文件；严禁跨目录/绝对路径/.. 逃逸；
 * 4. 流式边读边查单文件上限（GAME_BUNDLE_MAX_FILE_BYTES，30 MiB）与总量上限
 *    （GAME_BUNDLE_MAX_TOTAL_BYTES，50 MiB），超限主动中断 reader 连接；
 * 5. 超时分两层：单文件总时限默认 5 分钟（`ARTIFACT_TOTAL_TIMEOUT_MS`，慢链路兜底），
 *    链路空闲由 `direct-http.ts` 的 socket 空闲超时（15s 无数据）判定并回退代理通道；
 * 6. 只拉取静态文本/二进制，不执行任何脚本，产物交由 prepareInstall 进行权威摘要比对。
 */
/**
 * 从传输类异常里取出 §11.8 结构化诊断（`attempts`/`phase`/`code`）。
 * 没有 `attempts` 说明不是传输层给的错误（例如协议校验失败），返回 undefined —— 不编造。
 */
function transportDetailFrom(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined
  const source = err as { attempts?: unknown; phase?: unknown; code?: unknown }
  if (!Array.isArray(source.attempts) || source.attempts.length === 0) return undefined
  const first = source.attempts[0] as { phase?: unknown } | undefined
  const phase = typeof first?.phase === 'string' ? first.phase : source.phase
  return {
    ...(typeof phase === 'string' ? { phase } : {}),
    ...(typeof source.code === 'string' ? { code: source.code } : {}),
    attempts: source.attempts,
  }
}

export async function fetchCommitArtifacts(
  options: FetchCommitArtifactsOptions,
): Promise<FetchCommitArtifactsResult> {
  const { repository, commit } = options

  // 1. 强校验 commit 为 40 位十六进制 SHA，严禁 HEAD/分支名
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `commit 必须为 40 位小写十六进制 SHA，禁止使用分支名或 HEAD: ${commit}`,
    }
  }

  // 2. 解析 GitHub 仓库
  const match = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(
    repository.trim(),
  )
  if (!match) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `无法解析 GitHub 仓库地址: ${repository}`,
    }
  }
  const owner = match[1]!
  const repo = match[2]!

  const rawBaseResult = normalizeRawBase(options.rawBase ?? process.env.DSH_GAMECENTER_RAW_BASE)
  if (!rawBaseResult.ok) {
    return { ok: false, errorCode: 'PROTOCOL_INVALID', message: rawBaseResult.message }
  }
  const rawBase = rawBaseResult.base

  const fetcher: HttpFetcher =
    options.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init))
  // 【超时语义 · 2026-10-29】默认值曾是 15_000，被真实事故打脸：
  // 大体积游戏包的 `dist/game.js` 曾达 14.16 MB，15 秒等于要求链路稳定跑满 ≥0.94 MB/s，
  // 跨公网到 raw.githubusercontent.com 必然踩线，用户看到的就是
  // `拉取文件超时 (15000ms): dist/game.js`。
  // 现在这里只是**单文件总时限兜底**（5 分钟），真正判定"卡住"的是直连通道的
  // **空闲超时**（`direct-http.ts` 的 DEFAULT_TIMEOUT_MS=15s，socket 上没数据才触发），
  // 所以"慢但一直在收"的下载不会被误杀。
  const timeoutMs = options.timeoutMs ?? ARTIFACT_TOTAL_TIMEOUT_MS
  // 【体积上限唯一真源 · 2026-10-27】不再各自写字面量：下载/安装两处曾分叉成 32 MiB / 30 MiB，
  // 同一个包在不同层得到不同上限和不同报错文案，排查时对不上账。现在一律引用 protocol 常量。
  const maxSingle = options.maxSingleFileBytes ?? GAME_BUNDLE_MAX_FILE_BYTES
  const maxTotal = options.maxTotalBytes ?? GAME_BUNDLE_MAX_TOTAL_BYTES

  const headers: Record<string, string> = {}
  if (options.token) {
    headers['Authorization'] = `token ${options.token}`
  }

  let totalBytesAccumulated = 0
  const allowedArtifactPaths=new Set<string>(ALLOWED_ARTIFACT_PATHS)

  async function fetchFile(
    relativePath: string,
    isOptional = false,
  ): Promise<{
    ok: boolean
    notFound?: boolean
    content?: Buffer
    errorCode?: string
    message?: string
    /** §11.8 结构化失败形状（退役字段：只在传输层失败时出现，`install-fail` 不带）。 */
    detail?: unknown
  }> {
    // 白名单与路径安全校验
    if (!allowedArtifactPaths.has(relativePath)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `禁止请求非白名单产物路径: ${relativePath}`,
      }
    }
    if (!isSafeRelativePath(relativePath)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `非法相对路径: ${relativePath}`,
      }
    }

    const url = `${rawBase}/${owner}/${repo}/${commit}/${relativePath}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      // 防御性竞速：即使注入的 fetcher 忽略 `signal`（历史缺陷，`direct-http` 曾完全不看它），
      // 总时限也必须能真正结束这一趟。否则"到点了但 await 永远不返回"，用户界面就一直转圈。
      const aborted = new Promise<never>((_, rejectAborted) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            const err = new Error(`已超过单文件总时限 ${timeoutMs}ms`)
            err.name = 'TimeoutError'
            rejectAborted(err)
          },
          { once: true },
        )
      })
      res = await Promise.race([
        fetcher(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        }),
        aborted,
      ])
    } catch (err: any) {
      clearTimeout(timer)
      const detail = err instanceof Error ? err.message : String(err)
      // 传输类失败带上结构化诊断；内容/协议类失败不带（别把两类混成一个字段）。
      const transportDetail = transportDetailFrom(err)
      if (controller.signal.aborted) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `拉取文件超过总时限 (${timeoutMs}ms): ${relativePath}（链路太慢或中途卡住，可重试）${rawBaseHint(rawBase)}`,
          detail: transportDetail,
        }
      }
      // 分层文案：链路长时间无数据（内层 socket 空闲超时）与真正的网络异常要分开，
      // 否则"慢"和"断"永远混在一句"超时"里，用户和排查的人都只能猜。
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `拉取文件被取消: ${relativePath}：${detail}`,
          detail: transportDetail,
        }
      }
      if (/空闲超时|timed?\s?out|ETIMEDOUT/i.test(detail)) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `拉取文件超时（链路长时间无数据）: ${relativePath}：${detail}${rawBaseHint(rawBase)}`,
          detail: transportDetail,
        }
      }
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `拉取文件网络异常: ${detail}`,
      }
    }
    clearTimeout(timer)

    if (!res.ok) {
      if (isOptional && res.status === 404) {
        return { ok: true, notFound: true }
      }
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `拉取文件失败 (HTTP ${res.status}): ${url}`,
      }
    }

    // 流式读取与体积截断保护
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let fileBytes = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            const chunk = value as unknown as Uint8Array
            fileBytes += chunk.byteLength
            if (fileBytes > maxSingle) {
              await reader.cancel()
              return {
                ok: false,
                errorCode: 'PROTOCOL_INVALID',
                message: `文件 ${relativePath} 超过单文件上限 (${maxSingle} 字节)`,
              }
            }
            if (totalBytesAccumulated + fileBytes > maxTotal) {
              await reader.cancel()
              return {
                ok: false,
                errorCode: 'PROTOCOL_INVALID',
                message: `产物总量超过上限 (${maxTotal} 字节)`,
              }
            }
            chunks.push(chunk)
          }
        }
        totalBytesAccumulated += fileBytes
        return { ok: true, content: Buffer.concat(chunks) }
      } else {
        const ab = await res.arrayBuffer()
        if (ab.byteLength > maxSingle) {
          return {
            ok: false,
            errorCode: 'PROTOCOL_INVALID',
            message: `文件 ${relativePath} 超过单文件上限 (${maxSingle} 字节)`,
          }
        }
        if (totalBytesAccumulated + ab.byteLength > maxTotal) {
          return {
            ok: false,
            errorCode: 'PROTOCOL_INVALID',
            message: `产物总量超过上限 (${maxTotal} 字节)`,
          }
        }
        totalBytesAccumulated += ab.byteLength
        return { ok: true, content: Buffer.from(new Uint8Array(ab)) }
      }
    } catch (err: any) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `读取文件流失败: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // 1. 拉取 gamecenter.json
  const manifestRes = await fetchFile('gamecenter.json', false)
  if (!manifestRes.ok || !manifestRes.content) {
    return {
      ok: false,
      errorCode: manifestRes.errorCode ?? 'PROTOCOL_INVALID',
      message: manifestRes.message ?? '拉取 gamecenter.json 失败',
    }
  }
  const manifestContent = manifestRes.content.toString('utf-8')

  // 解析并校验 manifest 布局
  let manifestObj: any
  try {
    manifestObj = JSON.parse(manifestContent)
  } catch (err) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `gamecenter.json 不是合法的 JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!manifestObj || typeof manifestObj !== 'object' || manifestObj.schemaVersion !== 1) {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `gamecenter.json schemaVersion 必须为 1`,
    }
  }
  const declaredEntry = manifestObj.runtime?.entry ?? 'dist/index.html'
  if (declaredEntry !== 'dist/index.html') {
    return {
      ok: false,
      errorCode: 'PROTOCOL_INVALID',
      message: `未知或不受支持的入口路径: ${declaredEntry}，仅允许 dist/index.html`,
    }
  }

  // 2. 拉取必选产物：dist/index.html 与 dist/game.js
  const files: InstallSourceFile[] = []
  const requiredPaths = ['dist/index.html', 'dist/game.js'] as const
  for (const filePath of requiredPaths) {
    const fRes = await fetchFile(filePath, false)
    if (!fRes.ok || !fRes.content) {
      return {
        ok: false,
        errorCode: fRes.errorCode ?? 'PROTOCOL_INVALID',
        message: fRes.message ?? `拉取必选产物 ${filePath} 失败`,
      }
    }
    files.push({ path: filePath, content: fRes.content })
  }

  // 3. 探测拉取可选产物：dist/style.css
  const styleRes = await fetchFile('dist/style.css', true)
  if (!styleRes.ok) {
    return {
      ok: false,
      errorCode: styleRes.errorCode ?? 'PROTOCOL_INVALID',
      message: styleRes.message ?? '拉取 dist/style.css 失败',
    }
  }
  if (styleRes.content && !styleRes.notFound) {
    files.push({ path: 'dist/style.css', content: styleRes.content })
  }

  // Offline runtimes/assets are declared by local script tags in the pinned entry.
  // Every dependency remains inside dist/, subject to count/size and final digest checks.
  const indexHtml=files.find(f=>f.path==='dist/index.html')!.content.toString()
  const dependencies=new Set<string>()
  for(const match of indexHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)){
    const relative=match[1]!.replace(/^\.\//,'')
    const filePath='dist/'+relative
    if(!isSafeBundlePath(filePath)||!relative.endsWith('.js'))return {ok:false,errorCode:'PROTOCOL_INVALID',message:'入口含不安全的脚本依赖'}
    if(!requiredPaths.some(p=>p===filePath))dependencies.add(filePath)
  }
  if(dependencies.size+files.length+1>64)return {ok:false,errorCode:'PROTOCOL_INVALID',message:'游戏依赖文件数量超限'}
  for(const filePath of dependencies){
    allowedArtifactPaths.add(filePath)
    const result=await fetchFile(filePath,false)
    if(!result.ok||!result.content)return {ok:false,errorCode:result.errorCode??'PROTOCOL_INVALID',message:result.message??'缺少游戏依赖 '+filePath}
    files.push({path:filePath,content:result.content})
  }

  return {
    ok: true,
    bundledSource: {
      manifestContent,
      files,
    },
  }
}

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
export function readReportDownloadFailEnv(): boolean {
  const raw = process.env.DSH_GAMECENTER_REPORT_DOWNLOAD_FAIL
  if (typeof raw !== 'string') return false
  return /^(?:1|true|yes|on)$/i.test(raw.trim())
}

export interface GameCenterServiceOptions {
  wallet?: WhaleWallet | undefined
  playerId: string
  saveStore: SaveStore
  gameLibraryDir: string
  previewDir?: string | undefined
  approvals?: readonly ApprovedRelease[] | undefined
  catalogMode?: ('github' | 'fixture' | 'remote') | undefined
  catalogFixtureEntries?: readonly CatalogMachineEntry[] | undefined
  catalogRepo?: { owner: string; repo: string } | undefined
  /**
   * 远端目录/上报共用的 endpoint（契约 §3 条款 14）。
   * 为空时远端目录与上报一起整体静默，不重试、不排队。
   */
  catalogBaseUrl?: string | undefined
  /**
   * 产物下载主机前缀（默认 `https://raw.githubusercontent.com`）。
   * 官方 raw 域名在某些线路不可达时，配置成可用镜像前缀即可，例如
   * `https://ghfast.top/https://raw.githubusercontent.com`。
   * 镜像不被信任：安装阶段仍在本地重算 manifestDigest / bundleDigest。
   */
  rawBaseUrl?: string | undefined
  /**
   * §11.9 `download-fail` 上报开关，**默认关闭**。
   * 后台 `report_events.kind` 是 ENUM 列，`006` 迁移（扩值 + detail 列）应用并经项目管理确认前，
   * 客户端只发旧三个 kind，否则上报会被 ENUM 拒收。见 docs/gamecenter-admin-backend.md §11.10。
   */
  reportDownloadFailures?: boolean | undefined
  /** 装机级 installId；缺省时按 `<gameLibraryDir>/.install-id` 读取或首次生成。 */
  installId?: string | undefined
  catalogGithubToken?: string | undefined
  catalogFetcher?: HttpFetcher | undefined
  runningVersions?: { gameCenter: string; dsh: string } | null | undefined
  dshObservation?: RuntimeVersionObservation | null | undefined
  gameCenterObservation?: RuntimeVersionObservation | null | undefined
  allowedMediaHosts?: readonly string[] | undefined
  mediaFetcher?: MediaHttpFetcher | undefined
  dnsLookup?: ((hostname: string) => Promise<{ address: string; family: number }>) | undefined
  mediaSecurityVerified?: boolean | undefined
  manifestResolver?: ((gameId: string, commit?: string) => Promise<GameManifestV1 | null>) | undefined
  aiBroker?: ((slot: string, input: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined
}

export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (ip === '::1' || ip === 'localhost') return true
  const parts = ip.split('.').map(Number)
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    const p0 = parts[0]!
    const p1 = parts[1]!
    if (p0 === 127) return true
    if (p0 === 10) return true
    if (p0 === 192 && p1 === 168) return true
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true
    if (p0 === 169 && p1 === 254) return true
    if (p0 === 0) return true
    return false
  }
  const lower = ip.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true
  return false
}

/**
 * 核心方法装配为 Typert Remote 服务类。
 *
 * 使用 TypeScript 标准装饰器（Stage 3）@Remote 标记公开端点。
 * 运行时由 Gateway 的 collectSrcClaims() 扫描原型方法并在 /api/gameCenter/* 认领端点。
 */
function matchesImageMagicBytes(buf: Buffer, mime: string): boolean {
  if (mime === 'image/png') {
    return (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    )
  }
  if (mime === 'image/jpeg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  }
  if (mime === 'image/gif') {
    return (
      buf.length >= 6 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) &&
      buf[5] === 0x61
    )
  }
  if (mime === 'image/webp') {
    return (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
  }
  return false
}

function parseImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      return { width, height }
    }
  } else if (mime === 'image/gif') {
    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      const width = buf.readUInt16LE(6)
      const height = buf.readUInt16LE(8)
      return { width, height }
    }
  } else if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 4 < buf.length) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]!
      if (marker === 0xd9 || marker === 0xda) break
      const len = buf.readUInt16BE(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (offset + 9 <= buf.length) {
          const height = buf.readUInt16BE(offset + 5)
          const width = buf.readUInt16BE(offset + 7)
          return { width, height }
        }
      }
      offset += 2 + len
    }
  } else if (mime === 'image/webp') {
    if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      const f0 = buf[12], f1 = buf[13], f2 = buf[14], f3 = buf[15]
      // VP8X
      if (f0 === 0x56 && f1 === 0x50 && f2 === 0x38 && f3 === 0x58 && buf.length >= 30) {
        const width = 1 + buf[24]! + (buf[25]! << 8) + (buf[26]! << 16)
        const height = 1 + buf[27]! + (buf[28]! << 8) + (buf[29]! << 16)
        return { width, height }
      }
      // VP8
      if (f0 === 0x56 && f1 === 0x50 && f2 === 0x38 && f3 === 0x20 && buf.length >= 30) {
        if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
          const width = buf.readUInt16LE(26) & 0x3fff
          const height = buf.readUInt16LE(28) & 0x3fff
          return { width, height }
        }
      }
      // VP8L
      if (f0 === 0x56 && f1 === 0x50 && f2 === 0x38 && f3 === 0x4c && buf.length >= 25 && buf[20] === 0x2f) {
        const b1 = buf[21]!, b2 = buf[22]!, b3 = buf[23]!, b4 = buf[24]!
        const width = 1 + (((b2 & 0x3f) << 8) | b1)
        const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
        return { width, height }
      }
    }
  }
  return null
}

export class GameCenterService extends Base {
  readonly core: GameCenterCore
  private readonly hostCtx: GameCenterHostContext
  readonly playerId: string
  startWalletHistory: (()=>void)|undefined
  readonly wallet: WhaleWallet
  readonly saveStore: SaveStore
  readonly gameLibraryDir: string
  readonly previewDir?: string | undefined
  readonly approvals: ApprovedRelease[]
  readonly catalogMode: 'github' | 'fixture' | 'remote'
  readonly catalogFixtureEntries: readonly CatalogMachineEntry[]
  readonly runningVersions?: { gameCenter: string; dsh: string } | null | undefined
  readonly dshObservation?: RuntimeVersionObservation | null | undefined
  readonly gameCenterObservation?: RuntimeVersionObservation | null | undefined
  readonly allowedMediaHosts: readonly string[]
  readonly mediaFetcher?: MediaHttpFetcher | undefined
  readonly dnsLookup?: ((hostname: string) => Promise<{ address: string; family: number }>) | undefined
  readonly mediaSecurityVerified: boolean
  readonly catalogRepo: { owner: string; repo: string }
  readonly catalogGithubToken?: string | undefined
  readonly catalogFetcher?: HttpFetcher | undefined
  readonly manifestResolver?: ((gameId: string, commit?: string) => Promise<GameManifestV1 | null>) | undefined
  readonly aiBroker?: ((slot: string, input: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined
  readonly catalogBaseUrl?: string | undefined
  readonly rawBaseUrl?: string | undefined
  readonly reportDownloadFailures: boolean
  readonly installId?: string | undefined
  private reportClientPromise?: Promise<RemoteReportClient | undefined>
  private remoteCatalogProvider?: RemoteCatalogProvider
  /**
   * 后台/制品下载专用 fetcher：**先直连**（`node:http`/`node:https`，不读代理环境变量），
   * 直连不通才回退到全局 `fetch`（那条会套 `HTTP_PROXY`）。原因见 `remote/direct-http.ts`
   * 文件头：`NO_PROXY` 里的 CIDR 不被 undici 解析，内网后台曾被推给死代理，
   * `fetch failed` 又被吞成「未找到审批记录」。
   */
  private readonly resilientFetcher: HttpFetcher = createResilientFetcher()
  private readonly aiBindings = new Map<string, AiModelBinding>()
  private readonly landlordTables = new Map<string, {game:LandlordState; traces:LandlordCallTrace[]; operations:Map<string,{input:string;result:any}>; pending?:{id:string;input:string;promise:Promise<any>;controller:AbortController}}>()
  private readonly arenaModes=new Map<string,{mode:'adventure'|'duel';roundId:string;operationId?:string;planJson?:string;aiPlan?:ArenaPlan;traces:ArenaAiTrace[];previousRound?:ArenaPreviousRound;result?:ArenaRoundResult}>()
  private readonly arenaModeOperations=new Map<string,{input:string;result:ArenaActionResult}>()
  private readonly runtimeTargets = new Map<string, { commit?: string; previewId?: string }>()
  private readonly aiOperations = new Map<string, { inputJson: string; output: unknown; result?: AiGenerateWireResult }>()
  private readonly inFlightAiOperations = new Map<
    string,
    { inputJson: string; promise: Promise<AiGenerateWireResult>; abortController: AbortController }
  >()
  private readonly inFlightAiByRuntimeInstance = new Map<string, Set<AbortController>>()

  private abortInFlightAi(runtimeInstanceId: string, reason = 'RUNTIME_ABORTED'): void {
    const set = this.inFlightAiByRuntimeInstance.get(runtimeInstanceId)
    if (!set) return
    for (const controller of set) {
      try {
        controller.abort(new Error(reason))
      } catch {
        // ignore
      }
    }
    set.clear()
    this.inFlightAiByRuntimeInstance.delete(runtimeInstanceId)
  }

  constructor(ctx: Context, core: GameCenterCore, options: GameCenterServiceOptions) {
    super(ctx, SERVICE_KEY, { namespace: REMOTE_NAMESPACE })
    this.core = core
    this.hostCtx = ctx as GameCenterHostContext
    this.playerId = options.playerId
    this.wallet = options.wallet ?? new WhaleWallet(':memory:',options.playerId)
    this.saveStore = options.saveStore
    this.gameLibraryDir = options.gameLibraryDir
    this.previewDir = options.previewDir
    this.approvals = options.approvals ? [...options.approvals] : []
    this.catalogMode = options.catalogMode ?? (Boolean(options.catalogBaseUrl) || process.env.DSH_GAMECENTER_BACKEND_URL || true ? 'remote' : 'github')
    this.catalogFixtureEntries = options.catalogFixtureEntries ?? []
    this.catalogRepo = options.catalogRepo ?? DEFAULT_CATALOG_REPO
    this.catalogGithubToken = options.catalogGithubToken
    this.catalogFetcher = options.catalogFetcher
    this.manifestResolver = options.manifestResolver
    this.aiBroker = options.aiBroker
    this.runningVersions = options.runningVersions
    this.dshObservation = options.dshObservation
    this.gameCenterObservation = options.gameCenterObservation
    this.allowedMediaHosts = options.allowedMediaHosts ?? DEFAULT_ALLOWED_MEDIA_HOSTS
    this.mediaFetcher = options.mediaFetcher
    this.dnsLookup = options.dnsLookup
    this.mediaSecurityVerified = options.mediaSecurityVerified ?? false
    this.catalogBaseUrl = options.catalogBaseUrl
    this.rawBaseUrl = options.rawBaseUrl
    this.reportDownloadFailures = options.reportDownloadFailures ?? readReportDownloadFailEnv()
    this.installId = options.installId
  }

  /**
   * 懒初始化上报客户端：endpoint 为空 → `undefined`，远端目录与上报整体静默。
   * `installId` 首次启用时生成并本地持久化；用户看不到，也不进 UI/iframe。
   */
  private getReportClient(): Promise<RemoteReportClient | undefined> {
    const baseUrl = this.catalogBaseUrl
    if (!baseUrl) return Promise.resolve(undefined)
    if (!this.reportClientPromise) {
      this.reportClientPromise = (async () => {
        const installId =
          this.installId ?? (await readOrCreateInstallId(path.join(this.gameLibraryDir, '.install-id')))
        return new RemoteReportClient({
          baseUrl,
          installId,
          client: 'dsh-gamecenter',
          // 上报打到同一个内网后台，同样不能交给环境代理。
          fetcher: this.catalogFetcher ?? this.resilientFetcher,
        })
      })()
    }
    return this.reportClientPromise
  }

  @Remote
  walletStatus(input: WalletStatusRequest): WalletStatusResult {
    this.startWalletHistory?.()
    return {ok:true,wallet:this.wallet.status()}
  }

  @Remote
  async walletAction(input: WalletActionWireRequest): Promise<WalletActionWireResult> {
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['runtimeToken','action','operationId','expectedRevision','amount','state'].includes(k)))return {ok:false,errorCode:'PROTOCOL_INVALID',message:'钱包请求字段不合法'}
    const resolved=this.core.resolveRuntime(input.runtimeToken)
    if(!resolved.ok)return {ok:false,errorCode:resolved.code,message:resolved.message}
    const lease=resolved.lease
    if(!hasWhaleWallet(lease.gameId)||lease.state!=='running'||lease.sealed)return {ok:false,errorCode:'STALE_RUNTIME',message:'钱包仅允许已开通兑换的运行中游戏访问'}
    const manifest=await this.runtimeManifest(lease),current=this.core.resolveRuntime(input.runtimeToken)
    if(manifest?.id!==lease.gameId||!current.ok||current.lease!==lease||lease.state!=='running'||lease.sealed)return {ok:false,errorCode:'STALE_RUNTIME',message:'游戏资源或会话失效'}
    if(this.arenaModes.get(lease.runtimeInstanceId)?.mode==='duel'&&input.action!=='status')return {ok:false,errorCode:'CAPABILITY_UNAVAILABLE',message:'AI 对战金币不能充值或写入冒险存档'}
    this.startWalletHistory?.()
    try{return this.wallet.command(input,lease.gameId)}catch(e){return {ok:false,errorCode:'PROTOCOL_INVALID',message:e instanceof Error?e.message:'钱包操作失败'}}
  }

  @Remote
  handshake(input: HandshakeWireInput): HandshakeWireOutput {
    if (input?.commit !== undefined) {
      if (!/^[a-f0-9]{40}$/.test(input.commit)) {
        return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '非法 commit' }
      }
      let hasApproval = this.approvals.some(a => a.gameId === input.gameId && a.commit === input.commit)
      if (!hasApproval && this.gameLibraryDir) {
        try {
          const metaPath = path.join(this.gameLibraryDir, input.gameId, input.commit, '.dsh-installed.json')
          if (fs.existsSync(metaPath)) {
            const raw = fs.readFileSync(metaPath, 'utf-8')
            const meta = JSON.parse(raw) as any
            if (meta.gameId === input.gameId && meta.commit === input.commit && meta.manifestDigest && meta.bundleDigest) {
              const approval: ApprovedRelease = {
                gameId: meta.gameId,
                commit: meta.commit,
                repository: meta.repository || '',
                manifestDigest: meta.manifestDigest,
                bundleDigest: meta.bundleDigest,
                approvedAt: meta.installedAt || new Date().toISOString(),
                approvedBy: 'installed-record',
                approvalRecordPath: meta.approvalRecordPath || `installed://${meta.gameId}/${meta.commit}`,
              }
              this.approvals.push(approval)
              hasApproval = true
            }
          }
        } catch {
          // ignore
        }
      }
      if (!hasApproval) {
        return { ok: false, errorCode: 'UNAPPROVED_RELEASE', message: '运行提交未审批' }
      }
    }
    if (input?.previewId !== undefined && (!this.previewDir || !isSafeRelativePath(input.previewId) || /[\\/]/.test(input.previewId) || input.commit !== undefined)) {
      return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '非法预览目标' }
    }
    const result = this.core.handshake(input)
    if (result.ok) this.runtimeTargets.set(input.runtimeInstanceId, {
      ...(input.commit === undefined ? {} : {commit: input.commit}),
      ...(input.previewId === undefined ? {} : {previewId: input.previewId}),
    })
    return result
  }

  private async runtimeManifest(lease: LeaseRecord): Promise<GameManifestV1 | null> {
    const target = this.runtimeTargets.get(lease.runtimeInstanceId)
    if (target?.previewId && this.previewDir) {
      try { const manifest = JSON.parse(await fs.promises.readFile(path.join(this.previewDir, target.previewId, 'gamecenter.json'), 'utf8')); return manifest.id === lease.gameId && manifest.schemaVersion === 1 ? manifest : null }
      catch { return null }
    }
    return this.resolveGameManifest(lease.gameId, target?.commit)
  }

  @Remote
  async arenaAction(input:ArenaActionRequest):Promise<ArenaActionResult> {
    const fail=(message:string,errorCode='PROTOCOL_INVALID'):ArenaActionResult=>({ok:false,errorCode,message})
    if(!input||Object.keys(input).some(k=>!['runtimeToken','action','operationId','mode','roundId','loadout','result'].includes(k))||!['mode','reset','state','review','lock','finish','next'].includes(input.action)||typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)||
      (input.action==='mode'?!['adventure','duel'].includes(input.mode!):input.mode!==undefined)||input.action!=='lock'&&input.loadout!==undefined||input.action!=='finish'&&input.result!==undefined||!['lock','finish','next'].includes(input.action)&&input.roundId!==undefined)return fail('模式命令不合法')
    if(input.action==='finish'){
      const value=input.result
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['winner','durationMs'].includes(k))||!['player','ai','draw'].includes(value.winner)||!Number.isInteger(value.durationMs)||value.durationMs<=0||value.durationMs>47000)return fail('比赛结果不合法')
    }
    const resolved=this.core.resolveRuntime(input.runtimeToken)
    if(!resolved.ok)return fail(resolved.message,resolved.code)
    const lease=resolved.lease,id=lease.runtimeInstanceId
    if(lease.gameId!=='example.cat-arena'||lease.state!=='running'||lease.sealed)return fail('战车实例未运行','STALE_RUNTIME')
    const manifest=await this.runtimeManifest(lease),current=this.core.resolveRuntime(input.runtimeToken)
    if(manifest?.id!=='example.cat-arena'||!current.ok||current.lease!==lease||lease.state!=='running'||lease.sealed)return fail('战车资源或会话失效','STALE_RUNTIME')
    if(input.mode==='duel'&&!manifest.ai?.slots?.vehicleBuild)return fail('该版本未声明 AI 组装能力','CAPABILITY_UNAVAILABLE')
    let table=this.arenaModes.get(id)
    const key=id+'\0'+input.operationId,serialized=JSON.stringify({action:input.action,mode:input.mode,roundId:input.roundId,loadout:input.loadout,result:input.result}),prior=this.arenaModeOperations.get(key)
    if(prior){if(prior.input!==serialized)return fail('操作编号不能更换内容');return prior.result.ok&&prior.result.roundId===table?.roundId?prior.result:fail('操作所属对局已结束','STALE_RUNTIME')}
    if(['lock','finish','next'].includes(input.action)&&(table?.mode!=='duel'||input.roundId!==table.roundId))return fail('对局已变化','STALE_RUNTIME')
    if(input.action==='next'){
      if(!table?.result||!table.planJson||!table.aiPlan)return fail('请先完成并确认本轮比赛')
      const previousRound:ArenaPreviousRound={playerPlan:JSON.parse(table.planJson),aiPlan:structuredClone(table.aiPlan),result:structuredClone(table.result)}
      this.abortInFlightAi(id,'ARENA_NEXT_ROUND')
      table={mode:'duel',roundId:randomBytes(18).toString('base64url'),traces:[],previousRound};this.arenaModes.set(id,table)
    }else if(input.action==='mode'||input.action==='reset'||!table){
      this.abortInFlightAi(id,'ARENA_MODE_CHANGED')
      table={mode:input.action==='mode'?input.mode!:table?.mode??'adventure',roundId:randomBytes(18).toString('base64url'),traces:[]};this.arenaModes.set(id,table)
    }
    if(input.action==='lock'){
      if(!table.aiPlan||table.result)return fail('AI 尚未完成组装或本轮已结束')
      try{const plan=JSON.stringify(quoteArenaPlan(input.loadout).plan);if(table.planJson&&table.planJson!==plan)return fail('你的战车已锁定');table.planJson=plan}catch(error){return fail(error instanceof Error?error.message:'装配不合法')}
    }
    if(input.action==='finish'){
      if(!table.planJson||!table.aiPlan)return fail('比赛尚未开战')
      if(table.result&&JSON.stringify(table.result)!==JSON.stringify(input.result))return fail('已确认的比赛结果不能更改')
      table.result=structuredClone(input.result!)
    }
    const result:ArenaActionResult={ok:true,mode:table.mode,roundId:table.roundId,budget:ARENA_DUEL_BUDGET,...(input.action==='review'?{traces:arenaReviewTraces(table.traces)}:{}),...(input.action==='next'?{retainedPlan:structuredClone(table.previousRound!.playerPlan)}:{})}
    if(['mode','reset','lock','finish','next'].includes(input.action)){
      if(this.arenaModeOperations.size>1024)this.arenaModeOperations.delete(this.arenaModeOperations.keys().next().value!)
      this.arenaModeOperations.set(key,{input:serialized,result})
    }
    return result
  }

  @Remote
  async setAiBinding(input: SetAiBindingRequest): Promise<SetAiBindingResult> {
    const resolved = this.core.resolveRuntime(input?.runtimeToken)
    if (!resolved.ok) return {ok:false, errorCode:resolved.code, message:resolved.message}
    if (resolved.lease.gameId === 'example.minesweeping') return {ok:false,errorCode:'CAPABILITY_UNAVAILABLE',message:'扫雷 AI 接入已取消'}
    if (resolved.lease.state !== 'running' || typeof input.slot !== 'string' || typeof input.providerId !== 'string' || typeof input.modelId !== 'string')
      return {ok:false, errorCode:'PROTOCOL_INVALID', message:'非法模型绑定或非运行状态'}
    const manifest = await this.runtimeManifest(resolved.lease)
    if (!manifest?.ai?.slots?.[input.slot]) return {ok:false, errorCode:'PROTOCOL_INVALID', message:'游戏未声明该 AI slot'}
    if (this.inFlightAiByRuntimeInstance.get(resolved.lease.runtimeInstanceId)?.size) return {ok:false, errorCode:'RATE_LIMIT', message:'生成期间不可切换模型'}
    try {
      const llm = this.hostCtx.llm
      if (!llm?.resolveModelInfo) throw new Error('模型能力查询不可用')
      const info = await llm.resolveModelInfo(input.providerId, input.modelId)
      const effort = input.reasoningEffort ?? info.reasoning?.defaultEffort
      if (effort !== undefined && !info.reasoning?.efforts?.some((x: any) => x.id === effort)) throw new Error('该模型不支持所选推理水平')
      const binding: AiModelBinding = {providerId:input.providerId, modelId:input.modelId, ...(effort === undefined ? {} : {reasoningEffort:effort})}
      const current=this.core.resolveRuntime(input.runtimeToken),id=resolved.lease.runtimeInstanceId
      if(!current.ok||current.lease!==resolved.lease||current.lease.state!=='running'||current.lease.sealed)return {ok:false,errorCode:'STALE_RUNTIME',message:'会话已暂停或关闭'}
      if(this.inFlightAiByRuntimeInstance.get(id)?.size)return {ok:false,errorCode:'RATE_LIMIT',message:'生成期间不可切换模型'}
      const table=this.arenaModes.get(id),previous=this.aiBindings.get(`${id}\0${input.slot}`)
      if(table?.mode==='duel'&&input.slot==='vehicleBuild'){
        if(table.planJson)return {ok:false,errorCode:'RATE_LIMIT',message:'对局已开战，请先重置'}
        if(JSON.stringify(previous)!==JSON.stringify(binding))this.arenaModes.set(id,{mode:'duel',roundId:randomBytes(18).toString('base64url'),traces:[],...(table.previousRound?{previousRound:structuredClone(table.previousRound)}:{})})
      }
      this.aiBindings.set(`${id}\0${input.slot}`, binding)
      return {ok:true, binding}
    } catch (err) { return {ok:false, errorCode:'CAPABILITY_UNAVAILABLE', message:err instanceof Error ? err.message : '模型不可用'} }
  }

  @Remote
  async landlordAction(input:LandlordActionRequest,signal?:AbortSignal):Promise<LandlordActionResult> {
    const error=(message:string,code='PROTOCOL_INVALID')=>({ok:false,errorCode:code,message})
    const resolved=this.core.resolveRuntime(input?.runtimeToken)
    if(!resolved.ok)return error(resolved.message,resolved.code)
    const lease=resolved.lease,id=lease.runtimeInstanceId
    if(lease.gameId!=='example.landlord'||lease.state!=='running'||lease.sealed)return error('斗地主实例未运行','STALE_RUNTIME')
    const manifest=await this.runtimeManifest(lease)
    if(manifest?.id!=='example.landlord')return error('未绑定可信斗地主资源')
    const current=this.core.resolveRuntime(input.runtimeToken)
    if(!current.ok||current.lease.state!=='running'||current.lease.sealed)return error('牌局已关闭或暂停','STALE_RUNTIME')
    if(!input||Object.keys(input).some(k=>!['runtimeToken','operationId','expectedRevision','action','cards','bid'].includes(k))||
      !['state','new','bid','play','pass','ai','cancel','review'].includes(input.action)||typeof input.operationId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId))return error('命令不合法；不接受座位、手牌或自定义提示词')
    let table=this.landlordTables.get(id)
    if(!table){table={game:createLandlordGame(),traces:[],operations:new Map()};this.landlordTables.set(id,table)}
    // Check before operation replay: no trace or another seat's hand may leave Host during play.
    if(input.action==='review'){
      if(table.game.phase!=='finished')return error('本局结束后才能查看 AI 对话与用量','CAPABILITY_UNAVAILABLE')
      if(input.expectedRevision!==table.game.revision)return error('牌局已变化','STALE_RUNTIME')
      return {ok:true,review:structuredClone({revision:table.game.revision,calls:table.traces,summary:summarizeCalls(table.traces)})}
    }
    const serialized=JSON.stringify({action:input.action,expectedRevision:input.expectedRevision,cards:input.cards,bid:input.bid})
    const previous=table.operations.get(input.operationId)
    if(previous)return previous.input===serialized?previous.result:error('同一操作编号不能更换参数')
    const pending=table.pending
    if(pending?.id===input.operationId)return pending!.input===serialized?pending!.promise:error('并发操作参数冲突')
    if(input.action==='state')return {ok:true,view:landlordSeatView(table.game,0)}
    if(input.action==='cancel'){table.pending?.controller.abort('USER_CANCELLED');return {ok:true,view:landlordSeatView(table.game,0)}}
    if(input.expectedRevision!==table.game.revision)return error('牌局已变化，请刷新后操作','STALE_RUNTIME')
    if(input.action==='new'){
      table.pending?.controller.abort('NEW_GAME');delete table.pending
      const revision=table.game.revision+1;table.game=createLandlordGame();table.game.revision=revision
      table.traces=[];table.operations.clear()
      const result={ok:true,view:landlordSeatView(table.game,0)};table.operations.set(input.operationId,{input:serialized,result});return result
    }
    if(table.pending)return error('电脑正在思考，请等待','RATE_LIMIT')
    if(input.action!=='ai'){
      if(table.game.turn!==0)return error('未轮到玩家')
      try{applyLandlordAction(table.game,0,input.action==='bid'?{bid:input.bid}:{cards:input.action==='pass'?[]:input.cards})}
      catch(e){return error(e instanceof Error?e.message:'动作不合法')}
      const result={ok:true,view:landlordSeatView(table.game,0)};table.operations.set(input.operationId,{input:serialized,result});return result
    }
    const game=table.game,seat=game.turn
    if(seat===0||game.phase==='finished')return error('当前不是电脑回合')
    const slot=`landlordSeat${seat}`,binding=this.aiBindings.get(`${id}\0${slot}`)
    if(binding&&!manifest.ai?.slots?.[slot])return error('未授权的电脑模型 slot')
    const controller=new AbortController(),cancel=()=>controller.abort('CALLER_CANCELLED')
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel()
    let set=this.inFlightAiByRuntimeInstance.get(id);if(!set){set=new Set();this.inFlightAiByRuntimeInstance.set(id,set)}set.add(controller)
    lease.expiresAt=new Date(this.core.nowMs()+150_000).toISOString()
    // Full state, shuffle seed and other hands are never broker arguments.
    const view=landlordSeatView(game,seat),revision=game.revision
    const trace:LandlordCallTrace={operationId:input.operationId,seat,revision,startedAt:new Date().toISOString(),...(binding?{requestedBinding:{...binding}}:{}),elapsedMs:0,usage:{},status:binding?'failed':'local',source:'none'}
    table.traces.push(trace)
    const promise=(async()=>{
      let source='local',reason=binding?'':'该座位尚未绑定模型，使用本地策略',metadata:Record<string,unknown>={}
      let decision:{bid?:number;cards?:number[]}
      try{
        if(binding){const generated=await generateLandlordDecision(this.hostCtx.llm,{...binding},view,controller.signal,report=>Object.assign(trace,report));decision=generated.action;source='ai';metadata={binding:generated.binding,elapsedMs:generated.elapsedMs,...('usage' in generated?{usage:generated.usage}:{})}}
        else decision=localLandlordDecision(view)
      }catch(e){if(controller.signal.aborted){trace.source='none';return error('电脑请求已取消，未执行动作','CANCELLED')};reason=e instanceof Error?e.message:'模型失败';decision=localLandlordDecision(view)}
      const active=this.core.resolveRuntime(input.runtimeToken)
      if(controller.signal.aborted||!active.ok||active.lease.state!=='running'||active.lease.sealed||table!.game!==game||game.revision!==revision)return error('牌局已改变，迟到动作已丢弃','STALE_RUNTIME')
      try{applyLandlordAction(game,seat as Seat,decision)}catch(e){return error(e instanceof Error?e.message:'动作非法')}
      trace.source=source as 'ai'|'local';trace.action=structuredClone(decision);if(reason&&!trace.error)trace.error=reason
      const result={ok:true,view:landlordSeatView(game,0),decision:{seat,source,...(reason?{reason}:{}),...metadata}}
      table!.operations.set(input.operationId,{input:serialized,result})
      if(table!.operations.size>256)table!.operations.delete(table!.operations.keys().next().value!)
      return result
    })()
    table.pending={id:input.operationId,input:serialized,promise,controller}
    try{return await promise}finally{signal?.removeEventListener('abort',cancel);set.delete(controller);if(table.pending?.promise===promise)delete table.pending}
  }

  @Remote
  suspendRuntime(input: RuntimeControlRequest): RuntimeControlResult {
    const resolved = this.core.resolveRuntime(input?.runtimeToken)
    if (!resolved.ok) return {ok:false, errorCode:resolved.code, message:resolved.message}
    const lease = resolved.lease
    if (lease.generation !== input.generation || !['running','suspended'].includes(lease.state)) return {ok:false,errorCode:'STALE_RUNTIME',message:'会话已失效'}
    this.abortInFlightAi(lease.runtimeInstanceId, 'SUSPENDED')
    if (lease.state !== 'suspended') lease.suspendedRemainingMs = Math.max(1, Date.parse(lease.expiresAt) - this.core.nowMs())
    lease.state = 'suspended'
    return {ok:true}
  }

  @Remote
  resumeRuntime(input: RuntimeControlRequest): RuntimeControlResult {
    const resolved = this.core.resolveRuntime(input?.runtimeToken)
    if (!resolved.ok) return {ok:false,errorCode:resolved.code,message:resolved.message}
    const lease = resolved.lease
    if (lease.generation !== input.generation || !['running','suspended'].includes(lease.state)) return {ok:false,errorCode:'STALE_RUNTIME',message:'会话已失效'}
    if (lease.state === 'suspended') lease.expiresAt = new Date(this.core.nowMs() + (lease.suspendedRemainingMs ?? lease.ttlMs)).toISOString()
    lease.expiresAt = new Date(this.core.nowMs() + lease.ttlMs).toISOString()
    lease.state = 'running'
    return {ok:true}
  }

  @Remote
  cancelAi(input: CancelAiRequest): {ok: boolean} {
    const resolved = this.core.resolveRuntime(input?.runtimeToken)
    if (!resolved.ok) return {ok:false}
    for (const [key, value] of this.inFlightAiOperations) {
      if (key.startsWith(`${resolved.lease.runtimeInstanceId}\0`) && key.endsWith(`\0${input.operationId}`)) value.abortController.abort('USER_CANCELLED')
    }
    return {ok:true}
  }

  @Remote
  async saveAck(input: SaveAckWireInput): Promise<SaveAckWireOutput> {
    const resolved = this.core.resolveRuntime(input.runtimeToken)
    if (resolved.ok) {
      const { lease } = resolved
      const manifest = await this.runtimeManifest(lease)
      if (manifest && !hasSaveCapability(manifest)) {
        return {
          accepted: false,
          state: lease.state,
          lastPersistedRevision: lease.lastPersistedRevision,
          error: { code: 'SAVE_UNSUPPORTED', message: '游戏未声明存档能力' },
        }
      }
    }
    return this.core.saveAck(input)
  }

  @Remote
  pause(input: PauseWireInput): PauseWireOutput {
    const resolved = this.core.resolveRuntime(input.runtimeToken)
    if (resolved.ok) {
      this.abortInFlightAi(resolved.lease.runtimeInstanceId, 'PAUSED')
    }
    return this.core.pause(input)
  }

  @Remote
  leaseStatus(input: LeaseStatusWireInput): LeaseStatusWireOutput {
    return this.core.leaseStatus(input)
  }

  /**
   * 只读模型目录。`signal` 是 Gateway 注入的取消信号，位于参数表最后，
   * **不是 wire 参数**（api-gateway README「支持取消的 Remote 方法」）。
   */
  @Remote
  async modelCatalog(signal: AbortSignal): Promise<ModelCatalogResult> {
    return this.core.modelCatalog(this.hostCtx.llm, signal)
  }

  @Remote
  async catalogList(input?: CatalogListWireRequest): Promise<CatalogListWireResult> {
    // 远端模式：endpoint 为空时整体静默（契约 §3 条款 14），不报错、不重试。
    if (this.catalogMode === 'remote') {
      if (!this.catalogBaseUrl) {
        return { ok: true, source: 'remote', fetchedAt: '', entries: [], stale: false }
      }
      this.remoteCatalogProvider ??= new RemoteCatalogProvider({
        baseUrl: this.catalogBaseUrl,
        token: this.catalogGithubToken,
        fetcher: this.catalogFetcher ?? this.resilientFetcher,
        cacheStore: new FileCatalogCacheStore(
          path.join(this.gameLibraryDir, '.cache', 'catalogs', 'remote.json'),
        ),
      })
      return listCatalog({
        mode: 'remote',
        provider: this.remoteCatalogProvider,
        approvals: this.approvals,
        gameLibraryDir: this.gameLibraryDir,
        refresh: input?.refresh,
        fetcher: this.catalogFetcher ?? this.resilientFetcher,
      })
    }

    const res = await listCatalog({
      mode: this.catalogMode,
      approvals: this.approvals,
      gameLibraryDir: this.gameLibraryDir,
      fixtureEntries: this.catalogFixtureEntries,
      refresh: input?.refresh,
      fetcher: this.catalogFetcher ?? this.resilientFetcher,
      githubOptions:
        this.catalogMode === 'github'
          ? {
              owner: this.catalogRepo.owner,
              repo: this.catalogRepo.repo,
              token: this.catalogGithubToken,
            }
          : undefined,
    })
    if (!res.ok && typeof res.message === 'object' && res.message !== null) {
      const msgObj = res.message as { message?: string; details?: { status?: number } }
      const statusText = msgObj.details?.status ? ` (HTTP ${msgObj.details.status})` : ''
      return {
        ok: false,
        errorCode: res.errorCode,
        message: `${msgObj.message ?? '目录请求失败'}${statusText}`,
      }
    }
    return res
  }

  @Remote
  async catalogInstall(input: CatalogInstallWireRequest): Promise<CatalogInstallWireResult> {
    const violations = validateCatalogInstallRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    let approval = this.approvals.find(
      (a) =>
        a.gameId === input.gameId &&
        a.commit === input.commit &&
        a.manifestDigest === input.manifestDigest &&
        a.bundleDigest === input.bundleDigest,
    )

    // 远端模式（配置了 catalogBaseUrl）：向后台动态校验该版本是否已审核上架
    //
    // 【网络故障不得伪装成"未审批" · 2026-10-28】原来这段只在 `if (res.ok)` 里做匹配，
    // 异常被 catch 成一句 console.warn 后继续往下走，最后统一落到 UNAPPROVED_RELEASE
    // 「未找到…审批记录」。于是断网、代理挂掉、后台重启、404 全部长得一模一样，
    // 排查方向每次都被带偏（实际只是 `NO_PROXY` 的 CIDR 没生效、请求被推给死代理）。
    // 现在：连不上 / 非 2xx ⇒ `CATALOG_UNREACHABLE`；只有**请求成功且确实没有匹配条目**
    // 才回 UNAPPROVED_RELEASE。
    if (!approval && (this.catalogMode === 'remote' || Boolean(this.catalogBaseUrl))) {
      const baseUrl = (this.catalogBaseUrl || 'http://192.168.3.222:18080/v1').replace(/\/+$/, '')
      const versionsUrl = `${baseUrl}/games/${encodeURIComponent(input.gameId)}/versions`
      const unreachable = (detail: string) => ({
        ok: false as const,
        errorCode: 'CATALOG_UNREACHABLE',
        message: `连不上游戏后台（${baseUrl}）：${detail}。这不是"未审批"，是网络或后台不可达。`,
      })
      try {
        const fetcher: HttpFetcher = this.catalogFetcher ?? this.resilientFetcher
        const res = await fetcher(versionsUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return unreachable(`HTTP ${res.status}`)
        const body = (await res.json()) as any
        const versions = Array.isArray(body) ? body : Array.isArray(body?.versions) ? body.versions : []
        const matched = versions.find((v: any) => {
          const commitMatch = v.commit === input.commit
          const manifestMatch = v.manifestDigest === input.manifestDigest
          const bundleMatch = v.bundleDigest === input.bundleDigest
          const active = v.yanked !== true && v.approvalState !== 'rejected'
          return commitMatch && manifestMatch && bundleMatch && active
        })
        if (matched && matched.repository) {
          approval = {
            gameId: input.gameId,
            commit: input.commit,
            repository: matched.repository,
            manifestDigest: input.manifestDigest,
            bundleDigest: input.bundleDigest,
            approvedAt: matched.publishedAt || matched.updatedAt || new Date().toISOString(),
            approvedBy: 'remote-backend',
            approvalRecordPath: `remote://${input.gameId}/${input.commit}`,
          }
          if (!this.approvals.some(a => a.gameId === approval!.gameId && a.commit === approval!.commit)) {
            this.approvals.push(approval)
          }
        }
      } catch (err) {
        // 畸形 JSON 与网络异常同样属于"后台这条路今天不可用"，一并如实上报。
        return unreachable(describeFetchError(err))
      }
    }

    if (!approval) {
      return {
        ok: false,
        errorCode: 'UNAPPROVED_RELEASE',
        message: `未找到游戏 ${input.gameId} 对应提交 ${input.commit} 的审批记录`,
      }
    }

    const runningVersions = this.getRunningVersions()

    // 检查本地磁盘是否已完成隔离安装：若已安装直接交由 prepareInstall 幂等返回
    const targetDir = path.join(this.gameLibraryDir, input.gameId, input.commit)
    let isAlreadyInstalled = false
    try {
      const stat = await fs.promises.stat(targetDir)
      if (stat.isDirectory()) {
        isAlreadyInstalled = true
      }
    } catch {
      // 未安装
    }

    // 上报钩子：endpoint 未配置时为 undefined，整条链路静默。
    const reporter = (await this.getReportClient())?.forInstall(input.gameId, input.commit)

    let bundledSource: { manifestContent: string; files: readonly InstallSourceFile[] } | undefined
    if (!isAlreadyInstalled) {
      // 契约 §3：下载真正开始时才报 download-start；已安装的幂等路径不报。
      reporter?.downloadStarted?.()
      const fetchRes = await fetchCommitArtifacts({
        repository: approval.repository,
        commit: input.commit,
        // GitHub 产物下载同样直连优先：死代理会把它变成"拉不到产物"，与"提交不存在"混淆。
        fetcher: this.catalogFetcher ?? this.resilientFetcher,
        token: this.catalogGithubToken,
        // 官方 raw 域名不可达的线路上，由配置切到可用镜像（内容仍由摘要把关）。
        rawBase: this.rawBaseUrl,
      })
      if (!fetchRes.ok || !fetchRes.bundledSource) {
        // §11.9：字节没到手 ⇒ `download-fail`（不是 `install-fail`）。不发也不影响记账。
        // 迁移未确认前默认不发：ENUM 会拒收新值，反而制造"上报失败"的噪声。
        if (this.reportDownloadFailures && fetchRes.detail !== undefined) {
          reporter?.downloadFailed?.(fetchRes.detail)
        }
        return {
          ok: false,
          errorCode: fetchRes.errorCode ?? 'PROTOCOL_INVALID',
          message: fetchRes.message ?? '拉取固定提交产物失败',
        }
      }
      bundledSource = fetchRes.bundledSource
    }

    // 安装计划里的 version 会落进 `<gameId>/<commit>/.dsh-installed.json`，供审计与展示读取。
    // 这里**不能**写常量：2026-10-28 实测三个游戏的安装记录版本全是 `1.0.0`，掩盖了真实版本。
    // 取值优先级：包内清单（字节已过 digest 校验）> 本地已有安装记录 > 兜底常量。
    let resolvedVersion = '1.0.0'
    const manifestContent = bundledSource?.manifestContent
    if (typeof manifestContent === 'string') {
      try {
        const parsedManifest = JSON.parse(manifestContent) as { version?: unknown }
        if (typeof parsedManifest.version === 'string' && parsedManifest.version !== '') {
          resolvedVersion = parsedManifest.version
        }
      } catch {
        // 清单畸形：安装器随后会以 PROTOCOL_INVALID 拒绝，这里不额外抛错。
      }
    } else {
      // 幂等路径（已安装，不重新下载）：沿用本地记录的版本，避免把真实版本覆盖成占位符。
      try {
        const metaRaw = await fs.promises.readFile(path.join(targetDir, '.dsh-installed.json'), 'utf-8')
        const meta = JSON.parse(metaRaw) as { version?: unknown }
        if (typeof meta.version === 'string' && meta.version !== '') {
          resolvedVersion = meta.version
        }
      } catch {
        // 读不到记录就保持兜底常量；该路径不会重写元数据。
      }
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
        version: resolvedVersion,
      },
      approvals: approval && !this.approvals.some(a => a.gameId === approval.gameId && a.commit === approval.commit)
        ? [...this.approvals, approval]
        : this.approvals,
      gameLibraryDir: this.gameLibraryDir,
      stagingDir: path.join(this.gameLibraryDir, '.staging'),
      bundledSource,
      runningVersions,
      dshObservation: this.dshObservation,
      gameCenterObservation: this.gameCenterObservation,
      reporter,
    })
  }

  @Remote
  async catalogUninstall(input: CatalogUninstallWireRequest): Promise<CatalogUninstallWireResult> {
    const violations = validateCatalogUninstallRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    // 检查活动运行租约：若游戏处于活跃租约中（running/pausing/pending），拒绝卸载
    const activeLeases = this.core.inspect(input.gameId)
    const isRunning = activeLeases.some((l) => l.state === 'running' || l.state === 'pausing' || l.state === 'pending')
    if (isRunning) {
      return {
        ok: false,
        errorCode: 'STALE_RUNTIME',
        message: `游戏 ${input.gameId} 正在运行中，请先退出游戏后再卸载`,
      }
    }

    const commit = input.commit
    if (commit) {
      const res = await uninstallGamePackage(this.gameLibraryDir, input.gameId, commit)
      if (!res.ok) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: res.reason || '卸载指定版本失败',
        }
      }
      return {
        ok: true,
        gameId: input.gameId,
        commit,
        removedPath: res.removedPath || path.join(this.gameLibraryDir, input.gameId, commit),
      }
    } else {
      // 卸载整个 gameId 的已安装目录
      const gameDir = path.join(this.gameLibraryDir, input.gameId)
      try {
        await fs.promises.rm(gameDir, { recursive: true, force: true })
        return {
          ok: true,
          gameId: input.gameId,
          removedPath: gameDir,
        }
      } catch (err: any) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `卸载游戏失败: ${err?.message || String(err)}`,
        }
      }
    }
  }

  @Remote
  async gameBundle(input: GameBundleWireRequest): Promise<GameBundleWireResult> {
    if (!input || typeof input !== 'object' || typeof input.gameId !== 'string' || typeof input.commit !== 'string') {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '入参必须包含非空的 gameId 与 commit',
      }
    }
    const runningVersions = this.getRunningVersions()
    return readInstalledBundle({
      gameLibraryDir: this.gameLibraryDir,
      gameId: input.gameId,
      commit: input.commit,
      runningVersions,
      dshObservation: this.dshObservation,
      gameCenterObservation: this.gameCenterObservation,
    })
  }

  private getRunningVersions(): { gameCenter: string; dsh: string } | null {
    if (this.runningVersions !== undefined) {
      return this.runningVersions
    }
    if (this.dshObservation !== undefined || this.gameCenterObservation !== undefined) {
      const pair = resolveRunningVersions(this.gameCenterObservation, this.dshObservation)
      if (pair.ok) {
        return pair.pair
      }
      return null
    }
    // 默认 fail closed：未取得当前进程绑定的版本证据前，不补历史 lock 或 SDK_VERSION
    return null
  }

  private async resolveGameManifest(gameId: string, commit?: string): Promise<GameManifestV1 | null> {
    if (this.manifestResolver) {
      try {
        const m = await this.manifestResolver(gameId, commit)
        if (m) return m
      } catch {
        // 自定义解析失败回退本地
      }
    }

    // 1. 尝试从已安装目录读取
    if (commit) {
      const commitManifest = path.join(this.gameLibraryDir, gameId, commit, 'gamecenter.json')
      try {
        const raw = await fs.promises.readFile(commitManifest, 'utf-8')
        const parsed = JSON.parse(raw) as GameManifestV1
        if (parsed.id !== gameId || parsed.schemaVersion !== 1) return null
        const approval = this.approvals.find(a => a.gameId === gameId && a.commit === commit)
        if (!approval || calculateManifestDigest(raw) !== approval.manifestDigest) return null
        return parsed
      } catch {
        // 未找到
      }
      return null
    } else {
      // 遍历 gameLibraryDir/gameId 下的子目录查找已安装版本
      const gameDir = path.join(this.gameLibraryDir, gameId)
      try {
        const entries = await fs.promises.readdir(gameDir, { withFileTypes: true })
        if (entries.filter(ent => ent.isDirectory() && !ent.name.startsWith('.')).length > 1) return null
        for (const ent of entries) {
          if (ent.isDirectory() && !ent.name.startsWith('.')) {
            const mPath = path.join(gameDir, ent.name, 'gamecenter.json')
            try {
              const raw = await fs.promises.readFile(mPath, 'utf-8')
              return JSON.parse(raw) as GameManifestV1
            } catch {
              // 继续
            }
          }
        }
      } catch {
        // 目录不存在
      }
    }

    // 2. 尝试从预览目录读取
    if (this.previewDir) {
      const previewManifest = path.join(this.previewDir, gameId, 'gamecenter.json')
      try {
        const raw = await fs.promises.readFile(previewManifest, 'utf-8')
        return JSON.parse(raw) as GameManifestV1
      } catch {
        // 未找到
      }
    }

    return null
  }

  @Remote
  async saveLatest(input: SaveLatestWireRequest): Promise<SaveLatestWireResult> {
    const violations = validateSaveLatestRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    const activeLease = this.core.registry.get(input.gameId, input.saveId)
    const manifest = activeLease && input.commit === undefined ? await this.runtimeManifest(activeLease) : await this.resolveGameManifest(input.gameId, input.commit)
    if (manifest && !hasSaveCapability(manifest)) {
      return {
        ok: false,
        errorCode: 'SAVE_UNSUPPORTED',
        message: '游戏未声明存档能力',
      }
    }

    const readRes = await this.saveStore.readCheckpoint(input.gameId, input.saveId, {
      playerId: this.playerId,
    })
    if (!readRes.ok) {
      if (readRes.message.includes('未找到存档文件')) {
        return { ok: true, absent: true }
      }
      return {
        ok: false,
        errorCode: readRes.code,
        message: readRes.message,
      }
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
    }
  }

  @Remote
  async saveCheckpoint(input: SaveCheckpointWireRequest): Promise<SaveCheckpointWireResult> {
    const violations = validateSaveCheckpointRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
        retryable: false,
      }
    }

    // 统一走**同一个**身份解析入口 `GameCenterCore.resolveRuntime()`：
    // 早期这里写的是 `this.core.resolveRuntime(...)`，而 `GameCenterCore` 上根本没有该方法
    // （核心只持有 deps），一旦走到这一支就抛 TypeError，被接管的旧实例凭证写入因此
    // 以 PROTOCOL_INVALID（甚至网关层的未预期异常）返回，而不是确定性的 STALE_RUNTIME。
    // 探针 N7e 抓到该缺陷；修复后同一路径返回 STALE_RUNTIME / token-superseded。
    const resolved = this.core.resolveRuntime(input.runtimeToken)
    if (!resolved.ok) {
      return {
        ok: false,
        errorCode: resolved.code as 'PROTOCOL_INVALID' | 'STALE_RUNTIME' | 'INTERNAL',
        message: resolved.message,
        retryable: false,
      }
    }
    const { lease } = resolved

    const manifest = await this.runtimeManifest(lease)
    if (!manifest) return {ok:false,errorCode:'PROTOCOL_INVALID',message:'未找到当前运行版本的可信 manifest',retryable:false}
    if (!hasSaveCapability(manifest)) {
      return {
        ok: false,
        errorCode: 'SAVE_UNSUPPORTED',
        message: '游戏未声明存档能力',
        retryable: false,
      }
    }

    if (typeof input.gameId === 'string' && input.gameId !== lease.gameId) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '声明的 gameId 与运行凭证不符。',
        retryable: false,
      }
    }
    if (typeof input.saveId === 'string' && input.saveId !== lease.saveId) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '声明的 saveId 与运行凭证不符。',
        retryable: false,
      }
    }

    const currentNowMs = this.core.nowMs()
    const admissionInput = typeof input.generation === 'number'
      ? { generation: input.generation, nowMs: currentNowMs }
      : { nowMs: currentNowMs }
    const admission = decideCheckpointAdmission(
      {
        state: lease.state,
        sealed: lease.sealed,
        generation: lease.generation,
        expiresAtMs: Date.parse(lease.expiresAt),
      },
      admissionInput,
    )
    if (!admission.ok) {
      const errorCode = admission.errorCode === 'PAUSED' ? 'STALE_RUNTIME' : admission.errorCode
      return {
        ok: false,
        errorCode,
        message: admission.message,
        retryable: false,
      }
    }

    // 暂停期间写保护：绑定单轮授权最终操作，拒绝额外检查点写入（允许同一 operationId 幂等重试）
    if (lease.state === 'pausing') {
      if (
        lease.authorizedFinalOperationId !== undefined &&
        lease.authorizedFinalOperationId !== input.operationId
      ) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `暂停期间只允许授权的最终检查点操作 (${lease.authorizedFinalOperationId}) 及其幂等重试，拒绝额外写入 (${input.operationId})。`,
          retryable: false,
        }
      }
    }

    const installedCommit = this.runtimeTargets.get(lease.runtimeInstanceId)?.commit ?? (this.manifestResolver ? (input as {installedCommit?:string}).installedCommit : undefined)
    if (!installedCommit || !/^[a-f0-9]{40}$/.test(installedCommit)) return {ok:false, errorCode:'PROTOCOL_INVALID', message:'存档缺少绑定的固定提交', retryable:false}
    const writeRes = await this.saveStore.writeCheckpoint({
      playerId: this.playerId,
      gameId: lease.gameId,
      saveId: lease.saveId,
      generation: lease.generation,
      activeGeneration: lease.generation,
      isSealed: lease.sealed,
      installedCommit,
      gameStateSchemaVersion: (input as { gameStateSchemaVersion?: number }).gameStateSchemaVersion ?? 1,
      elapsedGameMs: input.elapsedGameMs,
      rngState: input.rngState,
      modelBindings: {},
      state: input.state,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
    })

    if (!writeRes.ok) {
      const errRes: SaveCheckpointWireResult = {
        ok: false,
        errorCode: writeRes.code as 'STALE_RUNTIME' | 'RATE_LIMIT' | 'PROTOCOL_INVALID' | 'INTERNAL',
        message: writeRes.message,
        retryable: writeRes.code === 'RATE_LIMIT',
      }
      if (typeof writeRes.currentRevision === 'number') {
        errRes.currentRevision = writeRes.currentRevision
      }
      return errRes
    }

    if (lease.state === 'pausing') {
      lease.authorizedFinalOperationId = input.operationId
    }
    lease.lastPersistedRevision = writeRes.revision

    return {
      ok: true,
      revision: writeRes.revision,
      idempotentReplay: writeRes.idempotentReplay,
    }
  }

  @Remote
  async previewList(): Promise<PreviewListWireResult> {
    if (!this.previewDir) {
      return { ok: true, configured: false, entries: [] }
    }
    try {
      const stat = await fs.promises.stat(this.previewDir)
      if (!stat.isDirectory()) {
        return { ok: true, configured: false, entries: [] }
      }
    } catch {
      return { ok: true, configured: false, entries: [] }
    }

    const entries: PreviewListWireEntry[] = []
    try {
      const subdirs = await fs.promises.readdir(this.previewDir, { withFileTypes: true })
      for (const sub of subdirs) {
        if (!sub.isDirectory()) continue
        const manifestPath = path.join(this.previewDir, sub.name, 'gamecenter.json')
        try {
          const raw = await fs.promises.readFile(manifestPath, 'utf-8')
          const manifest = JSON.parse(raw) as GameManifestV1
          entries.push({
            previewId: sub.name,
            gameId: manifest.id,
            name: manifest.name,
            categories: manifest.categories??[],
            version: manifest.version,
            source: 'fixture',
            label: GAME_PREVIEW_LABEL,
            installable: false,
          })
        } catch {
          // 跳过无效子目录
        }
      }
      return { ok: true, configured: true, entries }
    } catch (e) {
      return {
        ok: false,
        errorCode: 'INTERNAL',
        message: `读取预览目录失败: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  @Remote
  async previewBundle(input: PreviewBundleWireRequest): Promise<PreviewBundleWireResult> {
    if (!this.previewDir) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '未配置预览目录 previewDir',
      }
    }
    const violations = validatePreviewBundleRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    const targetDir = path.join(this.previewDir, input.previewId)
    let manifest: GameManifestV1 & { compatibility?: { gameCenter: string; dsh: string } }
    try {
      const raw = await fs.promises.readFile(path.join(targetDir, 'gamecenter.json'), 'utf-8')
      manifest = JSON.parse(raw) as GameManifestV1 & { compatibility?: { gameCenter: string; dsh: string } }
    } catch (e) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `读取预览目录 manifest 失败: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    // 平台兼容门禁校验 (阶段1：仅在声明了 compatibility 时门禁介入；若未决或不匹配拒绝下发)
    if (manifest.compatibility) {
      const runningVersions = this.getRunningVersions()
      if (!runningVersions) {
        return {
          ok: false,
          errorCode: 'COMPAT_UNRESOLVED',
          message: '无法解析当前运行宿主或游戏中心版本，已阻止下发预览产物',
        }
      }
      const evalRes = evaluateCompatibility(manifest.compatibility, runningVersions, sdkRangeAccepts)
      if (!evalRes.ok) {
        return {
          ok: false,
          errorCode: 'INCOMPATIBLE_RUNTIME',
          message: evalRes.reason,
        }
      }
    }

    const bundleFiles: GameBundleWireFile[] = []
    const walk = async (dir: string): Promise<{ ok: boolean; error?: string }> => {
      let items: fs.Dirent[]
      try {
        items = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return { ok: false, error: `无法读取目录 ${dir}` }
      }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isSymbolicLink()) {
          return { ok: false, error: `检测到符号链接 ${full}，禁止包含在游戏产物中` }
        }
        if (item.isDirectory()) {
          const subRes = await walk(full)
          if (!subRes.ok) return subRes
        } else if (item.isFile()) {
          const rel = path.relative(targetDir, full).replace(/\\/g, '/')
          if (!isSafeBundlePath(rel)) {
            return { ok: false, error: `文件路径不安全或后缀不在白名单：${rel}` }
          }
          const content = await fs.promises.readFile(full, 'utf-8')
          bundleFiles.push({ path: rel, content })
        }
      }
      return { ok: true }
    }

    const walkRes = await walk(targetDir)
    if (!walkRes.ok) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: walkRes.error ?? '扫描预览文件失败',
      }
    }

    const fileViolations = validateGameBundleFiles(bundleFiles)
    if (fileViolations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: fileViolations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    let totalBytes = 0
    for (const f of bundleFiles) {
      totalBytes += bundleContentBytes(f.content)
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
    }
  }

  @Remote
  async abandonRuntime(input: AbandonRuntimeRequest): Promise<AbandonRuntimeResult> {
    const result=this.core.abandonRuntime(input)
    if(result.ok){
      this.abortInFlightAi(input.runtimeInstanceId, 'ABANDONED')
      this.landlordTables.delete(input.runtimeInstanceId)
      this.arenaModes.delete(input.runtimeInstanceId)
      for(const key of this.arenaModeOperations.keys())if(key.startsWith(input.runtimeInstanceId+'\0'))this.arenaModeOperations.delete(key)
      for(const key of this.aiBindings.keys())if(key.startsWith(`${input.runtimeInstanceId}\0`))this.aiBindings.delete(key)
    }
    return result
  }

  @Remote
  async mediaFetch(input: MediaFetchRequest): Promise<MediaFetchResult> {
    // 媒体安全未决保护（fail closed）：在安全审计全套闭环前，默认禁用媒体拉取，不发任何网络请求
    if (!this.mediaSecurityVerified) {
      return {
        ok: false,
        errorCode: 'MEDIA_UNAVAILABLE',
        message: '媒体拉取安全校验未通过，暂不可用',
      }
    }

    const violations = validateMediaFetchRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    if (
      typeof input.expectedMime !== 'string' ||
      input.expectedMime.length === 0 ||
      typeof input.expectedSha256 !== 'string' ||
      input.expectedSha256.length === 0
    ) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: 'expectedMime 与 expectedSha256 必须必填（来自已验证目录元数据）',
      }
    }

    if (!isAllowedMediaUrl(input.url, this.allowedMediaHosts)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: 'url 必须是不含 userinfo / 非默认端口 / 白名单主机上的 https URL',
      }
    }

    const fetcher: MediaHttpFetcher =
      this.mediaFetcher ??
      (async (url: string, opts) => {
        const fetchOpts: RequestInit = {
          credentials: 'omit',
          redirect: opts?.redirect ?? 'manual',
        }
        if (opts?.signal) {
          fetchOpts.signal = opts.signal
        }
        const res = await fetch(url, fetchOpts)
        return {
          ok: res.ok,
          status: res.status,
          url: res.url,
          headers: res.headers,
          body: res.body as unknown as ReadableStream<Uint8Array> | null,
          arrayBuffer: () => res.arrayBuffer(),
        }
      })

    let currentUrl = input.url
    let redirectCount = 0
    let resp: {
      ok: boolean
      status: number
      url?: string
      headers: { get(key: string): string | null }
      body?: ReadableStream<Uint8Array> | null
      arrayBuffer(): Promise<ArrayBuffer>
    } | undefined

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    try {
      while (true) {
        if (!isAllowedMediaUrl(currentUrl, this.allowedMediaHosts)) {
          return {
            ok: false,
            errorCode: 'PROTOCOL_INVALID',
            message: `媒体请求目标 URL 不在允许的主机白名单内: ${currentUrl}`,
          }
        }

        let hostname = ''
        try {
          hostname = new URL(currentUrl).hostname
        } catch {
          return {
            ok: false,
            errorCode: 'PROTOCOL_INVALID',
            message: `非法媒体 URL: ${currentUrl}`,
          }
        }

        // DNS 解析防 SSRF / 私网回环拦截
        let resolvedIp = ''
        try {
          const lookupFn = this.dnsLookup ?? dns.lookup
          const dnsRes = await lookupFn(hostname)
          resolvedIp = dnsRes.address
        } catch (e) {
          return {
            ok: false,
            errorCode: 'MEDIA_UNREACHABLE',
            message: `DNS 解析主机失败 (${hostname}): ${e instanceof Error ? e.message : String(e)}`,
          }
        }

        if (isPrivateOrLoopbackIp(resolvedIp)) {
          return {
            ok: false,
            errorCode: 'MEDIA_UNREACHABLE',
            message: `禁止访问私有内网或回环 IP 地址 (${hostname} -> ${resolvedIp})`,
          }
        }

        try {
          resp = await fetcher(currentUrl, {
            signal: controller.signal,
            redirect: 'manual',
            credentials: 'omit',
          })
        } catch (e) {
          return {
            ok: false,
            errorCode: 'MEDIA_UNREACHABLE',
            message: `媒体资源网络请求失败: ${e instanceof Error ? e.message : String(e)}`,
          }
        }

        // 显式每跳重定向拦截 (301, 302, 307, 308)
        if (resp.status >= 300 && resp.status < 400) {
          redirectCount++
          if (redirectCount > 3) {
            return {
              ok: false,
              errorCode: 'PROTOCOL_INVALID',
              message: '媒体重定向次数超过上限 (最多 3 次)',
            }
          }
          const location = resp.headers.get('location')
          if (!location) {
            return {
              ok: false,
              errorCode: 'MEDIA_UNREACHABLE',
              message: `媒体重定向响应 (HTTP ${resp.status}) 缺少 Location 头`,
            }
          }
          try {
            currentUrl = new URL(location, currentUrl).href
          } catch {
            return {
              ok: false,
              errorCode: 'PROTOCOL_INVALID',
              message: `媒体重定向 Location 格式非法: ${location}`,
            }
          }
          continue
        }

        break
      }
    } finally {
      clearTimeout(timer)
    }

    if (!resp || !resp.ok) {
      return {
        ok: false,
        errorCode: 'MEDIA_UNREACHABLE',
        message: `媒体资源获取响应非 2xx: HTTP ${resp?.status ?? 0}`,
      }
    }

    // 重定向每跳安全校验：最终落地 URL 若脱离白名单域名坚决拦截
    if (resp.url && !isAllowedMediaUrl(resp.url, this.allowedMediaHosts)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: '媒体重定向最终目标 URL 不在允许的主机白名单内',
      }
    }

    // 统一语义：接入媒体不得越过 catalog 单图上限 MEDIA_MAX_BYTES_PER_IMAGE (2 MiB)
    const maxBytes =
      input.maxBytes !== undefined
        ? Math.min(input.maxBytes, MEDIA_MAX_BYTES_PER_IMAGE)
        : MEDIA_MAX_BYTES_PER_IMAGE
    const rawLenHeader = resp.headers.get('content-length')
    if (rawLenHeader) {
      const len = Number(rawLenHeader)
      if (Number.isFinite(len) && len > maxBytes) {
        return {
          ok: false,
          errorCode: 'MEDIA_TOO_LARGE',
          message: `媒体体积超出上限: 声明大小 ${len} > ${maxBytes}`,
        }
      }
    }

    let buf: Buffer
    try {
      if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            const chunk = value as unknown as Uint8Array
            total += chunk.byteLength
            if (total > maxBytes) {
              await reader.cancel()
              return {
                ok: false,
                errorCode: 'MEDIA_TOO_LARGE',
                message: `媒体体积超出上限: 流式读取超出 ${maxBytes} 字节，连接已主动中断`,
              }
            }
            chunks.push(chunk)
          }
        }
        buf = Buffer.concat(chunks)
      } else {
        const ab = await resp.arrayBuffer()
        buf = Buffer.from(new Uint8Array(ab))
      }
    } catch (e) {
      return {
        ok: false,
        errorCode: 'MEDIA_UNREACHABLE',
        message: `读取媒体字节失败: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    if (buf.length > maxBytes) {
      return {
        ok: false,
        errorCode: 'MEDIA_TOO_LARGE',
        message: `媒体体积超出上限: 实际大小 ${buf.length} > ${maxBytes}`,
      }
    }

    const rawType = resp.headers.get('content-type') ?? ''
    const mime = rawType.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!MEDIA_ALLOWED_MIMES.includes(mime as any)) {
      return {
        ok: false,
        errorCode: 'MEDIA_MIME_MISMATCH',
        message: `媒体 MIME '${mime}' 不在允许的白名单内 (仅限 png/jpeg/webp/gif)`,
      }
    }

    // 实际文件魔数 (magic bytes) 校验，防止伪造 content-type 绕过 MIME 检查
    if (!matchesImageMagicBytes(buf, mime)) {
      return {
        ok: false,
        errorCode: 'MEDIA_MIME_MISMATCH',
        message: `媒体文件内容魔数与声明的 MIME 类型 '${mime}' 不符`,
      }
    }

    // 图像实际像素尺寸解码与上限校验 (MEDIA_MAX_EDGE_PX = 4096)
    const dimensions = parseImageDimensions(buf, mime)
    if (!dimensions) {
      return {
        ok: false,
        errorCode: 'MEDIA_MIME_MISMATCH',
        message: `无法解析媒体图像尺寸或格式损坏 (MIME: ${mime})`,
      }
    }
    if (dimensions.width > MEDIA_MAX_EDGE_PX || dimensions.height > MEDIA_MAX_EDGE_PX) {
      return {
        ok: false,
        errorCode: 'MEDIA_MIME_MISMATCH',
        message: `媒体图像尺寸超出上限 (${dimensions.width}x${dimensions.height} > ${MEDIA_MAX_EDGE_PX}px)`,
      }
    }

    if (!input.expectedMime || input.expectedMime.toLowerCase() !== mime) {
      return {
        ok: false,
        errorCode: 'MEDIA_MIME_MISMATCH',
        message: `媒体 MIME 不匹配: 收到 '${mime}'，期望 '${input.expectedMime}'`,
      }
    }

    const sha256Hex = createHash('sha256').update(buf).digest('hex')
    const expectedNormalized = (input.expectedSha256 ?? '').replace(/^sha256:/i, '').toLowerCase()
    if (!input.expectedSha256 || sha256Hex !== expectedNormalized) {
      return {
        ok: false,
        errorCode: 'MEDIA_DIGEST_MISMATCH',
        message: `媒体 SHA-256 不匹配: 实际 'sha256:${sha256Hex}'，期望 '${input.expectedSha256}'`,
      }
    }

    return {
      ok: true,
      mime: mime as MediaMime,
      sha256: `sha256:${sha256Hex}`,
      byteLength: buf.length,
      dataBase64: buf.toString('base64'),
    }
  }

  @Remote
  async aiGenerate(input: AiGenerateWireRequest, signal?: AbortSignal): Promise<AiGenerateWireResult> {
    const game=this.core.resolveRuntime(input?.runtimeToken)
    if(game.ok && game.lease.gameId === 'example.minesweeping') return {ok:false,errorCode:'CAPABILITY_UNAVAILABLE',message:'扫雷 AI 接入已取消，请使用本地经典模式'}
    if(game.ok && game.lease.gameId === 'example.landlord') return {ok:false,errorCode:'CAPABILITY_UNAVAILABLE',message:'斗地主仅允许 Host 为当前座位构造模型请求'}
    const violations = validateAiGenerateRequest(input)
    if (violations.length > 0) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: violations.map((v) => `${v.field}: ${v.reason}`).join('; '),
      }
    }

    // 1. 租约与身份核验
    const resolved = this.core.resolveRuntime(input.runtimeToken)
    if (!resolved.ok) {
      return {
        ok: false,
        errorCode: resolved.code as any,
        message: resolved.message,
      }
    }
    const { lease } = resolved

    // 已封存或非活跃状态一律拒绝
    if (lease.sealed || lease.state !== 'running') {
      return {
        ok: false,
        errorCode: 'STALE_RUNTIME',
        message: '当前运行实例已封存或未处于活跃状态，禁止执行 AI 请求',
      }
    }

    // 2. 核验 slot 是否在游戏 manifest capabilities 中合法声明
    const manifest = await this.runtimeManifest(lease)
    const declaredSlots = (manifest as any)?.ai?.slots
    if (!declaredSlots || typeof declaredSlots !== 'object' || !(input.slot in declaredSlots)) {
      return {
        ok: false,
        errorCode: 'PROTOCOL_INVALID',
        message: `游戏 ${lease.gameId} 未声明 AI slot '${input.slot}'`,
      }
    }

    const currentAiLease=this.core.resolveRuntime(input.runtimeToken)
    if(!currentAiLease.ok||currentAiLease.lease!==lease||lease.sealed||lease.state!=='running')return {ok:false,errorCode:'STALE_RUNTIME',message:'读取资源期间会话已暂停或关闭'}

    // Prefetch is independent of the human build; only the current round ID may enter.
    const arenaTable=lease.gameId==='example.cat-arena'?this.arenaModes.get(lease.runtimeInstanceId):undefined
    if(lease.gameId==='example.cat-arena'){
      const raw=input.input as Record<string,unknown>|null
      if(input.slot!=='vehicleBuild'||arenaTable?.mode!=='duel'||!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>k!=='roundId')||raw.roundId!==arenaTable.roundId)
        return {ok:false,errorCode:'PROTOCOL_INVALID',message:'AI 对战模式或对局编号不匹配'}
      if(arenaTable.planJson)return {ok:false,errorCode:'RATE_LIMIT',message:'对局已开战'}
      if(arenaTable.operationId&&arenaTable.operationId!==input.operationId)return {ok:false,errorCode:'RATE_LIMIT',message:'本局装配已锁定；请开始新对局'}
    }

    // 3. 作用域隔离与并发单飞防重入：同一 runtimeInstanceId + slot + operationId 隔离
    const scopeKey = `${lease.runtimeInstanceId}\u0000${lease.gameId}\u0000${input.slot}\u0000${input.operationId}`
    const serializedInput = JSON.stringify(input.input)
    const existing = this.aiOperations.get(scopeKey)
    if (existing) {
      if (existing.inputJson !== serializedInput) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `同一 operationId (${input.operationId}) 携带了不同的 input 内容`,
        }
      }
      return existing.result ?? { ok: true, output: existing.output as any }
    }

    // 在途并发单飞（Single-Flight）：遇到相同在途请求复用 Promise，冲突入参立即拦截
    const inFlight = this.inFlightAiOperations.get(scopeKey)
    if (inFlight) {
      if (inFlight.inputJson !== serializedInput) {
        return {
          ok: false,
          errorCode: 'PROTOCOL_INVALID',
          message: `同一 operationId (${input.operationId}) 携带了不同的 input 内容`,
        }
      }
      return inFlight.promise
    }

    // 4. 零费用防御与 Broker 路由
    const binding = this.aiBindings.get(`${lease.runtimeInstanceId}\0${input.slot}`)
    if (!this.aiBroker && !binding) {
      return {
        ok: false,
        errorCode: 'CAPABILITY_UNAVAILABLE',
        message: 'AI 生成能力暂不可用或未配置模型接入',
        retryable: false,
      }
    }

    // 5. 调用受控 Broker 执行（绑定 AbortController 与主动取消）
    if (signal?.aborted) {
      return {
        ok: false,
        errorCode: 'INTERNAL',
        message: 'AI 生成请求已被调用方取消',
        retryable: false,
      }
    }

    const abortController = new AbortController()
    let arenaTrace:ArenaAiTrace|undefined
    if(arenaTable){
      arenaTable.operationId=input.operationId
      arenaTrace={operationId:input.operationId,status:'pending',binding:binding??{providerId:'injected',modelId:'injected'},request:arenaBuildPrompt(arenaTable.previousRound),response:'',feedback:'等待模型返回',elapsedMs:0}
      arenaTable.traces.push(arenaTrace);if(arenaTable.traces.length>8)arenaTable.traces.shift()
    }
    if (signal) {
      signal.addEventListener('abort', () => {
        try {
          abortController.abort(signal.reason)
        } catch {
          // ignore
        }
      }, { once: true })
    }

    let instanceSet = this.inFlightAiByRuntimeInstance.get(lease.runtimeInstanceId)
    if (!instanceSet) {
      instanceSet = new Set()
      this.inFlightAiByRuntimeInstance.set(lease.runtimeInstanceId, instanceSet)
    }
    instanceSet.add(abortController)

    lease.expiresAt = new Date(this.core.nowMs() + 150_000).toISOString()
    const opPromise = (async (): Promise<AiGenerateWireResult> => {
      try {
        const generated = this.aiBroker
          ? {output: await this.aiBroker(input.slot, input.input, abortController.signal)}
          : arenaTable?await generateArenaBuild(this.hostCtx.llm,binding!,abortController.signal,value=>{if(arenaTrace)Object.assign(arenaTrace,value)},arenaTable.previousRound)
          : await generateBoard(this.hostCtx.llm, binding!, input.slot, input.input, abortController.signal)
        const output = arenaTable?JSON.parse(JSON.stringify(quoteArenaPlan(generated.output).plan)):generated.output
        // 成功返回前再次检查租约与取消状态：已作废或已关闭不回写
        const recheck = this.core.resolveRuntime(input.runtimeToken)
        if (!recheck.ok || recheck.lease.sealed || recheck.lease.state !== 'running' || abortController.signal.aborted || arenaTable&&this.arenaModes.get(lease.runtimeInstanceId)!==arenaTable) {
          return {
            ok: false,
            errorCode: 'STALE_RUNTIME',
            message: '请求完成时实例已作废或关闭，结果被丢弃',
          }
        }
        if(arenaTable){arenaTable.aiPlan=output;if(arenaTrace&&arenaTrace.status==='pending')Object.assign(arenaTrace,{status:'succeeded',response:JSON.stringify(output),feedback:'方案校验通过'})}
        this.aiOperations.set(scopeKey, {
          inputJson: serializedInput,
          output,
          result: {ok:true, ...generated,output} as AiGenerateWireResult,
        })
        return {ok:true, ...generated,output} as AiGenerateWireResult
      } catch (err: any) {
        if(arenaTrace&&arenaTrace.status==='pending')Object.assign(arenaTrace,{status:abortController.signal.aborted?'cancelled':'failed',feedback:err instanceof Error?err.message:'生成失败'})
        if (abortController.signal.aborted || err?.name === 'AbortError') {
          if (signal?.aborted) {
            return {
              ok: false,
              errorCode: 'INTERNAL',
              message: 'AI 生成请求已被调用方取消',
              retryable: false,
            }
          }
          return {
            ok: false,
            errorCode: 'STALE_RUNTIME',
            message: '实例已作废或关闭，请求已被取消',
            retryable: false,
          }
        }
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: `AI Broker 执行异常: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        }
      } finally {
        if(arenaTable&&!this.aiOperations.has(scopeKey)&&arenaTable.operationId===input.operationId){delete arenaTable.operationId}
        this.inFlightAiOperations.delete(scopeKey)
        const set = this.inFlightAiByRuntimeInstance.get(lease.runtimeInstanceId)
        if (set) {
          set.delete(abortController)
          if (set.size === 0) {
            this.inFlightAiByRuntimeInstance.delete(lease.runtimeInstanceId)
          }
        }
      }
    })()

    this.inFlightAiOperations.set(scopeKey, {
      inputJson: serializedInput,
      promise: opPromise,
      abortController,
    })

    return opPromise
  }
}

/**
 * 把核心方法装配成 Typert Remote 服务类实例。
 * 协议模块不可用或 Context 缺失时显式抛错，严禁静默失败。
 */
export function defineGameCenterService(
  core: GameCenterCore,
  ctx: GameCenterHostContext,
  options: Partial<GameCenterServiceOptions> = {},
): GameCenterService {
  if (typeof ctx.effect !== 'function') {
    throw new TypeError('@dsh-gamecenter/host: ctx 缺少 effect 方法，无法装配 Cordis 插件')
  }
  const fullOptions: GameCenterServiceOptions = {
    playerId: options.playerId ?? 'test-host-player',
    wallet: options.wallet,
    saveStore: options.saveStore ?? new SaveStore(new SqliteSaveBackend({ dbPath: ':memory:' })),
    gameLibraryDir: options.gameLibraryDir ?? path.join(os.tmpdir(), 'dsh-games-test'),
    previewDir: options.previewDir,
    approvals: options.approvals ?? [],
    catalogMode: options.catalogMode ?? (options.catalogBaseUrl ? 'remote' : 'github'),
    catalogFixtureEntries: options.catalogFixtureEntries ?? [],
    catalogRepo: options.catalogRepo ?? DEFAULT_CATALOG_REPO,
    catalogGithubToken: options.catalogGithubToken,
    catalogFetcher: options.catalogFetcher,
    runningVersions: options.runningVersions,
    dshObservation: options.dshObservation,
    gameCenterObservation: options.gameCenterObservation,
    allowedMediaHosts: options.allowedMediaHosts,
    mediaFetcher: options.mediaFetcher,
    dnsLookup: options.dnsLookup,
    mediaSecurityVerified: options.mediaSecurityVerified,
    manifestResolver: options.manifestResolver,
    aiBroker: options.aiBroker,
    catalogBaseUrl: options.catalogBaseUrl,
    rawBaseUrl: options.rawBaseUrl ?? process.env.DSH_GAMECENTER_RAW_BASE,
    reportDownloadFailures: options.reportDownloadFailures,
    installId: options.installId,
  }
  return new GameCenterService(ctx as Context, core, fullOptions)
}
