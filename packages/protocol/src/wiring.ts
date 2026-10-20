/**
 * 阶段1 **生产接线**最小契约（冻结版 1）。
 *
 * 【为什么需要这个文件】
 * 阶段0/阶段1 到目前为止，`gameCenter` 命名空间只有 5 个方法
 * （handshake / pause / saveAck / leaseStatus / modelCatalog），
 * 而"目录列表 → 安装 → 启动受限 iframe → 游玩 → 关闭保存 → 重开恢复"需要的
 * 另外四件事没有任何 wire 契约：列目录、装游戏、取已安装产物、读最近存档。
 * 缺了它们，Client 只能拿测试夹具冒充可玩链路。本文件把这四条**冻结**成协议，
 * 让 Host / Client / 目录三个包按同一份形状实现，而不是各自发明。
 *
 * 【本文件是拟新增协议，不是 DSH 既有 API】
 *
 * 【冻结的四条方法】命名与既有 5 个保持一致（wire 名 = Host 形参名/方法名）：
 * | 方法 | 作用 | 权威方 |
 * | --- | --- | --- |
 * | `catalogList` | 列目录条目 + 审批状态 + 是否已装 | Host（网络只在 Host 侧） |
 * | `catalogInstall` | 按固定提交验摘要并隔离安装 | Host |
 * | `gameBundle` | 取某已安装提交内**受限白名单文件**的文本 | Host |
 * | `saveLatest` | 读该存档最近检查点（供"继续游戏"） | Host |
 *
 * 【为什么不是"Host 起一个静态资源服务器"】
 * 设计基线 §7 写的是"受控资源服务 + 隔离 origin + CSP"，那是终局形态。
 * 阶段1 的最小实现**不新开 server**：Host 只回文件文本，Client 把它组装成
 * **opaque origin** 的受限 iframe 文档（`sandbox="allow-scripts"`，**不带**
 * `allow-same-origin`）。这样游戏拿不到主窗口同源权限，也不需要新增监听端口。
 * 终局换成独立资源服务时，`gameBundle` 可退化为只回 `entryUrl`，调用方形状不变。
 *
 * 【尚未实机验证的前提（不得当作已通过）】
 * 1. `srcdoc` 文档按规范会**继承父页面 CSP**；若 DSH 页面 CSP 不含
 *    `script-src 'unsafe-inline'`，内联脚本会被拦。备选是 `blob:` 文档 URL
 *    （同样必须带 sandbox，否则是同源）。两种都要在部署后实测，二选一。
 * 2. `postMessage(msg, '*', [port])` 向 opaque origin 投递端口是允许的（目标源必须写
 *    `'*'`），握手仍按 `event.source === iframe.contentWindow` + 一次性 nonce 认证。
 * 3. 打包体积上限按扫雷实测（`game.js` 31,593 + `style.css` 3,740 字节）取值，
 *    大游戏需要终局的资源服务，不能靠调大上限解决。
 */

import type { JsonValue } from './json.js'
import { COMMIT_PATTERN, DIGEST_PATTERN } from './catalog.js'
import { GAME_ID_PATTERN } from './manifest.js'
import { isSafeRelativePath, isSafePathSegment } from './install.js'
import { utf8ByteLength } from './bridge.js'
import { CHECKPOINT_OPERATION_ID_PATTERN } from './checkpoint.js'

/**
 * `gameCenter` 命名空间的**完整**方法表（既有 5 + 阶段1 新增 8）。
 *
 * Host 侧必须为新增方法提供 `@Remote` 声明；Client 侧必须为同一组补齐
 * contribution descriptor。两边以本常量为唯一来源，禁止单方面多写或少写。
 *
 * 数量不是仪式性的"12"：每加一条都要同步 protocol / Host `@Remote` / Client descriptor /
 * `tools/audit-wire-consistency.mjs` / `check-wire-contract.mjs` 五处。
 * 2026-10-20 新增 `abandonRuntime`（放弃未完成启动，用于取消迟到握手），见 `ABANDON` 段。
 */
