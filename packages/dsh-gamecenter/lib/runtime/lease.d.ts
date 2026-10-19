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
import type { ErrorCode, RuntimeLease } from '@dsh-gamecenter/protocol';
/**
 * 错误码直接复用协议权威定义。
 *
 * 历史：protocol 曾以 `exports: "./src/index.ts"` 只暴露源码，导致下游 emit 时触发
 * TS6059 / TS5096；我因此内联了一份 `ErrorCode` 子集，造成两套契约漂移。
 * 架构与协议负责人已把 protocol 改为 `dist` 产物 + 类型声明
 * （`main: ./dist/index.js`、`exports["."].types: ./dist/index.d.ts`），
 * 该变通不再需要，已改回直接引用协议。**不要再内联协议类型。**
 */
export type { ErrorCode } from '@dsh-gamecenter/protocol';
/** 租约状态机（基线 §8 状态图在 Host 侧的投影）。 */
export type LeaseState = 
/** 已创建，尚未握手；不接受业务请求。 */
'pending'
/** 运行中：唯一允许受理 AI 请求与存档写入的状态。 */
 | 'running'
/** 暂停中：输入已封、请求已拒，等待快照持久化确认。 */
 | 'pausing'
/** 已暂停：快照已确认持久化，实例可销毁。 */
 | 'paused'
/** 暂停失败但保留最近检查点，可从恢复点重新进入。 */
 | 'recovery-available'
/** 已停止（正常结束或强制终止）。 */
 | 'stopped';
