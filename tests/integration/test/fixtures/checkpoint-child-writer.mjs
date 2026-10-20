/**
 * 独立子进程 A：写入检查点后退出。
 *
 * 由 p6-integration 用 child_process 派生，用来证明"进程退出后仍能从磁盘恢复"，
 * 而不是同进程里 new 一个 Store 冒充跨进程。
 *
 * 用法：node checkpoint-child-writer.mjs <dbPath> <repoRoot> <revisionTimes>
 * 输出：末行 JSON {ok, revision, elapsedGameMs, rngState, boardHash}
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveGameRepo } from './game-repo.mjs'

const [dbPath, repoRoot, timesRaw] = process.argv.slice(2)
const times = Number(timesRaw ?? '3')
const GAME_REPO = resolveGameRepo()
const COMMIT = 'e4905dbe4a738a8406b39013292d6a545ab3a356'
const GAME_ID = 'example.minesweeping'
const PLAYER_ID = 'player-A'

const storeMod = await import(
  pathToFileURL(path.join(repoRoot, 'packages/dsh-gamecenter/staging/storage/save-store.js')).href
)
const engineMod = await import(pathToFileURL(path.join(GAME_REPO, 'src', 'engine.js')).href)

const backend = new storeMod.SqliteSaveBackend({ dbPath })
const store = new storeMod.SaveStore(backend)
const engine = new engineMod.MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 20261019 })
engine.reveal(4, 4)
engine.reveal(2, 2)
engine.tick(1234)

let last = null
let expectedRevision = 0
for (let i = 0; i < times; i += 1) {
  const write = await store.writeCheckpoint({
    playerId: PLAYER_ID,    gameId: GAME_ID,
    saveId: 'save-cross',
    operationId: `child-op-${i + 1}`,
    expectedRevision,
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: engine.elapsedMs,
    rngState: engine.rng.getState(),
    modelBindings: {},
    state: engine.serialize(),
  })
  if (!write.ok) {
    console.log(JSON.stringify({ ok: false, code: write.code, message: write.message }))
    process.exit(1)
  }
  expectedRevision = write.revision
  last = write
}

console.log(
  JSON.stringify({
    ok: true,
    pid: process.pid,
    revision: last.revision,
    elapsedGameMs: engine.elapsedMs,
    rngState: engine.rng.getState(),
    state: engine.serialize(),
  }),
)