export const GAMECENTER_REMOTE_METHODS = [
  // —— 阶段0 既有 ——
  'handshake',
  'pause',
  'saveAck',
  'leaseStatus',
  'modelCatalog',
  // —— 阶段1 冻结新增 ——
  'catalogList',
  'catalogInstall',
  'gameBundle',
  'saveLatest',
  'saveCheckpoint',
  'previewList',
  'previewBundle',
  'abandonRuntime',
] as const

export type GameCenterRemoteMethod = (typeof GAMECENTER_REMOTE_METHODS)[number]

/** 阶段1 新增的 8 条；Client/Host 用它做"是否已补齐"的对账，避免漏实现。 */
export const GAMECENTER_REMOTE_METHOD_ADDITIONS = [
  'catalogList',
  'catalogInstall',
  'gameBundle',
  'saveLatest',
  'saveCheckpoint',
  'previewList',
  'previewBundle',
  'abandonRuntime',
] as const

export type GameCenterRemoteMethodAddition = (typeof GAMECENTER_REMOTE_METHOD_ADDITIONS)[number]

/** 目录来源：只有这两种，`fixture` 表示没有真实发布元组时的本地预览。 */
export const CATALOG_WIRE_SOURCES = ['github', 'fixture'] as const

export type CatalogWireSource = (typeof CATALOG_WIRE_SOURCES)[number]

/** 审批状态：`approved` 之外一律不可安装。 */
export const CATALOG_APPROVAL_STATES = ['approved', 'pending', 'rejected', 'unknown'] as const

export type CatalogApprovalState = (typeof CATALOG_APPROVAL_STATES)[number]

/** 目录条目（界面展示 + 安装判定所需的**全部**字段；不含 Issue 正文）。 */
export interface CatalogListWireEntry {
  gameId: string
  title: string
  summary: string
  version: string
  repository: string
  /** 40 位完整提交 SHA；短 SHA 一律拒绝。 */
  commit: string
  manifestDigest: string
  bundleDigest: string
  approvalState: CatalogApprovalState
  /** 本地是否已安装该 gameId（任一提交）。 */
  installed: boolean
  /** 已安装的提交；未安装为 null。 */
  installedCommit: string | null
}

/** `catalogList` 入参。`refresh:true` 才允许触网；缺省读缓存。 */
export interface CatalogListWireRequest {
  refresh?: boolean
}

export type CatalogListWireResult =
  | {
      ok: true
      source: CatalogWireSource
      fetchedAt: string
      entries: CatalogListWireEntry[]
    }
  | { ok: false; errorCode: string; message: string }

/**
 * `catalogInstall` 入参：**五元组**里参与下载决策的四项 + gameId。
 * 不传 repository 是故意的：repository 由 Host 侧审批记录给出，
 * 不能让调用方临时改挂到别的仓库（`matchApproval` 的语义）。
 */
export interface CatalogInstallWireRequest {
  gameId: string
  commit: string
  manifestDigest: string
  bundleDigest: string
}

export type CatalogInstallWireResult =
  | {
      ok: true
      gameId: string
      commit: string
      /** 安装根下的相对路径：`<gameId>/<commit>/`。 */
      installedPath: string
      /** 相对已安装目录的入口文件（来自 manifest.runtime.entry）。 */
      entryPath: string
      alreadyInstalled: boolean
    }
  | { ok: false; errorCode: string; message: string }

/** 打包体积上限（阶段1 单文件游戏；超限必须显式拒绝，不许截断）。 */
export const GAME_BUNDLE_MAX_FILES = 64
export const GAME_BUNDLE_MAX_FILE_BYTES = 1024 * 1024
export const GAME_BUNDLE_MAX_TOTAL_BYTES = 4 * 1024 * 1024
export const GAME_BUNDLE_MAX_PATH_LENGTH = 256