export interface LeaseRecord {
    /** 运行实例 id：由 Host 生成，游戏不能自选。 */
    runtimeInstanceId: string;
    /** 单调递增的运行代次。 */
    generation: number;
    gameId: string;
    saveId: string;
    /** ISO 8601，租约到期时间；过期后不再受理新请求。 */
    expiresAt: string;
    state: LeaseState;
    /** 已封存的代次不可能再接受写入。 */
    sealed: boolean;
    /** 最近一次成功持久化的存档 revision（0 表示还没有检查点）。 */
    lastPersistedRevision: number;
    /**
     * 运行凭证摘要；**不保存原文**。原文只在握手响应里下发一次，
     * Host 侧只留 sha256 摘要用于比对（避免日志/快照泄露凭据）。
     */
    tokenDigest: string;
}
export interface LeaseViolation {
    ok: false;
    /** 复用协议错误码，保证与 Bridge/Client 同一套词表。 */
    code: ErrorCode;
    message: string;
    /** 结构化细节，便于测试与审计。 */
    details: Record<string, string | number | boolean>;
}
export type LeaseCheck = {
    ok: true;
} | LeaseViolation;
export interface AcquireInput {
    gameId: string;
    saveId: string;
    /** 租约时长毫秒；到期后需续租或重新获取。 */
    ttlMs: number;
    /** 单调递增的 generation 由调用方（持久层）提供，避免进程重启后回退。 */
    generation: number;
    runtimeInstanceId: string;
    tokenDigest: string;
    /** 当前时间（毫秒），由调用方注入以便测试。 */
    nowMs: number;
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
type Assert<T extends true> = T;
/** `LeaseRecord` 必须完整覆盖协议契约 `RuntimeLease`。协议加字段而实现没跟上 → 编译失败。 */
type _LeaseRecordSatisfiesProtocol = Assert<LeaseRecord extends RuntimeLease ? true : false>;
/**
 * 投影到协议字段后必须与 `RuntimeLease` **双向兼容**：
 * - 左向（投影 extends 协议）：证明不会漏字段；
 * - 右向（协议 extends 投影）：证明不会把一个协议字段悄悄改成不相容类型
 *   （否则投影会变成协议的真子集，赋值方向反过来就失败）。
 */
type _ProtocolProjectionExact = Assert<Pick<LeaseRecord, keyof RuntimeLease> extends RuntimeLease ? RuntimeLease extends Pick<LeaseRecord, keyof RuntimeLease> ? true : false : false>;
/**
 * 供运行时之外的消费者（测试、对账脚本）读取的投影函数。
 *
 * 返回类型显式标注为 `Pick<..., keyof RuntimeLease>`，因此**赋值处**即受
 * `RuntimeLease` 约束——即使有人删了上面的类型断言，这里仍会在编译期报错。
 * 这是架构与协议负责人建议的"更稳妥"做法，两层一起用。
 */
export declare function projectRuntimeLease(record: LeaseRecord): RuntimeLease;
export type { _LeaseRecordSatisfiesProtocol, _ProtocolProjectionExact };
/**
 * 租约登记表。**单进程单实例**语义；跨进程互斥不在本模块承诺范围内
 * （DSH Desktop 首版是本地单 Host，见基线 §9）。
 */
export declare class LeaseRegistry {
    private readonly bySave;
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
    private readonly byToken;
    /** 组合键：同一 saveId 至多一个活跃租约（基线 §8.4）。 */
    private static saveKey;
    /**
     * 申请新运行实例。若该存档已有活跃租约，**拒绝**而不是暗中顶替：
     * 基线要求「从另一个窗口接管时先暂停旧实例」，顶替必须显式发生。
     */
    acquire(input: AcquireInput): {
        ok: true;
        lease: LeaseRecord;
    } | LeaseViolation;
    get(gameId: string, saveId: string): LeaseRecord | undefined;
    /** 所有租约（审计与代次推进用；返回内部引用，调用方不得修改）。 */
    all(): LeaseRecord[];
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
    resolveByToken(tokenDigest: unknown, nowMs: number): {
        ok: true;
        lease: LeaseRecord;
    } | LeaseViolation;
    /**
     * 仅按代次反查——**只允许用于诊断/审计展示**，不得用于授权决策。
     * 它无法证明调用方身份，早期用它做过写操作入口是缺陷（见 docs/phase0-host.md §14）。
     */
    peekByGeneration(generation: number): LeaseRecord | undefined;
    /**
     * 握手成功后进入 running。只有 pending → running 合法，重复握手不重置租约。
     */
    markRunning(gameId: string, saveId: string, generation: number, nowMs: number, ttlMs: number): LeaseCheck;
    /**
     * **任何**需要写入的业务请求都必须先过这里。
     * 顺序刻意如此：先判存在 → 再判代次 → 再判封存/状态 → 最后判过期，
     * 保证「旧代次」不会被误报成「已暂停」，测试据此断言具体错误码。
     */
    checkWritable(gameId: string, saveId: string, generation: number, nowMs: number): LeaseCheck;
    /**
     * 进入暂停：立刻封住输入与请求（基线 §8.1 第 1、2 步）。
     * 幂等：重复调用返回同一结果，不改状态。
     */
    beginPause(gameId: string, saveId: string, generation: number): LeaseCheck;
    /**
     * 快照已持久化：确认暂停（基线 §8.1 第 4、5 步）。
     * 只有 **当前代次** 的确认才生效；旧代次的迟到确认返回 STALE_RUNTIME 且不改状态。
     */
    confirmPause(gameId: string, saveId: string, generation: number, revision: number): LeaseCheck;
    /**
     * 暂停超时/崩溃：如实进入 recovery-available，**不伪造保存成功**（基线 §8.1、验收场景「游戏不响应 pause」）。
     */
    abandonPause(gameId: string, saveId: string, generation: number, reason: 'timeout' | 'crashed'): LeaseCheck;
    /** 正常结束（Finished）。 */
    finish(gameId: string, saveId: string, generation: number): LeaseCheck;
    /**
     * 显式清理过期租约（启动对账 / 定时扫描调用）。
     * 返回被清理的租约列表，供调用方写审计。**不删除**任何存档数据。
     */
    sweepExpired(nowMs: number): LeaseRecord[];
}
