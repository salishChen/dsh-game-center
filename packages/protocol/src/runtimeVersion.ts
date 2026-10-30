/**
 * 运行平台版本策略 / Runtime platform version policy.
 *
 * 【为什么需要本文件】
 * 2026-10-20 项目经理纠正：
 * - `DSH_VERSION_LOCK.localVerified` 是**历史验证基线**，不是当前运行宿主的权威版本；
 * - `SDK_VERSION` 是**游戏 SDK 接口版本**，不是游戏中心平台版本；
 * - 两者都**不得**被硬编码成 `running.dsh` / `running.gameCenter` 去放行兼容门禁。
 *
 * 因此这里把"版本来源"拆成三类，并且要求**每一条都携带证据**：
 * 1. `designBaseline` / `localVerified` —— 历史上验证过的构建（`dshVersions.ts`，**只读参考**）；
 * 2. `observed` —— 从当前安装包元数据**读出来**的版本（带读取路径与读取时刻）；
 * 3. `processBound` —— 能证明**绑定当前进程**的版本（本轮尚未取得）。
 *
 * 【核心规则】fail closed
 * - 只有 `observed`(且读到的安装包与当前进程一致) 或 `processBound` 才能作为
 *   `running.dsh` 去判定兼容性；
 * - 只有显式配置的 `gameCenter` 平台版本才能作为 `running.gameCenter`；
 * - 拿不到 → 返回 `COMPAT_UNRESOLVED`，**安装与启动都必须被阻止**，
 *   禁止回填 `unknown`、空串、旧 lock、`SDK_VERSION` 或 `0.0.0` 后放行。
 *
 * 【双语 / Bilingual】对外说明一律中英并置；协议标识符不翻译。
 */

import { parseSemver } from './version.js'

/** 平台标识：DSH 宿主。 */
export const RUNTIME_PLATFORM_DSH = 'dsh' as const
/** 平台标识：游戏中心。 */
export const RUNTIME_PLATFORM_GAMECENTER = 'gamecenter' as const

export type RuntimePlatform = typeof RUNTIME_PLATFORM_DSH | typeof RUNTIME_PLATFORM_GAMECENTER

/** 版本证据来源分类 / How the version value was obtained. */
export const VERSION_EVIDENCE_KINDS = [
  /** 设计基线提交（历史文档引用），不可用于放行。 */
  'designBaseline',
  /** 本机曾经验证过的构建（历史事实），不可用于放行。 */
  'localVerified',
  /** 从当前安装包元数据读出，需绑定当前进程才可放行。 */
  'observed',
  /** 能证明绑定当前进程的运行版本。 */
  'processBound',
  /** 用户/宿主受信配置显式声明。 */
  'trustedConfig',
] as const

export type VersionEvidenceKind = (typeof VERSION_EVIDENCE_KINDS)[number]

/** 可以用于兼容门禁的证据种类；其余一律视为未决。 */
export const GATE_ELIGIBLE_EVIDENCE: readonly VersionEvidenceKind[] = [
  'observed',
  'processBound',
  'trustedConfig',
]

/** 一条带证据的版本观测 / One version observation with provenance. */
export interface RuntimeVersionObservation {
  platform: RuntimePlatform
  /** 解析前的原始字符串，原样保留便于审计。 */
  raw: string
  /** 证据来源分类。 */
  evidence: VersionEvidenceKind
  /** 是否有证据表明该版本属于**当前正在运行的进程**。 */
  boundToRunningProcess: boolean
  /** 读取位置（文件路径、配置键、IPC 来源）；必须可复核。 */
  source: string
  /** 读取时刻（ISO 8601，UTC）。 */
  observedAt: string
  /** 附加证据（如 buildCommit、hostProtocolVersion），不含任何凭据。 */
  details?: Readonly<Record<string, string | number | boolean>>
}