/** 允许打进 iframe 文档的文件后缀（阶段1 只要文本资产；二进制走终局资源服务）。 */
export const GAME_BUNDLE_TEXT_EXTENSIONS = ['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.svg'] as const

/**
 * iframe 的 `sandbox` 属性**唯一允许值**。
 *
 * 必须只有 `allow-scripts`：不含 `allow-same-origin`（游戏不能碰主窗口 DOM/存储）、
 * 不含 `allow-popups` / `allow-top-navigation` / `allow-forms` / `allow-modals`。
 * 这条是安全契约，改动须走协议变更评审。
 */
export const GAME_IFRAME_SANDBOX = 'allow-scripts'

/**
 * 游戏文档必须自带的 CSP（写进 `<meta http-equiv="Content-Security-Policy">`）。
 *
 * 要点：`default-src 'none'` 断网；`connect-src 'none'` 禁止 fetch/XHR/WebSocket；
 * 内联 script/style 允许（单文件交付），但 `base-uri 'none'` / `form-action 'none'`
 * 防基址劫持与表单外发。
 */
export const GAME_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

/** `gameBundle` 入参。 */
export interface GameBundleWireRequest {
  gameId: string
  commit: string
}

/** 一个文本资产。`content` 是 UTF-8 文本，不做压缩、不做 base64。 */
export interface GameBundleWireFile {
  /** 相对已安装 `<gameId>/<commit>/` 的路径，例如 `dist/index.html`。 */
  path: string
  content: string
}

export type GameBundleWireResult =
  | {
      ok: true
      gameId: string
      commit: string
      /** manifest.runtime.entry，例如 `dist/index.html`。 */
      entryPath: string
      files: GameBundleWireFile[]
      totalBytes: number
    }
  | { ok: false; errorCode: string; message: string }

/** `saveLatest` 入参。身份由 Host 绑定，调用方只能指定存档，不能指定别的玩家。 */
export interface SaveLatestWireRequest {
  gameId: string
  saveId: string
}

export type SaveLatestWireResult =
  | { ok: true; absent: true }
  | {
      ok: true
      absent: false
      gameId: string
      saveId: string
      revision: number
      /** 存档固定到的提交；与当前安装提交不一致时必须显式拒绝或迁移。 */
      installedCommit: string
      state: JsonValue
      elapsedGameMs: number
      rngState: string
    }
  | { ok: false; errorCode: string; message: string }

/** 一条违反项：`field` 指出位置，`reason` 说明为什么拒绝。 */
export interface WireViolation {
  field: string
  reason: string
}

/**
 * 校验 `catalogInstall` 入参。
 *
 * 只做**形状**校验：提交必须是 40 位完整 SHA，摘要必须是 `sha256:<64hex>`，
 * gameId 必须合法。是否真的有对应审批记录由 Host 查审批源判定，不是这里。
 */
export function validateCatalogInstallRequest(input: unknown): WireViolation[] {
  const violations: WireViolation[] = []
  if (typeof input !== 'object' || input === null) {
    return [{ field: '*', reason: '入参必须是对象' }]
  }
  const raw = input as Record<string, unknown>

  if (typeof raw.gameId !== 'string' || !GAME_ID_PATTERN.test(raw.gameId)) {
    violations.push({ field: 'gameId', reason: `gameId 非法：${JSON.stringify(raw.gameId)}` })
  }
  if (typeof raw.commit !== 'string' || !COMMIT_PATTERN.test(raw.commit)) {
    violations.push({ field: 'commit', reason: 'commit 必须是 40 位小写十六进制完整提交 SHA（短 SHA 不接受）' })
  }
  for (const key of ['manifestDigest', 'bundleDigest'] as const) {
    if (typeof raw[key] !== 'string' || !DIGEST_PATTERN.test(raw[key])) {
      violations.push({ field: key, reason: `${key} 必须是 sha256:<64 位小写十六进制>` })
    }
  }
  return violations
}

