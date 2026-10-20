/**
 * 存档检查点（checkpoint）幂等与并发契约（阶段1 P3，2026-10-19 冻结）。
 *
 * 背景：`SaveStore` 早期版本把「读当前 revision」和「写新 revision」拆在两个事务里，
 * 且没有 operationId / expectedRevision，导致：
 * - 两进程并发写同一存档时都从同一 revision 出发，互相覆盖；
 * - 上层重试同一保存请求会再 +1，产生重复检查点。
 *
 * 本文件冻结 SDK ⇄ Host ⇄ 存储层的契约，实现（SQLite 后端）必须严格照此执行，
 * 但**实现不在本包**：本包只定义类型与判定规则，保持零运行时依赖。
 *
 * 事务要求（实现方必须满足，本文件无法在类型上强制）：
 * 单连接 `BEGIN IMMEDIATE` 内一次性完成
 * 「读存档 → operationId 查重 → expectedRevision 冲突判定 → 写新 revision + 记录 operationId → COMMIT」，
 * 任何异常 `ROLLBACK`，不得留半条记录。
 */

/** 单个存档同时保留的 operationId 记录上限；超出按最旧淘汰（实现方负责，本包只声明形态）。 */
export const CHECKPOINT_OPERATION_LOG_LIMIT = 64

/**
 * 检查点写入请求（SDK → Bridge `save.checkpoint` → Host）。
 *
 * 与 `AiGenerateRequest.operationId` 的差异：AI 请求的 operationId 是「一次模型调用」的幂等键；
 * 检查点的 operationId 是「一次状态保存动作」的幂等键。两者不可混用，也不共用命名空间。
 */
export interface CheckpointRequest {
  /** 保存动作幂等键。同一 operationId 重放必须命中已存结果，不得再 +1 revision。 */
  operationId: string
  /**
   * 调用方期望的基准 revision：
   * - 首次保存传 0；
   * - 之后传「上次成功返回的 revision」。
   * 库内当前 revision 与此不符即冲突，必须拒绝而不是覆盖。
   */
  expectedRevision: number
  /** 游戏不透明状态；平台不解释语义，只做大小与完整性校验。 */
  state: unknown
  /** 保存时刻的游戏虚拟时间毫秒（只在 Running 累计）。 */
  elapsedGameMs: number
  /** 可序列化随机数状态，恢复后不得按现实时间补跑。 */
  rngState: string
}

/**
 * 检查点写入结果。成功时返回写入后的 revision，便于上层作为下一次 expectedRevision。
 *
 * 失败码语义（PM 2026-10-19 明确要求把锁争用与版本冲突分开）：
 * - `STALE_RUNTIME`：**确定性的版本冲突**。已在事务内读到库内 revision，且与 expectedRevision 不符；
 *   回带 `currentRevision` 供上层重读。此时**不要**用同一 expectedRevision 重试。
 * - `RATE_LIMIT`：**瞬态锁争用**（如 SQLite `BEGIN IMMEDIATE` 拿不到排他锁 / `SQLITE_BUSY`）。
 *   此时库内状态未知、本次写入**未提交**，可稍后**用同一 operationId 重试**；
 *   因为写入没发生，重试不会产生重复检查点，也不需要重建请求。
 *   **不得**回带 `currentRevision`——我们没读到可信值，伪造它会让上层误判。
 * - `PROTOCOL_INVALID`：内容不合法或同 operationId 携带不同内容。
 * - `INTERNAL`：未预期错误，已回滚。
 */
export type CheckpointResult =
  | {
      ok: true
      revision: number
      /** 本次是否命中了幂等重放（同 operationId 已存且内容一致）。 */
      idempotentReplay: boolean
    }
  | {
      ok: false
      code: 'STALE_RUNTIME' | 'RATE_LIMIT' | 'PROTOCOL_INVALID' | 'INTERNAL'
      message: string
      /** 仅版本冲突时回带；瞬态锁争用时必须缺省（未读到可信 revision）。 */
      currentRevision?: number
      /** 是否值得用同一 operationId 重试；由实现按 code 给出。 */
      retryable?: boolean
    }

/**
 * checkpoint 冲突判定。
 *
 * 规则（按优先级）：
 * 1. 同一 operationId 已存在：
 *    - 内容（state/elapsedGameMs/rngState 的规范摘要）一致 → 幂等重放，返回**原 revision**，不新增；
 *    - 内容不一致 → 拒绝（同一幂等键携带不同内容属于调用方缺陷，不能静默改写历史）。
 * 2. 没有该 operationId：`expectedRevision` 必须等于库内当前 revision；
 *    - 相等 → 写入 revision+1；
 *    - 不相等 → 冲突，返回 `STALE_RUNTIME` 并回带 currentRevision。
 *
 * 注意：**同一 generation 内的不同动作是不同检查点**（不同 operationId），必须各自递增，
 * 不得按 generation 去重。
 */
