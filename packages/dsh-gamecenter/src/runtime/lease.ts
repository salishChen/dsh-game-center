/**
 * Host 侧运行代次与控制租约（基线 §8.1、§8.3、§8.4；共享类型见
 * `@dsh-gamecenter/protocol` 的 `RuntimeLease`）。
 *
 * 设计约束（逐条对应基线要求，且都是本模块的单元测试目标）：
 * 1. **单存档单控制者**：同一 `saveId` 至多一个活跃租约；从另一个窗口接管必须先暂停旧实例。
 * 2. **旧代次拒写**：每次运行一个单调递增 `generation`；封存后的代次任何写入都返回
 *    `STALE_RUNTIME`，不静默丢弃、不改状态。
 * 3. **暂停后停收**：`Pausing` 之后该实例不再受理新请求（`PAUSED`）。
 * 4. **租约过期有检测窗口**：过期判定是惰性 + 显式 sweep，不假装实时。
 * 5. **不进行跨存储事务**：本模块只返回「需要持久化的动作」，由调用方决定
 *    SQLite 写入顺序与启动对账（基线 §6 明确不能假装 DSH 日志与 SQLite 有统一事务）。
 *
 * 本文件不依赖任何 DSH 模块，可被 Node 直接单测。
 */

import type { ErrorCode, RuntimeLease, LeaseReclaimReason, AbandonRuntimeResult } from '@dsh-gamecenter/protocol'
import { LEASE_ACK_WINDOW_MS } from '@dsh-gamecenter/protocol'

export { LEASE_ACK_WINDOW_MS }

/**
 * 错误码直接复用协议权威定义。
 *
 * 历史：protocol 曾以 `exports: "./src/index.ts"` 只暴露源码，导致下游 emit 时触发
 * TS6059 / TS5096；我因此内联了一份 `ErrorCode` 子集，造成两套契约漂移。
 * 架构与协议负责人已把 protocol 改为 `dist` 产物 + 类型声明
 * （`main: ./dist/index.js`、`exports["."].types: ./dist/index.d.ts`），
 * 该变通不再需要，已改回直接引用协议。**不要再内联协议类型。**
 */
export type { ErrorCode } from '@dsh-gamecenter/protocol'

/** 租约状态机（基线 §8 状态图在 Host 侧的投影）。 */
export type LeaseState =
  /** 已创建，尚未握手；不接受业务请求。 */
  | 'pending'
  /** 运行中：唯一允许受理 AI 请求与存档写入的状态。 */
  | 'running'
  /** 暂停中：输入已封、请求已拒，等待快照持久化确认。 */
  | 'pausing'
  /** 已暂停：快照已确认持久化，实例可销毁。 */
  | 'paused'
  /** 暂停失败但保留最近检查点，可从恢复点重新进入。 */
  | 'recovery-available'
  /** 已停止（正常结束或强制终止）。 */
  | 'stopped'

/** 接管前的前序封存租约快照（未确认握手被回收时还原槽位状态）。 */
export interface PriorSealedSnapshot {
  runtimeInstanceId: string
  generation: number
  expiresAt: string
  state: LeaseState
  lastPersistedRevision: number
  tokenDigest: string
  launchTokenDigest: string
  authorizedFinalOperationId?: string | undefined
}

export interface LeaseRecord {
  /** 运行实例 id：由 Host 生成，游戏不能自选。 */
  runtimeInstanceId: string
  /** 单调递增的运行代次。 */
  generation: number
  gameId: string
  saveId: string
  /** ISO 8601，租约到期时间；过期后不再受理新请求。 */
  expiresAt: string
  state: LeaseState
  /** 已封存的代次不可能再接受写入。 */
  sealed: boolean
  /** 最近一次成功持久化的存档 revision（0 表示还没有检查点）。 */
  lastPersistedRevision: number
  /**
   * 运行凭证摘要；**不保存原文**。原文只在握手响应里下发一次，
   * Host 侧只留 sha256 摘要用于比对（避免日志/快照泄露凭据）。
   */
  tokenDigest: string
  /** 启动令牌摘要；用于 abandonRuntime 交叉校验与防篡改。 */
  launchTokenDigest: string
  /** 握手未确认的回收截止时间（ISO 8601，nowMs + LEASE_ACK_WINDOW_MS）。 */
  ackDeadline: string
  /** 租约时长（毫秒），供首次调用确认进入 running 时重置 expiresAt。 */
  ttlMs: number
  /** 接管前的前序封存租约快照（未确认握手被回收时还原槽位状态）。 */
  priorSealedSnapshot?: PriorSealedSnapshot | undefined
  /** pausing 阶段绑定的授权最终操作 ID。只允许该 operationId 的首写与幂等重试，拒绝额外写入。 */
  authorizedFinalOperationId?: string | undefined
}