/**
 * 校验 `saveLatest` 入参。身份段（playerId）不在入参里：由 Host 从租约/宿主绑定取，
 * 调用方伪造不了。
 */
export function validateSaveLatestRequest(input: unknown): WireViolation[] {
  const violations: WireViolation[] = []
  if (typeof input !== 'object' || input === null) {
    return [{ field: '*', reason: '入参必须是对象' }]
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.gameId !== 'string' || !GAME_ID_PATTERN.test(raw.gameId)) {
    violations.push({ field: 'gameId', reason: `gameId 非法：${JSON.stringify(raw.gameId)}` })
  }
  if (typeof raw.saveId !== 'string' || raw.saveId.length === 0 || raw.saveId.length > 128) {
    violations.push({ field: 'saveId', reason: 'saveId 必须是 1~128 字符的非空字符串' })
  }
  return violations
}

/**
 * 判断一个相对路径能否作为打包文件路径。
 *
 * 复用 `isSafeRelativePath`（拒绝对路径、盘符、`..` 穿越、反斜杠、控制字符），
 * 再叠加本层的长度上限与后缀白名单。**空路径、目录尾部斜杠一律拒绝。**
 */
export function isSafeBundlePath(path: string): boolean {
  if (typeof path !== 'string') return false
  if (path.length === 0 || path.length > GAME_BUNDLE_MAX_PATH_LENGTH) return false
  if (path.endsWith('/')) return false
  // 打包路径一律用 `/` 分隔：反斜杠在 Windows 上是分隔符、在浏览器里是普通字符，
  // 允许它会带来"Host 认作一层、Client 认作一层"的歧义，直接拒绝。
  if (path.includes('\\')) return false
  if (!isSafeRelativePath(path)) return false
  const lower = path.toLowerCase()
  return GAME_BUNDLE_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** UTF-8 字节数（与浏览器 TextEncoder 同义；`gameBundle` 用它算 totalBytes）。 */
export function bundleContentBytes(content: string): number {
  // 与浏览器 TextEncoder 同义：按 UTF-8 计字节；不依赖 DOM 类型库。
  return utf8ByteLength(content)
}

/**
 * 校验 `gameBundle` 返回的文件清单。
 *
 * Host 在**发送前**、Client 在**组装文档前**都必须各调一次（纵深防御）：
 * 任一方漏检，另一方仍会拒绝。超限一律显式失败，不截断、不跳过。
 */
export function validateGameBundleFiles(files: unknown): WireViolation[] {
  const violations: WireViolation[] = []
  if (!Array.isArray(files)) {
    return [{ field: 'files', reason: 'files 必须是数组' }]
  }
  if (files.length === 0) {
    return [{ field: 'files', reason: 'files 不能为空' }]
  }
  if (files.length > GAME_BUNDLE_MAX_FILES) {
    violations.push({ field: 'files', reason: `文件数 ${files.length} 超过上限 ${GAME_BUNDLE_MAX_FILES}` })
  }

  const seen = new Set<string>()
  let total = 0
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    if (typeof file !== 'object' || file === null) {
      violations.push({ field: `files[${index}]`, reason: '必须是对象' })
      continue
    }
    const entry = file as Record<string, unknown>
    if (typeof entry.path !== 'string') {
      violations.push({ field: `files[${index}].path`, reason: 'path 必须是字符串' })
      continue
    }
    if (!isSafeBundlePath(entry.path)) {
      violations.push({
        field: `files[${index}].path`,
        reason: `路径不安全或后缀不在白名单：${JSON.stringify(entry.path)}`,
      })
    }
    if (seen.has(entry.path)) {
      violations.push({ field: `files[${index}].path`, reason: `路径重复：${entry.path}` })
    }
    seen.add(entry.path)

    if (typeof entry.content !== 'string') {
      violations.push({ field: `files[${index}].content`, reason: 'content 必须是 UTF-8 文本' })
      continue
    }
    const bytes = bundleContentBytes(entry.content)
    if (bytes > GAME_BUNDLE_MAX_FILE_BYTES) {
      violations.push({
        field: `files[${index}].content`,
        reason: `单文件 ${bytes} 字节超过上限 ${GAME_BUNDLE_MAX_FILE_BYTES}`,
      })
    }
    total += bytes
  }

  if (total > GAME_BUNDLE_MAX_TOTAL_BYTES) {
    violations.push({ field: 'files', reason: `总字节 ${total} 超过上限 ${GAME_BUNDLE_MAX_TOTAL_BYTES}` })
  }
  return violations
}