export function decideCheckpoint(input: {
  request: { operationId: string; expectedRevision: number }
  existing: {
    revision: number
    /** 已存 operationId 及其内容摘要。 */
    operations: readonly { operationId: string; contentDigest: string }[]
  } | null
  /** 本次请求内容的规范摘要，用于判定同 operationId 是否内容一致。 */
  requestContentDigest: string
}): CheckpointDecision {
  const { request, existing, requestContentDigest } = input

  if (existing !== null) {
    const replay = existing.operations.find((item) => item.operationId === request.operationId)
    if (replay !== undefined) {
      if (replay.contentDigest === requestContentDigest) {
        return {
          kind: 'idempotent-replay',
          revision: existing.revision,
        }
      }
      return {
        kind: 'reject',
        code: 'PROTOCOL_INVALID',
        message: '同一 operationId 携带了不同内容，拒绝覆盖已保存的检查点',
        currentRevision: existing.revision,
      }
    }
  }

  const currentRevision = existing === null ? 0 : existing.revision
  if (request.expectedRevision !== currentRevision) {
    return {
      kind: 'reject',
      code: 'STALE_RUNTIME',
      message: `expectedRevision ${request.expectedRevision} 与当前 ${currentRevision} 不符`,
      currentRevision,
    }
  }

  return { kind: 'write', nextRevision: currentRevision + 1 }
}

/**
 * 判定结果。
 *
 * 注意：本函数**只做逻辑判定**，不接触存储、不感知锁，因此 `reject` 仅可能是
 * `STALE_RUNTIME`（版本冲突，含可信 currentRevision）或 `PROTOCOL_INVALID`（内容/幂等键冲突）。
 * 瞬态锁争用 `RATE_LIMIT` 发生在存储层事务边界，由实现层在调用本函数**之前**捕获并返回，
 * 不进入此判定，也不携带 currentRevision。
 */
export type CheckpointDecision =
  | { kind: 'idempotent-replay'; revision: number }
  | { kind: 'write'; nextRevision: number }
  | {
      kind: 'reject'
      code: 'STALE_RUNTIME' | 'PROTOCOL_INVALID'
      message: string
      currentRevision: number
    }

/** operationId 命名约束：与 AI 请求共用同一形态，便于审计与日志。 */
export const CHECKPOINT_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function isValidCheckpointOperationId(value: unknown): value is string {
  return typeof value === 'string' && CHECKPOINT_OPERATION_ID_PATTERN.test(value)
}

/**
 * 幂等键的作用范围（PM 2026-10-19 明确要求）。
 *
 * 同一个 `operationId` 字符串在不同玩家 / 不同游戏 / 不同存档下必须视为**不同**的保存动作。
 * 实现方若只用裸 `operationId` 作主键，会跨存档串号——A 存档的重放会命中 B 存档的记录。
 * 因此幂等键必须是四段组合，本函数是唯一构造入口。
 */
export interface CheckpointIdempotencyScope {
  /** 已绑定身份的玩家标识；不得由游戏自报。 */
  playerId: string
  gameId: string
  saveId: string
  operationId: string
}

export function checkpointIdempotencyKey(scope: CheckpointIdempotencyScope): string {
  return [scope.playerId, scope.gameId, scope.saveId, scope.operationId]
    .map((part) => part.replace(/[|]/g, '&#124;'))
    .join('|')
}

/**
 * 身份与键段的**统一编码约束**（PM 2026-10-19 冻结）。
 *
 * 背景：实测发现 `playerId: '../player-A'` 可造成路径穿越并覆盖他人存档。
 * 修复原则不是"随意限制字符集"，而是：
 * 1. 身份**必须存在**——缺失不得降级到公共路径（单玩家模式由宿主绑定固定身份）；
 * 2. 任何会进入存储键/路径的段，统一用本模块的编码函数处理，**不做隐式拼接**；
 * 3. 编码是**可逆且无歧义**的：只允许安全字符原样保留，其余字节转义为 `%XX`，
 *    使 `../`、`/`、`\`、`:` 等一律变成不可解释为分隔符的形式；
 * 4. 逻辑键（幂等键、存储键）与文件系统路径同源，键段安全即路径安全。
 */

