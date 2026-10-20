import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { GameSaveV1 } from '@dsh-gamecenter/protocol'
import { canonicalCheckpointContent, checkpointIdempotencyKey } from '@dsh-gamecenter/protocol'
import type { SaveStorageBackend, WriteCheckpointInput, WriteCheckpointResult, SaveOperationFailure } from './save-store.ts'
import { computeSaveIntegrityDigest } from './save-store.ts'

export interface SqliteSaveBackendOptions {
  /** SQLite 数据库文件绝对路径，默认 ':memory:' */
  dbPath?: string
}

export interface SaveRow {
  key: string
  game_id: string
  save_id: string
  revision: number
  data: string
  updated_at: number
}

export interface OpRow {
  idempotency_key: string
  revision: number
  state_digest: string
}

/**
 * 真实 SQLite 持久存储后端（基于 Node 24 原生 node:sqlite）
 * 建立 kv 表与操作审计表，并利用 BEGIN IMMEDIATE 保证原子事务与并发互斥。
 */
export class SqliteSaveBackend implements SaveStorageBackend {
  private readonly dbPath: string
  private readonly isMemory: boolean
  private readonly options: SqliteSaveBackendOptions
  private memoryDb: DatabaseSync | null = null

  constructor(options: SqliteSaveBackendOptions = {}) {
    this.options = options
    this.dbPath = options.dbPath ?? ':memory:'
    this.isMemory = this.dbPath === ':memory:'
    this.init()
  }