/**
 * 校验 iframe 安全策略常量是否仍满足"opaque origin + 断网"。
 *
 * 给测试与运行期自检共用：任何一次改动把 `allow-same-origin` 带回来，
 * 或让 CSP 放开网络，这里会立刻失败，而不是等到渗透评审。
 */
export function validateFramePolicy(sandbox: string, csp: string): WireViolation[] {
  const violations: WireViolation[] = []
  const tokens = sandbox.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length !== 1 || tokens[0] !== 'allow-scripts') {
    violations.push({
      field: 'sandbox',
      reason: `sandbox 只能是 "allow-scripts"，实际 ${JSON.stringify(sandbox)}（含 allow-same-origin 即失去隔离）`,
    })
  }
  for (const forbidden of ["default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    if (!csp.includes(forbidden)) {
      violations.push({ field: 'csp', reason: `CSP 缺少 "${forbidden}"` })
    }
  }
  if (/connect-src\s+(?!'none')/.test(csp)) {
    violations.push({ field: 'csp', reason: 'CSP 的 connect-src 必须恒为 \'none\'（游戏不得直连网络）' })
  }
  return violations
}

// ---------------------------------------------------------------------------
// 检查点写入出口（PM 2026-10-20 指出的硬断点）
// ---------------------------------------------------------------------------

/**
 * `saveCheckpoint` 入参。
 *
 * 【为什么必须有这条方法】
 * `saveAck` 只是**暂停流程的确认回执**（`{runtimeToken, revision}`），不携带 state 载荷，
 * 也不写库。生产链路上，游戏在 iframe 里通过 MessagePort 把 `save.checkpoint` 发给
 * Client 的 Dispatcher；Dispatcher 跑在浏览器里，**够不到 Host 的 SaveStore**。
 * 所以必须有一条受信、鉴权的 Remote 方法把载荷送到 Host，再写 SQLite。
 * 用测试里的 `onCheckpoint → 直接调 Store` 冒充跨端已接通是不成立的。
 *
 * 【身份规则：一个身份字段都不由调用方给】
 * - `playerId`：**不在入参里**。它只能来自宿主绑定（见 §身份来源）。
 * - `gameId` / `saveId`：由 Host 用 `runtimeToken` 换出来的租约读出；本结构的
 *   `gameId` / `saveId` 是**可选交叉核验**字段，与租约不符即 `PROTOCOL_INVALID`。
 * - `generation`：可选，只用于检测迟到写入（与租约代次不符 → `STALE_RUNTIME`）。
 * - `runtimeToken`：握手时下发一次，Client Bridge 内存持有，**游戏 iframe 不得接触**。
 */
export interface SaveCheckpointWireRequest {
  /** 握手下发的运行凭证原文；身份由它确定。 */
  runtimeToken: string
  /** 保存动作幂等键（`act-<sdkInstanceId>-<seq>` 或调用方指定）。 */
  operationId: string
  /** 期望基准 revision；首次 0，之后为上次成功的 revision。 */
  expectedRevision: number
  /** 游戏不透明状态（JSON）。 */
  state: JsonValue
  /** 保存时刻的游戏虚拟毫秒。 */
  elapsedGameMs: number
  /** 可序列化随机数状态。 */
  rngState: string
  /** 可选：检测迟到写入。 */
  generation?: number
  /** 可选：与租约交叉核验。 */
  gameId?: string
  /** 可选：与租约交叉核验。 */
  saveId?: string
}