/**
 * 无需转义的字符：字母、数字、点、连字符、下划线。
 *
 * 点允许出现在段内部（`example.minesweeping` 这类 gameId 是合法身份），
 * 但整段为 `.`/`..` 仍单独拒绝——真正危险的是"整段等于穿越"与分隔符，
 * 不是点本身。用字符白名单而非黑名单，避免漏掉 `\u0000` 之类。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * 把任意身份/键段编码成安全的单个路径段。
 *
 * 规则：
 * - 合法且安全的段（字母数字下划线连字符，长度 1..128）原样返回；
 * - 其余一律按 UTF-8 字节做 `%XX` 转义；
 * - 全点段（`.`、`..`）与空段直接判为非法，返回 `null`（调用方必须拒绝，不得回退默认值）。
 *
 * 注意：本函数**不做"清洗"**，非法输入返回 null 而不是悄悄改写，
 * 避免"清洗后恰好等于他人身份"这类碰撞。
 */
export function encodeKeySegment(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > 128) return null
  if (value === '.' || value === '..') return null
  if (SAFE_SEGMENT.test(value)) return value
  // 含不安全字符：按 UTF-8 字节逐个转义，避免任何分隔符语义。
  // 不用 TextEncoder：协议包要保持零运行时依赖与零宿主依赖（浏览器/Node 皆可），
  // 因此这里手写最小 UTF-8 编码。
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) {
      out += '%' + code.toString(16).toUpperCase().padStart(2, '0')
    } else if (code <= 0x7ff) {
      out += pct(0xc0 | (code >> 6)) + pct(0x80 | (code & 0x3f))
    } else if (code <= 0xffff) {
      out += pct(0xe0 | (code >> 12)) + pct(0x80 | ((code >> 6) & 0x3f)) + pct(0x80 | (code & 0x3f))
    } else {
      out +=
        pct(0xf0 | (code >> 18)) +
        pct(0x80 | ((code >> 12) & 0x3f)) +
        pct(0x80 | ((code >> 6) & 0x3f)) +
        pct(0x80 | (code & 0x3f))
    }
  }
  return out
}

function pct(byte: number): string {
  return '%' + byte.toString(16).toUpperCase().padStart(2, '0')
}

/** 身份是否可用作路径段：必须能编码且编码后仍是单段。 */
export function isValidIdentitySegment(value: unknown): value is string {
  const encoded = encodeKeySegment(value)
  if (encoded === null) return false
  // 编码结果不得包含任何分隔符或穿越语义。
  return !encoded.includes('/') && !encoded.includes('\\') && !encoded.includes('..')
}

/**
 * 由玩家身份 + 游戏 + 存档构造**存储键**（逻辑键，同时将作为相对路径）。
 *
 * 所有段都经 `encodeKeySegment`，任一段非法立即返回 `null`，
 * 调用方**必须**据此拒绝写入——不允许回落 `saves/<game>/<save>.json` 这种公共路径。
 */
export function saveStorageKey(input: {
  playerId: string
  gameId: string
  saveId: string
}): string | null {
  const player = encodeKeySegment(input.playerId)
  const game = encodeKeySegment(input.gameId)
  const save = encodeKeySegment(input.saveId)
  if (player === null || game === null || save === null) return null
  return `saves/${player}/${game}/${save}.json`
}

/**
 * 检查点内容摘要的**规范覆盖范围**（PM 2026-10-19 要求："不能只比较棋盘 state"）。
 *
 * 任何会改变"恢复后所见进度"的字段都必须进入摘要，否则「同 operationId + 改了 RNG/时间」
 * 会被误判为幂等重放而静默丢弃。
 *
 * 参与摘要的字段（顺序固定，缺失按 `null` 处理）：
 * - `state`：游戏不透明状态（按规范 JSON 序列化）
 * - `elapsedGameMs`：虚拟时间
 * - `rngState`：随机数状态
 * - `gameStateSchemaVersion`：状态结构版本（不同版本的同一 state 语义不同）
 * - `installedCommit`：固定提交（换版本后同 state 含义可能变）
 *
 * **不参与**摘要：`operationId`（它就是键本身）、`expectedRevision`（并发控制参数，
 * 重试时本来就可能与首次不同）、`generation`/`activeGeneration`（运行代次，不是存档语义）。
 */
export interface CheckpointContentInput {
  state: unknown
  elapsedGameMs: number
  rngState: string
  gameStateSchemaVersion: number
  installedCommit: string
}

/**
 * 生成参与幂等比对的规范内容描述。
 *
 * 注意：本函数只产出**规范化的可比字符串**，不在这里做 SHA-256——摘要算法由存储层决定，
 * 但必须基于这个字符串，保证"同一内容 → 同一摘要"在各实现间一致。
 */
export function canonicalCheckpointContent(input: CheckpointContentInput): string {
  const ordered = {
    installedCommit: input.installedCommit,
    gameStateSchemaVersion: input.gameStateSchemaVersion,
    elapsedGameMs: input.elapsedGameMs,
    rngState: input.rngState,
    state: input.state ?? null,
  }
  return stableStringify(ordered)
}

/** 递归按 key 排序的稳定 JSON 序列化；数组保序。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`
}
