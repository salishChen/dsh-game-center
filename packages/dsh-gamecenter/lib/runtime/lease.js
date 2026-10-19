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
const DEFAULT_TTL_MS = 30_000;
function violation(code, message, details) {
    return { ok: false, code, message, details };
}
function isoFrom(nowMs) {
    return new Date(nowMs).toISOString();
}
/**
 * 供运行时之外的消费者（测试、对账脚本）读取的投影函数。
 *
 * 返回类型显式标注为 `Pick<..., keyof RuntimeLease>`，因此**赋值处**即受
 * `RuntimeLease` 约束——即使有人删了上面的类型断言，这里仍会在编译期报错。
 * 这是架构与协议负责人建议的"更稳妥"做法，两层一起用。
 */
export function projectRuntimeLease(record) {
    return {
        runtimeInstanceId: record.runtimeInstanceId,
        generation: record.generation,
        gameId: record.gameId,
        saveId: record.saveId,
        expiresAt: record.expiresAt,
        sealed: record.sealed,
    };
}
/**
 * 租约登记表。**单进程单实例**语义；跨进程互斥不在本模块承诺范围内
 * （DSH Desktop 首版是本地单 Host，见基线 §9）。
 */
export class LeaseRegistry {
    bySave = new Map();
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
    byToken = new Map();
    /** 组合键：同一 saveId 至多一个活跃租约（基线 §8.4）。 */
    static saveKey(gameId, saveId) {
        return `${gameId}\u0000${saveId}`;
    }
    /**
     * 申请新运行实例。若该存档已有活跃租约，**拒绝**而不是暗中顶替：
     * 基线要求「从另一个窗口接管时先暂停旧实例」，顶替必须显式发生。
     */
    acquire(input) {
        const key = LeaseRegistry.saveKey(input.gameId, input.saveId);
        const existing = this.bySave.get(key);
        if (existing !== undefined && !existing.sealed && existing.state !== 'stopped') {
            return violation('STALE_RUNTIME', '该存档已有活跃运行实例，需先暂停后再接管。', {
                gameId: input.gameId,
                saveId: input.saveId,
                activeGeneration: existing.generation,
            });
        }
        if (existing !== undefined && input.generation <= existing.generation) {
            // 代次必须严格递增，否则旧代次可能借复用 id 复活。
            return violation('STALE_RUNTIME', '运行代次必须严格大于该存档已用代次。', {
                requested: input.generation,
                previous: existing.generation,
            });
        }
        const ttl = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
        const lease = {
            runtimeInstanceId: input.runtimeInstanceId,
            generation: input.generation,
            gameId: input.gameId,
            saveId: input.saveId,
            expiresAt: isoFrom(input.nowMs + ttl),
            state: 'pending',
            sealed: false,
            lastPersistedRevision: 0,
            tokenDigest: input.tokenDigest,
        };
        this.bySave.set(key, lease);
        this.byToken.set(input.tokenDigest, key);
        return { ok: true, lease };
    }
    get(gameId, saveId) {
        return this.bySave.get(LeaseRegistry.saveKey(gameId, saveId));
    }
    /** 所有租约（审计与代次推进用；返回内部引用，调用方不得修改）。 */
    all() {
        return [...this.bySave.values()];
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
    resolveByToken(tokenDigest, nowMs) {
        if (typeof tokenDigest !== 'string' || tokenDigest.length === 0) {
            return violation('PROTOCOL_INVALID', '缺少运行凭证。', { reason: 'credential-missing' });
        }
        const key = this.byToken.get(tokenDigest);
        if (key === undefined) {
            return violation('PROTOCOL_INVALID', '运行凭证无效或不属于本宿主。', { reason: 'credential-invalid' });
        }
        const lease = this.bySave.get(key);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '该运行凭证对应的实例已不存在。', { reason: 'lease-unknown' });
        }
        if (lease.sealed || lease.state === 'paused' || lease.state === 'stopped') {
            // 旧代次的迟到写入（旧 iframe 持有已封存实例的凭证）走这一支。
            return violation('STALE_RUNTIME', '运行实例已封存，拒绝写入。', {
                reason: 'lease-sealed',
                state: lease.state,
                generation: lease.generation,
            });
        }
        if (Date.parse(lease.expiresAt) <= nowMs) {
            return violation('PAUSED', '控制租约已过期，需重新获取控制权。', {
                reason: 'lease-expired',
                expiresAt: lease.expiresAt,
            });
        }
        return { ok: true, lease };
    }
    /**
     * 仅按代次反查——**只允许用于诊断/审计展示**，不得用于授权决策。
     * 它无法证明调用方身份，早期用它做过写操作入口是缺陷（见 docs/phase0-host.md §14）。
     */
    peekByGeneration(generation) {
        for (const lease of this.bySave.values()) {
            if (lease.generation === generation)
                return lease;
        }
        return undefined;
    }
    /**
     * 握手成功后进入 running。只有 pending → running 合法，重复握手不重置租约。
     */
    markRunning(gameId, saveId, generation, nowMs, ttlMs) {
        const lease = this.get(gameId, saveId);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation });
        }
        if (lease.generation !== generation) {
            return violation('STALE_RUNTIME', '运行代次不匹配。', {
                expected: lease.generation,
                actual: generation,
            });
        }
        if (lease.state !== 'pending') {
            return violation('PROTOCOL_INVALID', `运行实例状态为 ${lease.state}，不能重复握手。`, {
                state: lease.state,
            });
        }
        lease.state = 'running';
        lease.expiresAt = isoFrom(nowMs + ttlMs);
        return { ok: true };
    }
    /**
     * **任何**需要写入的业务请求都必须先过这里。
     * 顺序刻意如此：先判存在 → 再判代次 → 再判封存/状态 → 最后判过期，
     * 保证「旧代次」不会被误报成「已暂停」，测试据此断言具体错误码。
     */
    checkWritable(gameId, saveId, generation, nowMs) {
        const lease = this.get(gameId, saveId);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation });
        }
        if (lease.generation !== generation) {
            return violation('STALE_RUNTIME', '运行代次已过期，拒绝写入。', {
                expected: lease.generation,
                actual: generation,
            });
        }
        if (lease.sealed || lease.state === 'stopped') {
            return violation('STALE_RUNTIME', '运行实例已封存，拒绝写入。', {
                state: lease.state,
                sealed: lease.sealed,
            });
        }
        if (lease.state === 'pausing' || lease.state === 'paused' || lease.state === 'recovery-available') {
            return violation('PAUSED', '游戏处于暂停流程中，不再受理新请求。', { state: lease.state });
        }
        if (lease.state === 'pending') {
            return violation('PROTOCOL_INVALID', '运行实例尚未完成握手。', { state: lease.state });
        }
        if (Date.parse(lease.expiresAt) <= nowMs) {
            return violation('PAUSED', '控制租约已过期，需重新获取控制权。', {
                expiresAt: lease.expiresAt,
            });
        }
        return { ok: true };
    }
    /**
     * 进入暂停：立刻封住输入与请求（基线 §8.1 第 1、2 步）。
     * 幂等：重复调用返回同一结果，不改状态。
     */
    beginPause(gameId, saveId, generation) {
        const lease = this.get(gameId, saveId);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation });
        }
        if (lease.generation !== generation) {
            return violation('STALE_RUNTIME', '运行代次不匹配，拒绝暂停。', {
                expected: lease.generation,
                actual: generation,
            });
        }
        if (lease.state === 'pausing' || lease.state === 'paused')
            return { ok: true };
        if (lease.state !== 'running') {
            return violation('PROTOCOL_INVALID', `状态 ${lease.state} 不能进入暂停。`, { state: lease.state });
        }
        lease.state = 'pausing';
        return { ok: true };
    }
    /**
     * 快照已持久化：确认暂停（基线 §8.1 第 4、5 步）。
     * 只有 **当前代次** 的确认才生效；旧代次的迟到确认返回 STALE_RUNTIME 且不改状态。
     */
    confirmPause(gameId, saveId, generation, revision) {
        const lease = this.get(gameId, saveId);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation });
        }
        if (lease.generation !== generation) {
            return violation('STALE_RUNTIME', '旧代次的保存确认被拒绝。', {
                expected: lease.generation,
                actual: generation,
            });
        }
        if (lease.state !== 'pausing') {
            return violation('PROTOCOL_INVALID', `状态 ${lease.state} 不接受保存确认。`, { state: lease.state });
        }
        if (!Number.isInteger(revision) || revision < 1) {
            return violation('PROTOCOL_INVALID', '保存 revision 必须是正整数。', { revision });
        }
        if (revision <= lease.lastPersistedRevision) {
            return violation('PROTOCOL_INVALID', 'revision 必须大于最近已持久化版本。', {
                revision,
                last: lease.lastPersistedRevision,
            });
        }
        lease.lastPersistedRevision = revision;
        lease.state = 'paused';
        lease.sealed = true;
        return { ok: true };
    }
    /**
     * 暂停超时/崩溃：如实进入 recovery-available，**不伪造保存成功**（基线 §8.1、验收场景「游戏不响应 pause」）。
     */
    abandonPause(gameId, saveId, generation, reason) {
        const lease = this.get(gameId, saveId);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation });
        }
        if (lease.generation !== generation) {
            return violation('STALE_RUNTIME', '旧代次不能改变暂停结果。', {
                expected: lease.generation,
                actual: generation,
            });
        }
        if (lease.state === 'paused') {
            return violation('PROTOCOL_INVALID', '已确认暂停的实例不能改判为恢复可用。', { reason });
        }
        lease.state = 'recovery-available';
        lease.sealed = true;
        return { ok: true };
    }
    /** 正常结束（Finished）。 */
    finish(gameId, saveId, generation) {
        const lease = this.get(gameId, saveId);
        if (lease === undefined) {
            return violation('STALE_RUNTIME', '没有对应运行实例。', { gameId, saveId, generation });
        }
        if (lease.generation !== generation) {
            return violation('STALE_RUNTIME', '旧代次不能结束运行。', {
                expected: lease.generation,
                actual: generation,
            });
        }
        lease.state = 'stopped';
        lease.sealed = true;
        return { ok: true };
    }
    /**
     * 显式清理过期租约（启动对账 / 定时扫描调用）。
     * 返回被清理的租约列表，供调用方写审计。**不删除**任何存档数据。
     */
    sweepExpired(nowMs) {
        const expired = [];
        for (const [key, lease] of this.bySave) {
            if (lease.sealed)
                continue;
            if (lease.state === 'running' && Date.parse(lease.expiresAt) <= nowMs) {
                lease.state = 'recovery-available';
                lease.sealed = true;
                expired.push(lease);
                continue;
            }
            // pending 且从未握手就过期的实例：直接停止，不产生"可恢复"误导。
            if (lease.state === 'pending' && Date.parse(lease.expiresAt) <= nowMs) {
                lease.state = 'stopped';
                lease.sealed = true;
                expired.push(lease);
                continue;
            }
            void key;
        }
        return expired;
    }
}
//# sourceMappingURL=lease.js.map