/**
 * `saveCheckpoint` 出参：语义等价于 `CheckpointResult`，只把 `code` 统一为 `errorCode`。
 *
 * 错误码语义（与 `checkpoint.ts` 一致，不得混用）：
 * - `STALE_RUNTIME`：确定性版本冲突，`retryable:false`，**回带** `currentRevision`；
 * - `RATE_LIMIT`：瞬态锁争用，`retryable:true`，**不得回带** `currentRevision`；
 * - `PROTOCOL_INVALID`：内容非法 / 同 operationId 不同内容 / 身份不符；
 * - `INTERNAL`：已回滚的未预期错误。
 */
export type SaveCheckpointWireResult =
  | { ok: true; revision: number; idempotentReplay: boolean }
  | {
      ok: false
      errorCode: 'STALE_RUNTIME' | 'RATE_LIMIT' | 'PROTOCOL_INVALID' | 'INTERNAL'
      message: string
      retryable: boolean
      currentRevision?: number
    }

/**
 * 校验 `saveCheckpoint` 入参。
 *
 * 关键一条：**任何 `playerId` 字段出现即拒绝**。它不是可忽略的多余字段，
 * 而是"调用方试图自报身份"的信号；静默忽略会让下一个实现者以为它有效。
 */
export function validateSaveCheckpointRequest(input: unknown): WireViolation[] {
  const violations: WireViolation[] = []
  if (typeof input !== 'object' || input === null) {
    return [{ field: '*', reason: '入参必须是对象' }]
  }
  const raw = input as Record<string, unknown>

  if (typeof raw.runtimeToken !== 'string' || raw.runtimeToken.length === 0 || raw.runtimeToken.length > 512) {
    violations.push({ field: 'runtimeToken', reason: '缺少运行凭证或长度非法' })
  }
  if (typeof raw.operationId !== 'string' || !CHECKPOINT_OPERATION_ID_PATTERN.test(raw.operationId)) {
    violations.push({
      field: 'operationId',
      reason: `operationId 必须是 1~128 位 [A-Za-z0-9._:-]：${JSON.stringify(raw.operationId)}`,
    })
  }
  if (typeof raw.expectedRevision !== 'number' || !Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 0) {
    violations.push({ field: 'expectedRevision', reason: 'expectedRevision 必须是 >=0 的整数' })
  }
  if (typeof raw.elapsedGameMs !== 'number' || !Number.isFinite(raw.elapsedGameMs) || raw.elapsedGameMs < 0) {
    violations.push({ field: 'elapsedGameMs', reason: 'elapsedGameMs 必须是 >=0 的有限数' })
  }
  if (typeof raw.rngState !== 'string' || raw.rngState.length > 4096) {
    violations.push({ field: 'rngState', reason: 'rngState 必须是字符串且不超过 4096 字符' })
  }
  if (raw.state === undefined) {
    violations.push({ field: 'state', reason: 'state 不能缺失（可以显式传 null）' })
  } else {
    try {
      const serialized = JSON.stringify(raw.state)
      if (typeof serialized !== 'string') {
        violations.push({ field: 'state', reason: 'state 必须是可 JSON 序列化的值' })
      }
    } catch {
      violations.push({ field: 'state', reason: 'state 不可 JSON 序列化（含循环引用或函数）' })
    }
  }
  if ('playerId' in raw) {
    violations.push({
      field: 'playerId',
      reason: '身份不得由调用方提供：playerId 只能来自宿主绑定，出现即拒绝而不是忽略',
    })
  }
  return violations
}

