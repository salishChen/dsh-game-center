/**
 * 并发竞争子进程（带锁忙有界重试）。
 *
 * 契约（PM 2026-10-19 固定口径）：
 * - 事务**未取得锁** → 宿主返回 RATE_LIMIT，调用方应**有界重试并复用原请求**（同 operationId）；
 * - 取得锁后发现版本变化 → 宿主返回 STALE_RUNTIME，**不得**重试成新写入。
 *
 * 因此本进程遇 RATE_LIMIT 会重试（同 operationId），遇 STALE_RUNTIME 立即放弃，
 * 最终输出 attempts 与 finalCode，供上层断言"恰好一个成功、另一个是版本冲突"。
 *
 * 用法：node checkpoint-racer.mjs <dbPath> <repoRoot> <expectedRevision> <operationId>
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveGameRepo } from './game-repo.mjs'

const [dbPath, repoRoot, expectedRaw, operationId] = process.argv.slice(2)
const expectedRevision = Number(expectedRaw)
const GAME_REPO = resolveGameRepo()
const COMMIT = 'e4905dbe4a738a8406b39013292d6a545ab3a356'
const GAME_ID = 'example.minesweeping'
const PLAYER_ID = 'player-A'

const MAX_ATTEMPTS = 40
const BACKOFF_MS = 25

const storeMod = await import(
  pathToFileURL(path.join(repoRoot, 'packages/dsh-gamecenter/staging/storage/save-store.js')).href
)

const backend = new storeMod.SqliteSaveBackend({ dbPath })
const store = new storeMod.SaveStore(backend)

let write = null
let attempts = 0
for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
  attempts += 1
  write = await store.writeCheckpoint({
    playerId: PLAYER_ID,
    gameId: GAME_ID,
    saveId: 'save-cross',
    operationId,
    expectedRevision,
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'ff',
    modelBindings: {},
    state: { racer: operationId, expectedRevision },
  })
  if (write.ok) break
  // 只有锁忙才重试；版本冲突立即放弃
  if (write.code !== 'RATE_LIMIT') break
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS))
}

void GAME_REPO

console.log(
  JSON.stringify({
    operationId,
    ok: Boolean(write && write.ok),
    revision: write && write.ok ? write.revision : null,
    finalCode: write && write.ok ? null : (write?.code ?? null),
    idempotentReplay: write && write.ok ? Boolean(write.idempotentReplay) : false,
    attempts,
    hasCurrentRevision: write && !write.ok ? Object.hasOwn(write, 'currentRevision') : null,
  }),
)