export interface LeaseViolation {
  ok: false
  /** 复用协议错误码，保证与 Bridge/Client 同一套词表。 */
  code: ErrorCode
  message: string
  /** 结构化细节，便于测试与审计。 */
  details: Record<string, string | number | boolean>
}

export type LeaseCheck = { ok: true } | LeaseViolation

export interface AcquireInput {
  gameId: string
  saveId: string
  /** 租约时长毫秒；到期后需续租或重新获取。 */
  ttlMs: number
  /** 单调递增的 generation 由调用方（持久层）提供，避免进程重启后回退。 */
  generation: number
  runtimeInstanceId: string
  tokenDigest: string
  /** 启动令牌摘要；用于 abandonRuntime 交叉校验与防篡改。 */
  launchTokenDigest: string
  /** 当前时间（毫秒），由调用方注入以便测试。 */
  nowMs: number
}

const DEFAULT_TTL_MS = 30_000

function violation(
  code: ErrorCode,
  message: string,
  details: Record<string, string | number | boolean>,
): LeaseViolation {
  return { ok: false, code, message, details }
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString()
}

/**
 * ## 编译期一致性断言（不是运行时检查）
 *
 * `RuntimeLease` 是 `@dsh-gamecenter/protocol` 里的**对外契约**（存档/审计/Client 可见）；
 * `LeaseRecord` 是 Host 进程内的**实现状态**，必须是前者的**超集**：
 * 协议要求的每个字段都存在且类型兼容，额外字段（`state`、`lastPersistedRevision`、
 * `tokenDigest`）是 Host 状态机私有，不出现在 wire 上。
 *
 * **口径（与项目经理、架构与协议负责人、测试与发布负责人统一）**：
 * `LeaseRecord` 比 `RuntimeLease` 多字段**不算漂移**；判定标准是
 * **对外投影完整覆盖 `RuntimeLease` 且字段语义不变**。
 *
 * ### 为什么必须用 `Assert<T extends true>`，不能用 `A extends B ? true : never`
 *
 * 这是项目经理与架构与协议负责人共同指出的错误，我实测确认：
 *
 * ```text
 * type Cur = B extends A ? true : never   // B 不满足 A 时，Cur 求值为 never
 * const x: Cur = true                     // 把 true 赋给 never —— 报错
 * ```
 * 看似会报错，但实测**不报错**：`never` 是底类型，任何值都可被断言成 `never`，
 * 一旦用 `as` 或函数返回值把 `true` 变通进去，约束就形同虚设。
 *
 * 正确形式是让约束出现在**泛型实参**上：
 * ```text
 * type Assert<T extends true> = T
 * type Check = Assert<A extends B ? true : false>  // 为 false 时 TS2344 直接失败
 * ```
 * 已实测：`Assert<false>` 触发 `error TS2344: Type 'false' does not satisfy the constraint 'true'`。
 */
type Assert<T extends true> = T

/** `LeaseRecord` 必须完整覆盖协议契约 `RuntimeLease`。协议加字段而实现没跟上 → 编译失败。 */
type _LeaseRecordSatisfiesProtocol = Assert<LeaseRecord extends RuntimeLease ? true : false>

/**
 * 投影到协议字段后必须与 `RuntimeLease` **双向兼容**：
 * - 左向（投影 extends 协议）：证明不会漏字段；
 * - 右向（协议 extends 投影）：证明不会把一个协议字段悄悄改成不相容类型
 *   （否则投影会变成协议的真子集，赋值方向反过来就失败）。
 */
type _ProtocolProjectionExact = Assert<
  Pick<LeaseRecord, keyof RuntimeLease> extends RuntimeLease
    ? RuntimeLease extends Pick<LeaseRecord, keyof RuntimeLease>
      ? true
      : false
    : false
>