// ---------------------------------------------------------------------------
// 本地受控预览（PM 2026-10-20 要求：预览必须是独立路径，不伪造审批）
// ---------------------------------------------------------------------------

/** 预览条目的固定标签；界面必须原样显示，不得省略"未上架"。 */
export const GAME_PREVIEW_LABEL = '本地预览（未上架）'

/**
 * 一条本地预览条目。
 *
 * 【为什么它不是 `CatalogListWireEntry`】
 * 目录条目必须带 `commit` / `manifestDigest` / `bundleDigest` / 审批状态。
 * 本地预览没有真实发布元组，**不能编一份假的填进去**。所以预览走独立类型：
 * 没有 commit、没有摘要、没有审批，永远 `source:'fixture'`，且 `installable` 恒为 false。
 */
export interface PreviewListWireEntry {
  /** 预览目录内的目录名；只作安全段使用，不是 commit。 */
  previewId: string
  gameId: string
  name: string
  version: string
  source: 'fixture'
  label: string
  /** 恒为 false：预览不得进入正式安装库。 */
  installable: false
}

export type PreviewListWireResult =
  | { ok: true; configured: boolean; entries: PreviewListWireEntry[] }
  | { ok: false; errorCode: string; message: string }

/** `previewBundle` 入参：只认 previewId，不认 gameId/commit（否则又能绕过安装门禁）。 */
export interface PreviewBundleWireRequest {
  previewId: string
}

export type PreviewBundleWireResult =
  | {
      ok: true
      source: 'fixture'
      previewId: string
      gameId: string
      version: string
      entryPath: string
      files: GameBundleWireFile[]
      totalBytes: number
    }
  | { ok: false; errorCode: string; message: string }

/** 校验 `previewBundle` 入参：`previewId` 必须是单段安全目录名。 */
export function validatePreviewBundleRequest(input: unknown): WireViolation[] {
  const violations: WireViolation[] = []
  if (typeof input !== 'object' || input === null) {
    return [{ field: '*', reason: '入参必须是对象' }]
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.previewId !== 'string' || !isSafePathSegment(raw.previewId)) {
    violations.push({ field: 'previewId', reason: `previewId 必须是单段安全目录名：${JSON.stringify(raw.previewId)}` })
  }
  return violations
}
// ---------------------------------------------------------------------------
// 检查点准入与暂停收尾顺序（PM 2026-10-20：最终检查点先落盘，再确认封存）
// ---------------------------------------------------------------------------

/**
 * 允许写入检查点的租约状态。
 *
 * `running`：常规每条动作检查点。
 * `pausing`：**唯一一次**"暂停收尾检查点"。PM 2026-10-20 明确：暂停流程里必须先把这个
 * 最终检查点持久化成功，才允许 `saveAck` 封存；如果 `pausing` 一律拒写，关闭时就只剩
 * "确认了但没落盘"这一条路，等于假保存。
 *
 * 注意这与 Host `LeaseRegistry.checkWritable()` 现有行为**不同**：后者把所有业务请求
 * （含 AI）在 `pausing` 一律拒为 `PAUSED`，那是对的——但检查点写入必须走独立准入判定，
 * 不能复用同一个函数。**不要**为了省事把 `pausing` 加进 `checkWritable`，
 * 那会顺带放开 AI 请求与其它写入。
 */
export const CHECKPOINT_WRITABLE_LEASE_STATES = ['running', 'pausing'] as const

export type CheckpointWritableLeaseState = (typeof CHECKPOINT_WRITABLE_LEASE_STATES)[number]

/** 准入判定所需的租约投影（Host 从 `LeaseRecord` 取这几个字段即可）。 */
export interface CheckpointAdmissionLease {
  state: string
  sealed: boolean
  generation: number
  /** `Date.parse(expiresAt)` 的结果。 */
  expiresAtMs: number
}

