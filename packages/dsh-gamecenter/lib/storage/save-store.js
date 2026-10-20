import { createHash } from 'node:crypto';
import { checkSaveCompatibility } from '@dsh-gamecenter/protocol';
export { SqliteSaveBackend } from "./sqlite-save-backend.js";
/**
 * 内存存储后端默认实现
 */
export class MemorySaveBackend {
    store = new Map();
    read(key) {
        return this.store.get(key) ?? null;
    }
    write(key, data) {
        this.store.set(key, data);
    }
    delete(key) {
        this.store.delete(key);
    }
    list(prefix) {
        const keys = [];
        for (const k of this.store.keys()) {
            if (k.startsWith(prefix))
                keys.push(k);
        }
        return keys;
    }
}
/**
 * 规范化 JSON 序列化，保证相同的对象产生确定性字符串，用于计算完整性摘要
 */
export function canonicalJsonStringify(val) {
    if (val === null || typeof val !== 'object') {
        return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
        return `[${val.map((item) => canonicalJsonStringify(item)).join(',')}]`;
    }
    const obj = val;
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
    return `{${pairs.join(',')}}`;
}
/**
 * 为存档计算完整性摘要（覆盖除 integrityDigest 外的规范序列化内容）
 */
export function computeSaveIntegrityDigest(save) {
    const canonical = canonicalJsonStringify(save);
    const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return `sha256:${hex}`;
}
export class SaveStore {
    backend;
    /**
     * 记录每个存档当前的最高 revision，用于防并发覆盖与严格单调自增。
     * 注意：revisionTracker 与 writeQueues 为进程内内存状态。
     * 跨窗口/跨进程的多实例写冲突由 Host 层的 RuntimeLease（单存档单控制者）权威锁保证，
     * 任何非持有当前活跃代次与凭证的写入在进入 Store 前即被拒绝。
     */
    revisionTracker = new Map();
    /** 存档写队列锁，确保同一个存档的并发写入串行排队执行事务 */
    writeQueues = new Map();
    constructor(backend = new MemorySaveBackend()) {
        this.backend = backend;
    }
    /**
     * 严格校验 playerId / gameId / saveId 是否符合安全标识符规范
     * 杜绝任何形式的路径穿越（'..', '/', '\'）或键逃逸
     */
    validateSegment(name, value) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: `缺少必要标识符: ${name} 必须为非空字符串。`,
            };
        }
        const trimmed = value.trim();
        // 只允许字母、数字、点号、短横线、下划线、冒号，严禁包含路径分隔符与 '..' 穿越段
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: `非法标识符: ${name} 包含非法字符或路径穿越段 ('${trimmed}')。`,
            };
        }
        return { ok: true, value: trimmed };
    }
    saveKey(playerId, gameId, saveId) {
        return `saves/${playerId}/${gameId}/${saveId}.json`;
    }
    /**
     * 写入快照（checkpoint）
     * 必须校验：
     * 1. 租约/代次状态：sealed 实例或旧代次 (generation < activeGeneration) 一律拒绝为 STALE_RUNTIME
     * 2. revision 严格自增：新写 = 当前 + 1
     * 3. 规范化计算 integrityDigest 存盘
     */
    async writeCheckpoint(input) {
        // 强制宿主可信身份必填：缺 playerId 坚决拒绝（PROTOCOL_INVALID），杜绝公共路径与自动兜底
        const playerCheck = this.validateSegment('playerId', input.playerId);
        if (!playerCheck.ok)
            return playerCheck;
        const gameCheck = this.validateSegment('gameId', input.gameId);
        if (!gameCheck.ok)
            return gameCheck;
        const saveCheck = this.validateSegment('saveId', input.saveId);
        if (!saveCheck.ok)
            return saveCheck;
        const key = this.saveKey(playerCheck.value, gameCheck.value, saveCheck.value);
        // 若后端支持原生原子事务（如 SqliteSaveBackend），直接走 BEGIN IMMEDIATE 原生隔离事务
        const backendWithAtomic = this.backend;
        if (typeof backendWithAtomic.atomicCheckpointTransaction === 'function') {
            const res = backendWithAtomic.atomicCheckpointTransaction(key, input);
            if (res.ok) {
                this.revisionTracker.set(key, res.revision);
            }
            return res;
        }
        const prevQueue = this.writeQueues.get(key) ?? Promise.resolve();
        const currentTask = (async () => {
            await prevQueue.catch(() => { });
            return this.doWriteCheckpoint(input, key);
        })();
        this.writeQueues.set(key, currentTask);
        try {
            return await currentTask;
        }
        finally {
            if (this.writeQueues.get(key) === currentTask) {
                this.writeQueues.delete(key);
            }
        }
    }
    async doWriteCheckpoint(input, key) {
        const { gameId, saveId, generation, activeGeneration, isSealed } = input;
        // 1. 代次与封存状态校验
        if (isSealed || generation < activeGeneration) {
            return {
                ok: false,
                code: 'STALE_RUNTIME',
                message: '当前运行实例已封存或运行代次已陈旧，拒绝写入存档。',
            };
        }
        // 2. 从持久存储与内存 tracker 双向对账当前最高 revision，防止跨进程重启后计数回退到 1
        let currentRev = this.revisionTracker.get(key);
        if (currentRev === undefined) {
            const existingRaw = await this.backend.read(key);
            if (existingRaw) {
                try {
                    const parsed = JSON.parse(existingRaw);
                    if (typeof parsed.revision === 'number' && Number.isInteger(parsed.revision)) {
                        currentRev = parsed.revision;
                    }
                }
                catch {
                    // 非法 JSON 留待 readCheckpoint 校验，此处 fallback 为 0
                }
            }
            currentRev = currentRev ?? 0;
        }
        const nextRev = currentRev + 1;
        const saveWithoutDigest = {
            saveFormatVersion: 1,
            gameStateSchemaVersion: input.gameStateSchemaVersion,
            gameId,
            saveId,
            installedCommit: input.installedCommit,
            revision: nextRev,
            status: 'paused',
            elapsedGameMs: input.elapsedGameMs,
            rngState: input.rngState,
            modelBindings: input.modelBindings ?? {},
            state: input.state,
            assetIds: input.assetIds ?? [],
            lastAppliedOperationIds: input.lastAppliedOperationIds ?? [],
        };
        const digest = computeSaveIntegrityDigest(saveWithoutDigest);
        const fullSave = {
            ...saveWithoutDigest,
            integrityDigest: digest,
        };
        await this.backend.write(key, JSON.stringify(fullSave));
        this.revisionTracker.set(key, nextRev);
        return {
            ok: true,
            revision: nextRev,
            save: fullSave,
            idempotentReplay: false,
        };
    }
    /**
     * 读取快照
     * 必须校验：
     * 1. 存档是否存在
     * 2. 完整性摘要 integrityDigest 是否匹配（防篡改）
     * 3. 若提供兼容性规则，调用 protocol 的 checkSaveCompatibility 校验跨 commit / 版本
     */
    async readCheckpoint(gameId, saveId, options) {
        // 强制宿主身份必填：读档严禁缺 playerId，未注入一律拒绝为 PROTOCOL_INVALID
        const playerCheck = this.validateSegment('playerId', options?.playerId);
        if (!playerCheck.ok)
            return playerCheck;
        const gameCheck = this.validateSegment('gameId', gameId);
        if (!gameCheck.ok)
            return gameCheck;
        const saveCheck = this.validateSegment('saveId', saveId);
        if (!saveCheck.ok)
            return saveCheck;
        const key = this.saveKey(playerCheck.value, gameCheck.value, saveCheck.value);
        const raw = await this.backend.read(key);
        if (!raw) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: `未找到存档文件: ${key}`,
            };
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: '存档内容损坏，非合法 JSON。',
            };
        }
        // 校验完整性摘要
        const { integrityDigest, ...rest } = parsed;
        if (!integrityDigest) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: '存档缺失完整性校验码 integrityDigest。',
            };
        }
        const expectedDigest = computeSaveIntegrityDigest(rest);
        if (integrityDigest !== expectedDigest) {
            return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: `存档完整性校验失败，可能已被外部篡改 (got ${integrityDigest}, expected ${expectedDigest})。`,
            };
        }
        // 校验版本兼容性
        if (options) {
            const currentSaveFormatVersion = options.currentSaveFormatVersion ?? 1;
            const supportedGameStateVersions = options.supportedGameStateVersions ?? [parsed.gameStateSchemaVersion];
            const installedCommits = options.installedCommits ?? [parsed.installedCommit];
            const compat = checkSaveCompatibility({
                save: parsed,
                currentSaveFormatVersion,
                supportedGameStateVersions,
                installedCommits,
            });
            if (!compat.compatible) {
                return {
                    ok: false,
                    code: 'SAVE_INCOMPATIBLE',
                    message: `存档与当前环境不兼容: ${compat.reason} (${compat.detail})`,
                };
            }
        }
        return {
            ok: true,
            save: parsed,
        };
    }
    /**
     * 获取当前已记录的 revision
     */
    getBackend() {
        return this.backend;
    }
    async close() {
        const backend = this.backend;
        if (typeof backend.close === 'function') {
            backend.close();
        }
    }
}
//# sourceMappingURL=save-store.js.map