/**
 * 供运行时之外的消费者（测试、对账脚本）读取的投影函数。
 *
 * 返回类型显式标注为 `Pick<..., keyof RuntimeLease>`，因此**赋值处**即受
 * `RuntimeLease` 约束——即使有人删了上面的类型断言，这里仍会在编译期报错。
 * 这是架构与协议负责人建议的"更稳妥"做法，两层一起用。
 */
export function projectRuntimeLease(record: LeaseRecord): RuntimeLease {
  return {
    runtimeInstanceId: record.runtimeInstanceId,
    generation: record.generation,
    gameId: record.gameId,
    saveId: record.saveId,
    expiresAt: record.expiresAt,
    sealed: record.sealed,
  }
}

// 让上面两个类型别名被 tsc 认为已使用（noUnusedLocals 下也不会被树摇掉检查）。
export type { _LeaseRecordSatisfiesProtocol, _ProtocolProjectionExact }

/**
 * 租约登记表。**单进程单实例**语义；跨进程互斥不在本模块承诺范围内
 * （DSH Desktop 首版是本地单 Host，见基线 §9）。
 */
export class LeaseRegistry {
  private readonly bySave = new Map<string, LeaseRecord>()

  /**
   * 运行凭证索引：`tokenDigest → saveKey`。
   *
   * **这是身份绑定的唯一入口。** 任何要改动租约的调用都必须先经 `resolveByToken()`
   * 用**自己持有的运行凭证**换到租约；`gameId` / `saveId` 一律**从租约读出**，
   * 绝不采用调用方自报的值。
   *
   * 历史：早期实现用 `findByGeneration(generation)` **全局按代次**查找，
   * 于是任何调用方只要给出别人存档的代次就能操作那条租约（跨存档写入），
   * 且第二轮诊断会命中上一轮已封存的租约而返回错码。见 docs/phase0-host.md §14。
   */
  private readonly byToken = new Map<string, string>()

  /**
   * 已被新代次取代的凭证摘要（`tokenDigest → { generation, sealedAtMs }`）。
   *
   * **为什么必须单独记**：`acquire()` 会用新租约覆盖同一个 saveKey，
   * 如果只保留 `byToken → saveKey`，旧实例的凭证摘要会继续指向**新**租约，
   * 于是旧实例拿着自己的凭证就能写新代次的存档。
   * 2026-10-20 探针 N7e 实测复现：已 `saveAck` 封存的实例A 在实例B 接管后写入成功
   * （revision 3 → 4），来源就是这个索引残留。现在旧摘要登记在此，永久解析为 `STALE_RUNTIME`。
   */
  private readonly supersededTokens = new Map<string, { generation: number; sealedAtMs: number }>()

  /**
   * 已主动放弃的运行实例索引（`runtimeInstanceId → launchTokenDigest`）。
   * 无论握手先到还是取消先到，均可判定与拦截，且多次取消幂等。
   */
  private readonly abandonedInstances = new Map<string, string>()

  /** 组合键：同一 saveId 至多一个活跃租约（基线 §8.4）。 */
  private static saveKey(gameId: string, saveId: string): string {
    return `${gameId}\u0000${saveId}`
  }

