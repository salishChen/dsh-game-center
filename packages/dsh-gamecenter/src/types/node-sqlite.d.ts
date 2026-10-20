/**
 * `node:sqlite` 的最小环境声明（Node 24 原生同步 SQLite 模块）
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean })
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
