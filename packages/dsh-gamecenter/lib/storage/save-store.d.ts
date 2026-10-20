import type { GameSaveV1, ErrorCode } from '@dsh-gamecenter/protocol';
export { SqliteSaveBackend, type SqliteSaveBackendOptions } from './sqlite-save-backend.ts';
/**
 * 存储后端接口，可注入内存或文件系统/SQLite
 */
export interface SaveStorageBackend {
    read(key: string): Promise<string | null> | (string | null);
    write(key: string, data: string): Promise<void> | void;
    delete(key: string): Promise<void> | void;
    list(prefix: string): Promise<string[]> | string[];
}
/**
 * 内存存储后端默认实现
 */
export declare class MemorySaveBackend implements SaveStorageBackend {
    private readonly store;
    read(key: string): string | null;
    write(key: string, data: string): void;
    delete(key: string): void;
    list(prefix: string): string[];
}
/**
 * 规范化 JSON 序列化，保证相同的对象产生确定性字符串，用于计算完整性摘要
 */
export declare function canonicalJsonStringify(val: unknown): string;
/**
 * 为存档计算完整性摘要（覆盖除 integrityDigest 外的规范序列化内容）
 */
export declare function computeSaveIntegrityDigest(save: Omit<GameSaveV1, 'integrityDigest'>): string;
export interface SaveOperationFailure {
    ok: false;
    code: ErrorCode;
    message: string;
    /** 发生版本冲突时回带库内当前最高 revision */
    currentRevision?: number;
    retryable?: boolean;
}
export interface WriteCheckpointInput {
    playerId: string;
    gameId: string;
    saveId: string;
    generation: number;
    activeGeneration: number;
    isSealed: boolean;
    installedCommit: string;
    gameStateSchemaVersion: number;
    elapsedGameMs: number;
    rngState: string;
    modelBindings: GameSaveV1['modelBindings'];
    state: GameSaveV1['state'];
    assetIds?: string[];
    lastAppliedOperationIds?: string[];
    /** 幂等操作 ID（SDK/小游戏传入），用于去重重试 */
    operationId?: string;
    /** 期望的基准 revision，用于乐观冲突检测 */
    expectedRevision?: number;
}
export type WriteCheckpointResult = {
    ok: true;
    revision: number;
    save: GameSaveV1;
    /** 本次是否命中了幂等重放（同 operationId 已存且内容一致）。 */
    idempotentReplay: boolean;
} | SaveOperationFailure;
export interface ReadCheckpointOptions {
    playerId: string;
    currentSaveFormatVersion?: number;
    supportedGameStateVersions?: readonly number[];
    installedCommits?: readonly string[];
}
export type ReadCheckpointResult = {
    ok: true;
    save: GameSaveV1;
} | SaveOperationFailure;
export declare class SaveStore {
    private readonly backend;
    /**
     * 记录每个存档当前的最高 revision，用于防并发覆盖与严格单调自增。
     * 注意：revisionTracker 与 writeQueues 为进程内内存状态。
     * 跨窗口/跨进程的多实例写冲突由 Host 层的 RuntimeLease（单存档单控制者）权威锁保证，
     * 任何非持有当前活跃代次与凭证的写入在进入 Store 前即被拒绝。
     */
    private readonly revisionTracker;
    /** 存档写队列锁，确保同一个存档的并发写入串行排队执行事务 */
    private readonly writeQueues;
    constructor(backend?: SaveStorageBackend);
    /**
     * 严格校验 playerId / gameId / saveId 是否符合安全标识符规范
     * 杜绝任何形式的路径穿越（'..', '/', '\'）或键逃逸
     */
    private validateSegment;
    private saveKey;
    /**
     * 写入快照（checkpoint）
     * 必须校验：
     * 1. 租约/代次状态：sealed 实例或旧代次 (generation < activeGeneration) 一律拒绝为 STALE_RUNTIME
     * 2. revision 严格自增：新写 = 当前 + 1
     * 3. 规范化计算 integrityDigest 存盘
     */
    writeCheckpoint(input: WriteCheckpointInput): Promise<WriteCheckpointResult>;
    private doWriteCheckpoint;
    /**
     * 读取快照
     * 必须校验：
     * 1. 存档是否存在
     * 2. 完整性摘要 integrityDigest 是否匹配（防篡改）
     * 3. 若提供兼容性规则，调用 protocol 的 checkSaveCompatibility 校验跨 commit / 版本
     */
    readCheckpoint(gameId: string, saveId: string, options: ReadCheckpointOptions): Promise<ReadCheckpointResult>;
    /**
     * 获取当前已记录的 revision
     */
    getBackend(): SaveStorageBackend;
    close(): Promise<void>;
}