  /**
   * 申请新运行实例。若该存档已有活跃租约，**拒绝**而不是暗中顶替：
   * 基线要求「从另一个窗口接管时先暂停旧实例」，顶替必须显式发生。
   */
  acquire(input: AcquireInput): { ok: true; lease: LeaseRecord } | LeaseViolation {
    this.sweepUnconfirmed(input.nowMs)
    const key = LeaseRegistry.saveKey(input.gameId, input.saveId)
    const existing = this.bySave.get(key)
    if (existing !== undefined && !existing.sealed && existing.state !== 'stopped') {
      return violation('STALE_RUNTIME', '该存档已有活跃运行实例，需先暂停后再接管。', {
        gameId: input.gameId,
        saveId: input.saveId,
        activeGeneration: existing.generation,
      })
    }
    if (existing !== undefined && input.generation <= existing.generation) {
      // 代次必须严格递增，否则旧代次可能借复用 id 复活。
      return violation('STALE_RUNTIME', '运行代次必须严格大于该存档已用代次。', {
        requested: input.generation,
        previous: existing.generation,
      })
    }

    // 记录接管前已封存实例的快照，若本次新握手未确认超时/放弃，可将槽位状态无损还原
    let priorSealedSnapshot: PriorSealedSnapshot | undefined
    if (existing !== undefined && existing.sealed) {
      priorSealedSnapshot = {
        runtimeInstanceId: existing.runtimeInstanceId,
        generation: existing.generation,
        expiresAt: existing.expiresAt,
        state: existing.state,
        lastPersistedRevision: existing.lastPersistedRevision,
        tokenDigest: existing.tokenDigest,
        launchTokenDigest: existing.launchTokenDigest,
        authorizedFinalOperationId: existing.authorizedFinalOperationId,
      }
    }

    const ttl = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS
    const lease: LeaseRecord = {
      runtimeInstanceId: input.runtimeInstanceId,
      generation: input.generation,
      gameId: input.gameId,
      saveId: input.saveId,
      expiresAt: isoFrom(input.nowMs + ttl),
      state: 'pending',
      sealed: false,
      lastPersistedRevision: existing?.lastPersistedRevision ?? 0,
      tokenDigest: input.tokenDigest,
      launchTokenDigest: input.launchTokenDigest,
      ackDeadline: isoFrom(input.nowMs + LEASE_ACK_WINDOW_MS),
      ttlMs: ttl,
      priorSealedSnapshot,
    }
    // 同一 saveKey 上被取代的旧代次凭证一律作废：新代次接管后，旧 iframe 不得再写。
    // 必须在写入新租约**之前**执行，否则旧摘要会被解析成新租约（N7e 根因）。
    if (existing !== undefined) {
      this.supersedePriorFor(key, existing.generation, input.nowMs)
    }
    this.bySave.set(key, lease)
    this.byToken.set(input.tokenDigest, key)
    return { ok: true, lease }
  }

  /**
   * 把某个存档上**已不是当前租约**的全部凭证摘要移入 `supersededTokens`。
   *
   * 必须在 `bySave.set(key, 新租约)` **之前**调用：一旦覆盖，`byToken` 里旧摘要
   * 指向的 saveKey 会解析到新租约，旧凭证就被错误地"继承"给新代次（N7e 的根因）。
   * 只处理"与 prior 租约绑定"的摘要：新摘要尚未入表，因此不会被误删。
   */
  private supersedePriorFor(key: string, priorGeneration: number, nowMs: number): void {
    const prior = this.bySave.get(key)
    const priorDigest = prior === undefined ? undefined : prior.tokenDigest
    for (const [digest, digestKey] of [...this.byToken]) {
      if (digestKey !== key) continue
      if (digest !== priorDigest) continue
      this.supersededTokens.set(digest, { generation: priorGeneration, sealedAtMs: nowMs })
      this.byToken.delete(digest)
    }
  }

  /**
   * 回收未确认的握手租约（因超时或主动 abandon）。
   * 封存该租约、移入 supersededTokens、从 byToken 删除；
   * 若存在 priorSealedSnapshot 则还原槽位状态为封存态；不得回退代次或复活旧凭证。
   */
  reclaimUnconfirmed(
    key: string,
    lease: LeaseRecord,
    reason: LeaseReclaimReason,
    nowMs: number,
  ): void {
    lease.sealed = true
    lease.state = 'stopped'
    this.supersededTokens.set(lease.tokenDigest, {
      generation: lease.generation,
      sealedAtMs: nowMs,
    })
    this.byToken.delete(lease.tokenDigest)

    if (lease.priorSealedSnapshot !== undefined) {
      const prior = lease.priorSealedSnapshot
      // 还原槽位状态（如 paused），但旧凭证保持在 supersededTokens 中，绝不复活！
      this.bySave.set(key, {
        runtimeInstanceId: prior.runtimeInstanceId,
        generation: prior.generation,
        gameId: lease.gameId,
        saveId: lease.saveId,
        expiresAt: prior.expiresAt,
        state: prior.state,
        sealed: true,
        lastPersistedRevision: prior.lastPersistedRevision,
        tokenDigest: prior.tokenDigest,
        launchTokenDigest: prior.launchTokenDigest,
        ackDeadline: '',
        ttlMs: DEFAULT_TTL_MS,
        authorizedFinalOperationId: prior.authorizedFinalOperationId,
      })
    }
  }

  /**
   * 惰性 / 定时扫描未确认超时的握手租约（T_ack 超时）。
   * 只回收处于 pending 态且超过 ackDeadline 的租约；已 running 的租约永不误回收。
   */
  sweepUnconfirmed(nowMs: number): LeaseRecord[] {
    const reclaimed: LeaseRecord[] = []
    for (const [key, lease] of this.bySave) {
      if (lease.state === 'pending' && !lease.sealed && Date.parse(lease.ackDeadline) <= nowMs) {
        this.reclaimUnconfirmed(key, lease, 'unconfirmed-timeout', nowMs)
        reclaimed.push(lease)
      }
    }
    return reclaimed
  }