/** 一个平台的版本解析结果：要么可用，要么明确未决。 */
export type RuntimeVersionResolution =
  | { ok: true; platform: RuntimePlatform; version: string; observation: RuntimeVersionObservation }
  | { ok: false; platform: RuntimePlatform; code: 'COMPAT_UNRESOLVED'; field: 'dsh' | 'gameCenter'; reason: string; reasonEn: string }

/** 供 `evaluateCompatibility` 使用的运行版本对；任一未决即不构成可判定输入。 */
export interface RunningVersionPair {
  gameCenter: string
  dsh: string
  /** 两个平台的证据，供审计与错误展示。 */
  evidence: {
    gameCenter: RuntimeVersionObservation
    dsh: RuntimeVersionObservation
  }
}

/**
 * 把一条观测收敛为可放行的版本。
 *
 * 放行条件（全部满足）：
 * 1. 证据种类在 `GATE_ELIGIBLE_EVIDENCE` 内；
 * 2. `boundToRunningProcess === true`；
 * 3. `raw` 是合法三段 SemVer（可带预发布/构建元数据）。
 */
export function resolveRuntimeVersion(
  observation: RuntimeVersionObservation | null | undefined,
  platform: RuntimePlatform,
): RuntimeVersionResolution {
  const field = platform === RUNTIME_PLATFORM_DSH ? ('dsh' as const) : ('gameCenter' as const)

  if (!observation) {
    return {
      ok: false,
      platform,
      code: 'COMPAT_UNRESOLVED',
      field,
      reason: `无法确定当前运行的 ${platform} 版本，已阻止安装/启动 / runtime ${platform} version unavailable, install and launch are blocked`,
      reasonEn: `runtime ${platform} version unavailable; install and launch are blocked`,
    }
  }
  if (!GATE_ELIGIBLE_EVIDENCE.includes(observation.evidence)) {
    return {
      ok: false,
      platform,
      code: 'COMPAT_UNRESOLVED',
      field,
      reason: `${platform} 版本证据为 ${observation.evidence}，属于历史基线而非当前运行宿主，已阻止安装/启动 / evidence ${observation.evidence} is a historical baseline, not the running host`,
      reasonEn: `${platform} evidence ${observation.evidence} is a historical baseline, not the running host`,
    }
  }
  if (!observation.boundToRunningProcess) {
    return {
      ok: false,
      platform,
      code: 'COMPAT_UNRESOLVED',
      field,
      reason: `${platform} 版本来自 ${observation.source}，但没有绑定当前进程的证据，已阻止安装/启动 / version read from ${observation.source} lacks process binding`,
      reasonEn: `${platform} version from ${observation.source} lacks process-binding evidence`,
    }
  }
  if (!parseSemver(observation.raw)) {
    return {
      ok: false,
      platform,
      code: 'COMPAT_UNRESOLVED',
      field,
      reason: `${platform} 版本值 "${observation.raw}" 不是合法三段 SemVer，已阻止安装/启动 / not valid semver`,
      reasonEn: `${platform} version "${observation.raw}" is not valid semver`,
    }
  }
  return { ok: true, platform, version: observation.raw, observation }
}

/**
 * 组装运行版本对。两个平台都必须解析成功，否则整体失败。
 * 这是 `evaluateCompatibility` 的**唯一**合法输入构造入口。
 */
export function resolveRunningVersions(
  gameCenterObservation: RuntimeVersionObservation | null | undefined,
  dshObservation: RuntimeVersionObservation | null | undefined,
): { ok: true; pair: RunningVersionPair } | { ok: false; resolutions: RuntimeVersionResolution[] } {
  const gc = resolveRuntimeVersion(gameCenterObservation, RUNTIME_PLATFORM_GAMECENTER)
  const dsh = resolveRuntimeVersion(dshObservation, RUNTIME_PLATFORM_DSH)
  if (!gc.ok || !dsh.ok) {
    return { ok: false, resolutions: [gc, dsh] }
  }
  return {
    ok: true,
    pair: {
      gameCenter: gc.version,
      dsh: dsh.version,
      evidence: { gameCenter: gc.observation, dsh: dsh.observation },
    },
  }
}