export type CheckpointAdmissionResult =
  | { ok: true }
  | { ok: false; errorCode: 'STALE_RUNTIME' | 'PAUSED' | 'PROTOCOL_INVALID'; message: string }

/**
 * 检查点写入准入判定（Host 与测试共用**同一份**实现，避免两边语义漂移）。
 *
 * 拒绝顺序与理由：
 * 1. `sealed` → `STALE_RUNTIME`：代次已封存，任何写入都是迟到的；
 * 2. `pending` → `PROTOCOL_INVALID`：还没握手，没有可信身份；
 * 3. 状态不在 `CHECKPOINT_WRITABLE_LEASE_STATES` → `STALE_RUNTIME`（paused/stopped/
 *    recovery-available 都属于"本次运行已结束或已收尾"）；
 * 4. 调用方声明了 `generation` 且与租约不符 → `STALE_RUNTIME`（旧 iframe 迟到写入）；
 * 5. 租约过期 → `PAUSED`。
 *
 * "其他实例"不需要在这里判：凭证解析失败在 `runtimeToken → 租约` 那一步就已经拒绝，
 * 本函数拿到的租约必然属于出示凭证的那一个实例。
 */
export function decideCheckpointAdmission(
  lease: CheckpointAdmissionLease,
  input: { generation?: number; nowMs: number },
): CheckpointAdmissionResult {
  if (lease.sealed) {
    return { ok: false, errorCode: 'STALE_RUNTIME', message: '运行实例已封存，拒绝写入。' }
  }
  if (lease.state === 'pending') {
    return { ok: false, errorCode: 'PROTOCOL_INVALID', message: '运行实例尚未完成握手，拒绝写入。' }
  }
  if (!(CHECKPOINT_WRITABLE_LEASE_STATES as readonly string[]).includes(lease.state)) {
    return {
      ok: false,
      errorCode: 'STALE_RUNTIME',
      message: `状态 ${lease.state} 不接受检查点写入。`,
    }
  }
  if (typeof input.generation === 'number' && input.generation !== lease.generation) {
    return {
      ok: false,
      errorCode: 'STALE_RUNTIME',
      message: `运行代次不匹配：租约为 ${lease.generation}，请求声明 ${input.generation}。`,
    }
  }
  if (lease.expiresAtMs <= input.nowMs) {
    return { ok: false, errorCode: 'PAUSED', message: '控制租约已过期，需重新获取控制权。' }
  }
  return { ok: true }
}

/**
 * 暂停收尾的**唯一**顺序。任何一步失败都停留在该步，**不得跳过、不得提前确认**：
 *
 * 1. `persist-final-checkpoint`：把最终快照写进 SQLite（`saveCheckpoint`，状态 `pausing`）；
 * 2. `seal-lease`：写入成功后封存该代次（此后同一代次任何写入都是 `STALE_RUNTIME`）；
 * 3. `pause-ack`：向 Client 回保存确认（`saveAck`），此时才允许销毁运行实例；
 * 4. `destroy-runtime`：销毁 iframe / 端口 / 时钟 / 监听。
 *
 * 反例（明确禁止）：先 `pause-ack` 再写盘；写盘失败仍回 `saved`；超时后回 `saved`
 * 而不是 `recovery-available`。这三种都会让玩家以为进度保住了。
 */
export const PAUSE_FINALIZATION_ORDER = [
  'persist-final-checkpoint',
  'seal-lease',
  'pause-ack',
  'destroy-runtime',
] as const

export type PauseFinalizationStep = (typeof PAUSE_FINALIZATION_ORDER)[number]

/** 校验给定顺序是否与冻结顺序完全一致（用于 Host 自检与测试）。 */
export function isPauseFinalizationOrderValid(order: readonly string[]): boolean {
  return (
    order.length === PAUSE_FINALIZATION_ORDER.length &&
    order.every((step, index) => step === PAUSE_FINALIZATION_ORDER[index])
  )
}