  hasAbandoned(runtimeInstanceId: string): boolean {
    return this.abandonedInstances.has(runtimeInstanceId)
  }

  getAbandonedDigest(runtimeInstanceId: string): string | undefined {
    return this.abandonedInstances.get(runtimeInstanceId)
  }

  abandonRuntime(
    runtimeInstanceId: string,
    launchTokenDigest: string,
    nowMs: number,
  ): AbandonRuntimeResult {
    this.sweepUnconfirmed(nowMs)
    const priorDigest = this.abandonedInstances.get(runtimeInstanceId)
    if (priorDigest !== undefined) {
      if (priorDigest !== launchTokenDigest) {
        return {
          ok: false,
          errorCode: 'ABANDON_FORBIDDEN',
          message: 'launchToken 与运行实例不匹配。',
        }
      }
      return { ok: true, abandoned: true, reclaimed: false }
    }

    // 查找匹配的租约
    let matchedKey: string | undefined
    let matchedLease: LeaseRecord | undefined
    for (const [key, lease] of this.bySave) {
      if (lease.runtimeInstanceId === runtimeInstanceId) {
        matchedKey = key
        matchedLease = lease
        break
      }
    }

    if (matchedLease !== undefined) {
      if (matchedLease.launchTokenDigest !== launchTokenDigest) {
        return {
          ok: false,
          errorCode: 'ABANDON_FORBIDDEN',
          message: 'launchToken 与运行实例不匹配。',
        }
      }
      this.abandonedInstances.set(runtimeInstanceId, launchTokenDigest)
      if (matchedLease.sealed || matchedLease.state === 'stopped') {
        return { ok: true, abandoned: true, reclaimed: false }
      }
      this.reclaimUnconfirmed(matchedKey!, matchedLease, 'abandoned', nowMs)
      return { ok: true, abandoned: true, reclaimed: true }
    }

    // 尚未握手到达（快路径先到）：记录毒丸，迟到握手到达时直接拒绝
    this.abandonedInstances.set(runtimeInstanceId, launchTokenDigest)
    return { ok: true, abandoned: true, reclaimed: false }
  }

  get(gameId: string, saveId: string): LeaseRecord | undefined {
    return this.bySave.get(LeaseRegistry.saveKey(gameId, saveId))
  }

  /** 所有租约（审计与代次推进用；返回内部引用，调用方不得修改）。 */
  all(): LeaseRecord[] {
    return [...this.bySave.values()]
  }