/**
 * 从 `dsh/desktop-runtime.json` 的内容构造 DSH 观测。
 *
 * 该文件位于安装包 `app.asar` 内的 `dsh/desktop-runtime.json`，
 * 实测字段：`release.version`、`release.hostProtocolVersion`、`release.nodeVersion`。
 *
 * **注意**：本函数只负责"把读到的内容变成观测"，
 * 不负责判断"这个安装包就是当前进程在跑的"——那必须由调用方给出进程绑定证据
 * （例如：进程启动路径解析到同一个 asar、或宿主通过受信上下文自报同一 buildCommit）。
 * 没有该证据时 `boundToRunningProcess` 必须为 `false`，门禁会拒绝。
 */
export function observeDshVersionFromDesktopRuntime(
  content: unknown,
  input: { source: string; observedAt: string; boundToRunningProcess: boolean },
): RuntimeVersionObservation | null {
  if (typeof content !== 'object' || content === null) return null
  const release = (content as { release?: unknown }).release
  if (typeof release !== 'object' || release === null) return null
  const version = (release as { version?: unknown }).version
  if (typeof version !== 'string') return null
  const hostProtocolVersion = (release as { hostProtocolVersion?: unknown }).hostProtocolVersion
  const nodeVersion = (release as { nodeVersion?: unknown }).nodeVersion
  const details: Record<string, string | number | boolean> = {}
  if (typeof hostProtocolVersion === 'number') details.hostProtocolVersion = hostProtocolVersion
  if (typeof nodeVersion === 'string') details.nodeVersion = nodeVersion
  return {
    platform: RUNTIME_PLATFORM_DSH,
    raw: version,
    evidence: 'observed',
    boundToRunningProcess: input.boundToRunningProcess,
    source: input.source,
    observedAt: input.observedAt,
    details,
  }
}

/**
 * 从安装包 `package.json` 构造 DSH 观测（含 `dshBuildCommit` / `dshBuildDirty`）。
 * 与上面同理：进程绑定由调用方举证。
 */
export function observeDshVersionFromPackageJson(
  content: unknown,
  input: { source: string; observedAt: string; boundToRunningProcess: boolean },
): RuntimeVersionObservation | null {
  if (typeof content !== 'object' || content === null) return null
  const pkg = content as { name?: unknown; version?: unknown; dshBuildCommit?: unknown; dshBuildDirty?: unknown }
  if (typeof pkg.version !== 'string') return null
  const details: Record<string, string | number | boolean> = {}
  if (typeof pkg.name === 'string') details.packageName = pkg.name
  if (typeof pkg.dshBuildCommit === 'string') details.buildCommit = pkg.dshBuildCommit
  if (typeof pkg.dshBuildDirty === 'boolean') details.buildDirty = pkg.dshBuildDirty
  return {
    platform: RUNTIME_PLATFORM_DSH,
    raw: pkg.version,
    evidence: 'observed',
    boundToRunningProcess: input.boundToRunningProcess,
    source: input.source,
    observedAt: input.observedAt,
    details,
  }
}

/**
 * 游戏中心平台版本：**只能**来自显式配置或进程自报。
 *
 * 明确禁止：用 `SDK_VERSION`、包 `version: "0.0.0"`、目录条目 `version` 冒充。
 */
export function observeGameCenterVersion(
  raw: string | null | undefined,
  input: { source: string; observedAt: string; evidence?: VersionEvidenceKind; boundToRunningProcess: boolean },
): RuntimeVersionObservation | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return {
    platform: RUNTIME_PLATFORM_GAMECENTER,
    raw: raw.trim(),
    evidence: input.evidence ?? 'trustedConfig',
    boundToRunningProcess: input.boundToRunningProcess,
    source: input.source,
    observedAt: input.observedAt,
  }
}