  private open(): DatabaseSync {
    if (this.isMemory) {
      if (!this.memoryDb) {
        this.memoryDb = new DatabaseSync(':memory:')
      }
      return this.memoryDb
    }
    return new DatabaseSync(this.dbPath)
  }

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    if (this.isMemory) {
      return fn(this.open())
    }
    const db = new DatabaseSync(this.dbPath)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  private init(): void {
    // 带有限重试（最多 10 次，每次退避 50ms）的健壮初始化建表，确保并发启动时建表绝对成功，严禁在未建表状态下静默继续
    const maxRetries = 10
    const retryDelayMs = 50
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.withDb((db) => {
          db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS gamecenter_saves (
              key TEXT PRIMARY KEY,
              game_id TEXT NOT NULL,
              save_id TEXT NOT NULL,
              revision INTEGER NOT NULL,
              data TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS gamecenter_operations (
              idempotency_key TEXT PRIMARY KEY,
              game_id TEXT NOT NULL,
              save_id TEXT NOT NULL,
              operation_id TEXT NOT NULL,
              revision INTEGER NOT NULL,
              state_digest TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
          `)
        })
        return
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        const isLock = msg.includes('database is locked') || msg.includes('busy')
        if (isLock && attempt < maxRetries - 1) {
          // 在同步执行模型中使用原子阻塞等待锁释放
          const start = Date.now()
          while (Date.now() - start < retryDelayMs) {
            // busy-wait 短暂退避
          }
          continue
        }
        // 超过重试上限或非锁异常，显式抛错中断，绝不静默放行
        throw new Error(`SqliteSaveBackend 初始化建表失败（重试 ${attempt + 1}/${maxRetries} 次）: ${msg}`)
      }
    }
  }

  read(key: string): string | null {
    return this.withDb((db) => {
      const stmt = db.prepare('SELECT data FROM gamecenter_saves WHERE key = ?')
      const row = stmt.get(key) as { data: string } | undefined
      return row ? row.data : null
    })
  }

  write(key: string, data: string): void {
    this.withDb((db) => {
      const stmt = db.prepare(`
        INSERT INTO gamecenter_saves (key, game_id, save_id, revision, data, updated_at)
        VALUES (?, '', '', 0, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          data = excluded.data,
          updated_at = excluded.updated_at
      `)
      stmt.run(key, data, Date.now())
    })
  }

  delete(key: string): void {
    this.withDb((db) => {
      const stmt = db.prepare('DELETE FROM gamecenter_saves WHERE key = ?')
      stmt.run(key)
    })
  }

  list(prefix: string): string[] {
    return this.withDb((db) => {
      const stmt = db.prepare('SELECT key FROM gamecenter_saves WHERE key LIKE ? ORDER BY key ASC')
      const rows = stmt.all(`${prefix}%`) as Array<{ key: string }>
      return rows.map((r) => r.key)
    })
  }

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
  atomicCheckpointTransaction(
    key: string,
    input: WriteCheckpointInput,
  ): WriteCheckpointResult {
    return this.withDb((db) => {
      // 捕获 BEGIN IMMEDIATE 时的锁冲突（如另一个进程正持有锁）：明确返回 RATE_LIMIT（瞬态锁争用），不混淆为 STALE_RUNTIME 版本冲突
      try {
        db.exec('BEGIN IMMEDIATE')
      } catch (lockErr: unknown) {
        const msg = lockErr instanceof Error ? lockErr.message : String(lockErr)
        if (msg.includes('database is locked') || msg.includes('busy')) {
          return {
            ok: false,
            code: 'RATE_LIMIT',
            message: '并发保存锁争用：数据库正被另一个进程排他事务锁定，请稍后重试。',
          }
        }
        return {
          ok: false,
          code: 'INTERNAL',
          message: `无法开启排他事务: ${msg}`,
        }
      }
      try {
        const { gameId, saveId, generation, activeGeneration, isSealed, operationId, expectedRevision } = input

        // 1. 代次与封存状态校验
        if (isSealed || generation < activeGeneration) {
          db.exec('ROLLBACK')
          return {
            ok: false,
            code: 'STALE_RUNTIME',
            message: '当前运行实例已封存或运行代次已陈旧，拒绝写入存档。',
          }
        }

        // 2. 读取当前存档
        const saveStmt = db.prepare('SELECT data, revision FROM gamecenter_saves WHERE key = ?')
        const existingRow = saveStmt.get(key) as { data: string; revision: number } | undefined

        let currentRev = 0
        if (existingRow) {
          currentRev = existingRow.revision
        }

        if (typeof input.playerId !== 'string' || input.playerId.trim().length === 0) {
          db.exec('ROLLBACK')
          return {
            ok: false,
            code: 'PROTOCOL_INVALID',
            message: '缺少必要标识符: playerId 必须为非空字符串。',
          }
        }
        const playerId = input.playerId.trim()

        // 3. 幂等查重（使用 protocol 权威的四段组合键与规范内容摘要）
        if (operationId) {
          const idempKey = checkpointIdempotencyKey({ playerId, gameId, saveId, operationId })
          const opStmt = db.prepare('SELECT revision, state_digest FROM gamecenter_operations WHERE idempotency_key = ?')
          const existingOp = opStmt.get(idempKey) as OpRow | undefined
          if (existingOp) {
            // 用 protocol 权威函数计算覆盖全部存档语义字段的规范摘要
            const contentCanonical = canonicalCheckpointContent({
              state: input.state,
              elapsedGameMs: input.elapsedGameMs,
              rngState: input.rngState,
              gameStateSchemaVersion: input.gameStateSchemaVersion,
              installedCommit: input.installedCommit,
            })
            const currentDigest = `sha256:${createHash('sha256').update(contentCanonical, 'utf8').digest('hex')}`

            if (existingOp.state_digest !== currentDigest) {
              db.exec('ROLLBACK')
              return {
                ok: false,
                code: 'PROTOCOL_INVALID',
                message: `重复的 operationId (${operationId}) 但状态内容不一致，拒绝覆盖。`,
              }
            }

            // 内容一致 -> 幂等成功返回既有存档
            const parsedSave = JSON.parse(existingRow!.data) as GameSaveV1
            db.exec('COMMIT')
            return {
              ok: true,
              revision: existingOp.revision,
              save: parsedSave,
              idempotentReplay: true,
            }
          }
        }

        // 4. expectedRevision 冲突检查
        if (typeof expectedRevision === 'number' && expectedRevision !== currentRev) {
          db.exec('ROLLBACK')
          return {
            ok: false,
            code: 'STALE_RUNTIME',
            message: `存档版本冲突：期望基准 revision=${expectedRevision}，但当前库内最新为 revision=${currentRev}。`,
            currentRevision: currentRev,
            retryable: false,
          }
        }

        // 5. 新 revision 推进
        const nextRev = currentRev + 1

        const opList = input.lastAppliedOperationIds ? [...input.lastAppliedOperationIds] : []
        if (operationId && !opList.includes(operationId)) {
          opList.push(operationId)
        }

        const saveWithoutDigest: Omit<GameSaveV1, 'integrityDigest'> = {
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
          lastAppliedOperationIds: opList,
        }

        const digest = computeSaveIntegrityDigest(saveWithoutDigest)
        const fullSave: GameSaveV1 = {
          ...saveWithoutDigest,
          integrityDigest: digest,
        }

        // 6. 存盘与记录 operationId
        const upsertSave = db.prepare(`
          INSERT INTO gamecenter_saves (key, game_id, save_id, revision, data, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            revision = excluded.revision,
            data = excluded.data,
            updated_at = excluded.updated_at
        `)
        upsertSave.run(key, gameId, saveId, nextRev, JSON.stringify(fullSave), Date.now())

        if (operationId) {
          const idempKey = checkpointIdempotencyKey({ playerId, gameId, saveId, operationId })
          const contentCanonical = canonicalCheckpointContent({
            state: input.state,
            elapsedGameMs: input.elapsedGameMs,
            rngState: input.rngState,
            gameStateSchemaVersion: input.gameStateSchemaVersion,
            installedCommit: input.installedCommit,
          })
          const contentDigest = `sha256:${createHash('sha256').update(contentCanonical, 'utf8').digest('hex')}`

          const insertOp = db.prepare(`
            INSERT INTO gamecenter_operations (idempotency_key, game_id, save_id, operation_id, revision, state_digest, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          insertOp.run(idempKey, gameId, saveId, operationId, nextRev, contentDigest, Date.now())
        }

        db.exec('COMMIT')
        return {
          ok: true,
          revision: nextRev,
          save: fullSave,
          idempotentReplay: false,
        }
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        return {
          ok: false,
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  close(): void {
    if (this.memoryDb) {
      this.memoryDb.close()
      this.memoryDb = null
    }
  }
}