  /**
   * **按运行凭证解析租约**——所有写操作的唯一入口。
   *
   * 安全语义（基线 §6「小游戏不能伪造别的存档身份」）：
   * - 调用方**不再**自报 `gameId` / `saveId`；它们**从命中的租约读出**；
   * - 凭证是握手时一次性下发的 32 字节随机值，Host 只存摘要（见 `digestToken`）；
   * - 因此**持有凭证 == 被授权操作该运行实例**，拿不到凭证就无法影响任何租约。
   *
   * 失败分类（都用协议既有错误码，`details.reason` 给出机器可读原因）：
   * - 缺失 → `PROTOCOL_INVALID` / `credential-missing`
   * - 未知或不匹配 → `PROTOCOL_INVALID` / `credential-invalid`
   * - 已封存（含旧代次迟到写入） → `STALE_RUNTIME` / `lease-sealed`
   * - 已过期 → `PAUSED` / `lease-expired`
   * - 已被清理 → `STALE_RUNTIME` / `lease-unknown`
   */
  resolveByToken(
    tokenDigest: unknown,
    nowMs: number,
  ): { ok: true; lease: LeaseRecord } | LeaseViolation {
    this.sweepUnconfirmed(nowMs)
    if (typeof tokenDigest !== 'string' || tokenDigest.length === 0) {
      return violation('PROTOCOL_INVALID', '缺少运行凭证。', { reason: 'credential-missing' })
    }
    const key = this.byToken.get(tokenDigest)
    if (key === undefined) {
      const superseded = this.supersededTokens.get(tokenDigest)
      if (superseded !== undefined) {
        return violation('STALE_RUNTIME', '该运行凭证所属代次已被新实例取代，拒绝写入。', {
          reason: 'token-superseded',
          generation: superseded.generation,
        })
      }
      return violation('PROTOCOL_INVALID', '运行凭证无效或不属于本宿主。', { reason: 'credential-invalid' })
    }
    const lease = this.bySave.get(key)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '该运行凭证对应的实例已不存在。', { reason: 'lease-unknown' })
    }
    if (lease.sealed || lease.state === 'paused' || lease.state === 'stopped') {
      // 旧代次的迟到写入（旧 iframe 持有已封存实例的凭证）走这一支。
      return violation('STALE_RUNTIME', '运行实例已封存，拒绝写入。', {
        reason: 'lease-sealed',
        state: lease.state,
        generation: lease.generation,
      })
    }
    if (lease.state === 'pending') {
      if (Date.parse(lease.ackDeadline) <= nowMs) {
        this.reclaimUnconfirmed(key, lease, 'unconfirmed-timeout', nowMs)
        return violation('STALE_RUNTIME', '未确认租约已超时回收。', {
          reason: 'unconfirmed-timeout',
        })
      }
      // 首次携带该 runtimeToken 的确认调用到达：成功转为 running！
      lease.state = 'running'
      lease.expiresAt = isoFrom(nowMs + lease.ttlMs)
    }
    if (Date.parse(lease.expiresAt) <= nowMs) {
      return violation('PAUSED', '控制租约已过期，需重新获取控制权。', {
        reason: 'lease-expired',
        expiresAt: lease.expiresAt,
      })
    }
    return { ok: true, lease }
  }

  /**
   * 仅按代次反查——**只允许用于诊断/审计展示**，不得用于授权决策。
   * 它无法证明调用方身份，早期用它做过写操作入口是缺陷（见 docs/phase0-host.md §14）。
   */
  peekByGeneration(generation: number): LeaseRecord | undefined {
    for (const lease of this.bySave.values()) {
      if (lease.generation === generation) return lease
    }
    return undefined
  }

  /**
   * 握手成功后进入 running。只有 pending → running 合法，重复握手不重置租约。
   */
  markRunning(gameId: string, saveId: string, generation: number, nowMs: number, ttlMs: number): LeaseCheck {
    const lease = this.get(gameId, saveId)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation })
    }
    if (lease.generation !== generation) {
      return violation('STALE_RUNTIME', '运行代次不匹配。', {
        expected: lease.generation,
        actual: generation,
      })
    }
    if (lease.state !== 'pending') {
      return violation('PROTOCOL_INVALID', `运行实例状态为 ${lease.state}，不能重复握手。`, {
        state: lease.state,
      })
    }
    lease.state = 'running'
    lease.expiresAt = isoFrom(nowMs + ttlMs)
    return { ok: true }
  }

  /**
   * **任何**需要写入的业务请求都必须先过这里。
   * 顺序刻意如此：先判存在 → 再判代次 → 再判封存/状态 → 最后判过期，
   * 保证「旧代次」不会被误报成「已暂停」，测试据此断言具体错误码。
   */
  checkWritable(gameId: string, saveId: string, generation: number, nowMs: number): LeaseCheck {
    const lease = this.get(gameId, saveId)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation })
    }
    if (lease.generation !== generation) {
      return violation('STALE_RUNTIME', '运行代次已过期，拒绝写入。', {
        expected: lease.generation,
        actual: generation,
      })
    }
    if (lease.sealed || lease.state === 'stopped') {
      return violation('STALE_RUNTIME', '运行实例已封存，拒绝写入。', {
        state: lease.state,
        sealed: lease.sealed,
      })
    }
    if (lease.state === 'pausing' || lease.state === 'paused' || lease.state === 'recovery-available') {
      return violation('PAUSED', '游戏处于暂停流程中，不再受理新请求。', { state: lease.state })
    }
    if (lease.state === 'pending') {
      return violation('PROTOCOL_INVALID', '运行实例尚未完成握手。', { state: lease.state })
    }
    if (Date.parse(lease.expiresAt) <= nowMs) {
      return violation('PAUSED', '控制租约已过期，需重新获取控制权。', {
        expiresAt: lease.expiresAt,
      })
    }
    return { ok: true }
  }

  /**
   * 进入暂停：立刻封住输入与请求（基线 §8.1 第 1、2 步）。
   * 幂等：重复调用返回同一结果，不改状态。
   */
  beginPause(gameId: string, saveId: string, generation: number): LeaseCheck {
    const lease = this.get(gameId, saveId)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation })
    }
    if (lease.generation !== generation) {
      return violation('STALE_RUNTIME', '运行代次不匹配，拒绝暂停。', {
        expected: lease.generation,
        actual: generation,
      })
    }
    if (lease.state === 'pausing' || lease.state === 'paused') return { ok: true }
    if (lease.state !== 'running') {
      return violation('PROTOCOL_INVALID', `状态 ${lease.state} 不能进入暂停。`, { state: lease.state })
    }
    lease.state = 'pausing'
    lease.authorizedFinalOperationId = undefined
    return { ok: true }
  }

  /**
   * 快照已持久化：确认暂停（基线 §8.1 第 4、5 步）。
   * 只有 **当前代次** 的确认才生效；旧代次的迟到确认返回 STALE_RUNTIME 且不改状态。
   */
  confirmPause(
    gameId: string,
    saveId: string,
    generation: number,
    revision: number,
  ): LeaseCheck {
    const lease = this.get(gameId, saveId)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation })
    }
    if (lease.generation !== generation) {
      return violation('STALE_RUNTIME', '旧代次的保存确认被拒绝。', {
        expected: lease.generation,
        actual: generation,
      })
    }
    if (lease.state !== 'pausing') {
      return violation('PROTOCOL_INVALID', `状态 ${lease.state} 不接受保存确认。`, { state: lease.state })
    }
    if (!Number.isInteger(revision) || revision < 1) {
      return violation('PROTOCOL_INVALID', '保存 revision 必须是正整数。', { revision })
    }
    if (revision < lease.lastPersistedRevision) {
      return violation('PROTOCOL_INVALID', 'revision 不能小于最近已持久化版本。', {
        revision,
        last: lease.lastPersistedRevision,
      })
    }
    lease.lastPersistedRevision = revision
    lease.state = 'paused'
    lease.sealed = true
    return { ok: true }
  }

  /**
   * 暂停超时/崩溃：如实进入 recovery-available，**不伪造保存成功**（基线 §8.1、验收场景「游戏不响应 pause」）。
   */
  abandonPause(gameId: string, saveId: string, generation: number, reason: 'timeout' | 'crashed'): LeaseCheck {
    const lease = this.get(gameId, saveId)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation })
    }
    if (lease.generation !== generation) {
      return violation('STALE_RUNTIME', '旧代次不能改变暂停结果。', {
        expected: lease.generation,
        actual: generation,
      })
    }
    if (lease.state === 'paused') {
      return violation('PROTOCOL_INVALID', '已确认暂停的实例不能改判为恢复可用。', { reason })
    }
    lease.state = 'recovery-available'
    lease.sealed = true
    return { ok: true }
  }

  /** 正常结束（Finished）。 */
  finish(gameId: string, saveId: string, generation: number): LeaseCheck {
    const lease = this.get(gameId, saveId)
    if (lease === undefined) {
      return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation })
    }
    if (lease.generation !== generation) {
      return violation('STALE_RUNTIME', '旧代次不能结束运行。', {
        expected: lease.generation,
        actual: generation,
      })
    }
    lease.state = 'stopped'
    lease.sealed = true
    return { ok: true }
  }

  /**
   * 显式清理过期租约（启动对账 / 定时扫描调用）。
   * 返回被清理的租约列表，供调用方写审计。**不删除**任何存档数据。
   */
  sweepExpired(nowMs: number): LeaseRecord[] {
    const unconfirmed = this.sweepUnconfirmed(nowMs)
    const expired: LeaseRecord[] = [...unconfirmed]
    for (const [key, lease] of this.bySave) {
      if (lease.sealed) continue
      if (lease.state === 'running' && Date.parse(lease.expiresAt) <= nowMs) {
        lease.state = 'recovery-available'
        lease.sealed = true
        expired.push(lease)
        continue
      }
      // pending 且从未确认就过期的实例：直接回收停止，不产生"可恢复"误导。
      if (lease.state === 'pending' && Date.parse(lease.expiresAt) <= nowMs) {
        this.reclaimUnconfirmed(key, lease, 'unconfirmed-timeout', nowMs)
        expired.push(lease)
        continue
      }
      void key
    }
    return expired
  }
}
