import type { HttpFetcher } from './githubProvider.js'
import type { InstallReporter } from '../install/types.js'

/**
 * 下载/安装上报客户端（阶段 3，契约 `docs/gamecenter-admin-backend.md` §3）。
 *
 * 硬规则：
 * - fire-and-forget：永不抛错、永不阻塞下载或安装，失败静默；
 * - 不带任何可识别个人的信息：只有随机 `installId`、`gameId`、`commit`、时间与客户端版本；
 * - 统计永不参与安装判定，上报结果不改变任何门禁。
 */

export const REPORT_KINDS = [
  'download-start',
  'download-fail',
  'install-ok',
  'install-fail',
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/**
 * §11.9：结构化诊断数据（§11.8 的形状去掉 `gameId`/`commit`，那两个已是顶层字段）。
 * 这是**诊断数据不是契约事实**：不发照常记账，发了也永不改变本地判定。
 */
export interface ReportDetail {
  phase?: 'connect' | 'headers' | 'body' | 'verify' | undefined
  winnerRoute?: 'proxy' | 'direct' | 'mirror' | undefined
  code?: 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNREACHABLE' | undefined
  attempts?: ReportAttempt[] | undefined
}

export interface ReportAttempt {
  route: 'proxy' | 'direct' | 'mirror'
  proxy?: string | undefined
  phase: 'connect' | 'headers' | 'body' | 'verify'
  cause: string
  elapsedMs: number
  resolvedIp?: string | undefined
}

export interface RemoteReportPayload {
  schemaVersion: 1
  kind: ReportKind
  installId: string
  gameId: string
  commit?: string | undefined
  at: string
  client?: string | undefined
  detail?: ReportDetail | undefined
}

const ROUTES = ['proxy', 'direct', 'mirror'] as const
const PHASES = ['connect', 'headers', 'body', 'verify'] as const
const CODES = ['UPSTREAM_TIMEOUT', 'UPSTREAM_UNREACHABLE'] as const
const CAUSE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_ATTEMPTS = 4

/**
 * 白名单化 `detail`：未知键丢弃、值域外丢弃、`cause` 归一成 `^[A-Z0-9_]+$`。
 *
 * 不原样存是硬要求（§11.9 预防第 2 条）：`detail` 一旦接受任意结构，它就变成任意上传端点。
 */
export function sanitizeReportDetail(input: unknown): ReportDetail | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const source = input as Record<string, unknown>
  const detail: ReportDetail = {}
  if ((PHASES as readonly string[]).includes(source.phase as string)) {
    detail.phase = source.phase as ReportDetail['phase']
  }
  if ((ROUTES as readonly string[]).includes(source.winnerRoute as string)) {
    detail.winnerRoute = source.winnerRoute as ReportDetail['winnerRoute']
  }
  if ((CODES as readonly string[]).includes(source.code as string)) {
    detail.code = source.code as ReportDetail['code']
  }
  const rawAttempts = source.attempts
  if (Array.isArray(rawAttempts)) {
    const attempts: ReportAttempt[] = []
    for (const item of rawAttempts.slice(0, MAX_ATTEMPTS)) {
      const attempt = normalizeAttempt(item)
      if (attempt) attempts.push(attempt)
    }
    if (attempts.length > 0) detail.attempts = attempts
  }
  return Object.keys(detail).length > 0 ? detail : undefined
}

/** 已知传输错误码：命中即优先，避免把上游句子里的普通单词（`CONNECT`/`FAILED`）当成 cause。 */
const KNOWN_CAUSES = [
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
] as const

/** `cause` 只收错误码形态：先认已知码，再退回最长的 `SCREAMING_SNAKE` 词，否则 `UNKNOWN`。 */
export function normalizeCause(value: unknown): string {
  if (typeof value !== 'string') return 'UNKNOWN'
  // 显式标注：`?? []` 会让分支推断成 never[]，`includes(known)` 的参数随之退化成 never。
  const tokens: string[] = value.toUpperCase().match(/[A-Z][A-Z0-9_]*/g) ?? []
  for (const known of KNOWN_CAUSES) {
    if (tokens.includes(known)) return known
  }
  const candidates = tokens.filter((token) => CAUSE_PATTERN.test(token) && token.length >= 4)
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0] ?? 'UNKNOWN'
}

function normalizeAttempt(input: unknown): ReportAttempt | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const item = input as Record<string, unknown>
  const route = item.route
  const phase = item.phase
  if (!(ROUTES as readonly string[]).includes(route as string)) return undefined
  if (!(PHASES as readonly string[]).includes(phase as string)) return undefined
  const elapsedMs = typeof item.elapsedMs === 'number' && Number.isFinite(item.elapsedMs)
    ? Math.max(0, Math.min(600_000, Math.round(item.elapsedMs)))
    : 0
  const attempt: ReportAttempt = {
    route: route as ReportAttempt['route'],
    phase: phase as ReportAttempt['phase'],
    cause: normalizeCause(item.cause),
    elapsedMs,
  }
  if (typeof item.proxy === 'string' && item.proxy !== '') attempt.proxy = item.proxy.slice(0, 128)
  if (typeof item.resolvedIp === 'string' && item.resolvedIp !== '') {
    attempt.resolvedIp = item.resolvedIp.slice(0, 64)
  }
  return attempt
}

