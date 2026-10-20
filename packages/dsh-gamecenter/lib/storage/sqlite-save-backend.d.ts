import type { SaveStorageBackend, WriteCheckpointInput, WriteCheckpointResult } from './save-store.ts';
export interface SqliteSaveBackendOptions {
    /** SQLite 数据库文件绝对路径，默认 ':memory:' */
    dbPath?: string;
}
export interface SaveRow {
    key: string;
    game_id: string;
    save_id: string;
    revision: number;
    data: string;
    updated_at: number;
}
export interface OpRow {
    idempotency_key: string;
    revision: number;
    state_digest: string;
}
/**
 * 真实 SQLite 持久存储后端（基于 Node 24 原生 node:sqlite）
 * 建立 kv 表与操作审计表，并利用 BEGIN IMMEDIATE 保证原子事务与并发互斥。
 */
export declare class SqliteSaveBackend implements SaveStorageBackend {
    private readonly dbPath;
    private readonly isMemory;
    private readonly options;
    private memoryDb;
    constructor(options?: SqliteSaveBackendOptions);
    private open;
    private withDb;
    private init;
    read(key: string): string | null;
    write(key: string, data: string): void;
    delete(key: string): void;
    list(prefix: string): string[];
    /**
     * 核心原子检查点事务：在同一连接内执行 BEGIN IMMEDIATE
     * 1. 排他锁连接，防止多进程并发冲突；
     * 2. 读取并校验库中当前存档与 revision；
     * 3. 幂等检查：若提供了 operationId，检查是否已有相同 idempotencyKey；
     *    - 若已有记录且 stateDigest 一致 -> 幂等重放，返回已存 revision 与 save；
     *    - 若已有记录但 stateDigest 不一致 -> 拒绝为 PROTOCOL_INVALID（同 op 内容篡改）；
     * 4. expectedRevision 冲突检查：若提供了 expectedRevision 且与库内最新 revision 不一致 -> 拒绝为 STALE_RUNTIME；
     * 5. revision 严格单调自增（nextRev = currentRev + 1）；
     * 6. 写入 gamecenter_saves 与 gamecenter_operations 并 COMMIT；失败则自动 ROLLBACK。
     */
    atomicCheckpointTransaction(key: string, input: WriteCheckpointInput): WriteCheckpointResult;
    close(): void;
}
