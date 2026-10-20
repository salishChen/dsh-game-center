/**
 * 独占锁持有子进程：用于验证「事务未取得锁」必须返回 RATE_LIMIT。
 *
 * 用法：node lock-holder.mjs <dbPath> <holdMs>
 * 行为：打开同一 DB 文件 → BEGIN IMMEDIATE 拿排他锁 → 持有 holdMs → ROLLBACK → 关闭。
 * 输出：末行 JSON {ok:true, held:true, heldMs}
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [dbPath, holdRaw] = process.argv.slice(2)
const holdMs = Number(holdRaw ?? '1200')

const db = new DatabaseSync(dbPath)
db.exec('CREATE TABLE IF NOT EXISTS _lock_probe (k TEXT PRIMARY KEY)')
db.exec('BEGIN IMMEDIATE')
// 确保排他锁真的生效：写一行占位（随后回滚，不留痕）
db.prepare('INSERT OR REPLACE INTO _lock_probe (k) VALUES (?)').run('holder')

await new Promise((resolve) => setTimeout(resolve, holdMs))

db.exec('ROLLBACK')
db.close()

console.log(JSON.stringify({ ok: true, held: true, heldMs: holdMs, pid: process.pid }))