export interface ReportResult {
  ok: boolean
  status?: number | undefined
  /** 失败原因；不对外展示给玩家，只进诊断日志。 */
  error?: string | undefined
}

export interface RemoteReportClientOptions {
  /** 后台 API 根地址，例如 `https://games.example.com/v1`。 */
  baseUrl: string
  /** 安装标识：由 Host 持久化，缺失时用 `createInstallId()` 生成一次。 */
  installId: string
  fetcher?: HttpFetcher | undefined
  /** 客户端版本等非敏感描述，例如 `dsh-gamecenter/0.1.0`。 */
  client?: string | undefined
  now?: (() => Date) | undefined
  /** 上报超时；默认 5 秒，超时同样静默失败。 */
  timeoutMs?: number | undefined
  /**
   * 上报开关（契约 §3 条款 13）。
   *
   * 语义：配置了 `baseUrl` 即视为同意向该 endpoint 上报，因此默认值与 endpoint 绑定、
   * 不硬编码 true；设置里的显式关闭开关把这里传 false。
   * 关闭后不发送、不排队、不补发。
   */
  enabled?: boolean | undefined
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const INSTALL_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/
const GAME_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export class RemoteReportClient {
  private readonly baseUrl: string
  private readonly fetcher: HttpFetcher
  private readonly installId: string
  private readonly client?: string | undefined
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly enabled: boolean

  constructor(options: RemoteReportClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetcher = options.fetcher ?? (globalThis as { fetch: HttpFetcher }).fetch
    this.installId = options.installId
    this.client = options.client
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 5000
    this.enabled = options.enabled ?? true
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 构造上报体；输入非法时返回 null，调用方不得发送半成品。 */
  buildPayload(
    kind: ReportKind,
    gameId: string,
    commit?: string,
    detail?: unknown,
  ): RemoteReportPayload | null {
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) return null
    if (!GAME_ID_PATTERN.test(gameId)) return null
    if (!INSTALL_ID_PATTERN.test(this.installId)) return null
    if (commit !== undefined && !COMMIT_PATTERN.test(commit)) return null
    const sanitized = sanitizeReportDetail(detail)

    return {
      schemaVersion: 1,
      kind,
      installId: this.installId,
      gameId,
      ...(commit !== undefined ? { commit } : {}),
      at: this.now().toISOString(),
      ...(this.client ? { client: this.client } : {}),
      ...(sanitized ? { detail: sanitized } : {}),
    }
  }

  /** 上报一次；任何失败都返回 `{ok:false}`，从不抛错。 */
  async report(
    kind: ReportKind,
    gameId: string,
    commit?: string,
    detail?: unknown,
  ): Promise<ReportResult> {
    // 关闭后不发送、不排队、不补发。
    if (!this.enabled) return { ok: false, error: 'DISABLED' }
    const payload = this.buildPayload(kind, gameId, commit, detail)
    if (!payload) return { ok: false, error: 'INVALID_INPUT' }

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
    const signal = timeoutSignal(this.timeoutMs)
    if (signal) init.signal = signal

    try {
      const response = await this.fetcher(`${this.baseUrl}/reports`, init)
      if (response.status === 202 || response.ok) return { ok: true, status: response.status }
      return { ok: false, status: response.status, error: 'HTTP_STATUS' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 后台不等待的上报入口：调用方不必 await，也不会因此挡住下载/安装。 */
  reportInBackground(kind: ReportKind, gameId: string, commit?: string, detail?: unknown): void {
    void this.report(kind, gameId, commit, detail).catch(() => undefined)
  }

  downloadStarted(gameId: string, commit?: string): void {
    this.reportInBackground('download-start', gameId, commit)
  }

  installSucceeded(gameId: string, commit?: string): void {
    this.reportInBackground('install-ok', gameId, commit)
  }

  installFailed(gameId: string, commit?: string, detail?: unknown): void {
    this.reportInBackground('install-fail', gameId, commit, detail)
  }

  /**
   * 产物**没到手**就失败（`phase ∈ connect/headers/body`）。
   *
   * 与 `install-fail` 分开是为了指标的时间序列：混进安装失败会一夜之间把"安装成功率"改定义，
   * 而没有人会去重新审这个指标（§11.9 第 2 条）。
   */
  downloadFailed(gameId: string, commit?: string, detail?: unknown): void {
    this.reportInBackground('download-fail', gameId, commit, detail)
  }

  /**
   * 适配安装器的上报钩子（`InstallReporter`）。
   * `downloadStarted` 仍由调用方在真正开始下载时触发；安装成功/失败由此处自动上报。
   */
  forInstall(gameId: string, commit?: string): InstallReporter {
    return {
      downloadStarted: () => this.downloadStarted(gameId, commit),
      installSucceeded: () => this.installSucceeded(gameId, commit),
      downloadFailed: (detail?: unknown) => this.downloadFailed(gameId, commit, detail),
      installFailed: () => this.installFailed(gameId, commit),
    }
  }
}

/** 生成随机安装标识；只需不可预测且稳定，不是安全凭据。 */
export function createInstallId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return undefined
  const sig = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  return typeof sig === 'function' ? sig.call(AbortSignal, timeoutMs) : undefined
}
