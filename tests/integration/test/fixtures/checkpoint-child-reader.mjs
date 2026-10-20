/**
 * 独立子进程 B：重开同一 SQLite 文件，恢复并继续写入。
 *
 * 由 p6-integration 派生，证明"进程 A 退出后，进程 B 仍能恢复同进度并接着递增 revision"。
 *
 * 用法：node checkpoint-child-reader.mjs <dbPath> <repoRoot>
 * 输出：末行 JSON {ok, revision, elapsedGameMs, rngState, state, continuedRevision}
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveGameRepo } from './game-repo.mjs'

const [dbPath, repoRoot] = process.argv.slice(2)
const GAME_REPO = resolveGameRepo()
const GAME_ID = 'example.minesweeping'
const PLAYER_ID = 'player-A'

const storeMod = await import(
  pathToFileURL(path.join(repoRoot, 'packages/dsh-gamecenter/staging/storage/save-store.js')).href
)
const engineMod = await import(pathToFileURL(path.join(GAME_REPO, 'src', 'engine.js')).href)

const backend = new storeMod.SqliteSaveBackend({ dbPath })
const store = new storeMod.SaveStore(backend)

const read = await store.readCheckpoint(GAME_ID, 'save-cross', {
  playerId: PLAYER_ID,
  currentSaveFormatVersion: 1,
  supportedGameStateVersions: [1],
  installedCommits: ['e4905dbe4a738a8406b39013292d6a545ab3a356'],
})
if (!read.ok) {
  console.log(JSON.stringify({ ok: false, code: read.code, message: read.message }))
  process.exit(1)
}

// 用存档重建引擎，验证状态可完全还原
const engine = new engineMod.MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 20261019 })
engine.restore(read.save.state)
const restored = engine.serialize()

// 继续保存：revision 必须接着库内值递增
const write = await store.writeCheckpoint({
  playerId: PLAYER_ID,  gameId: GAME_ID,
  saveId: 'save-cross',
  operationId: 'reader-op-1',
  expectedRevision: read.save.revision,
  generation: 1,
  activeGeneration: 1,
  isSealed: false,
  installedCommit: 'e4905dbe4a738a8406b39013292d6a545ab3a356',
  gameStateSchemaVersion: 1,
  elapsedGameMs: read.save.elapsedGameMs,
  rngState: read.save.rngState,
  modelBindings: {},
  state: restored,
})

console.log(
  JSON.stringify({
    ok: true,
    readRevision: read.save.revision,
    elapsedGameMs: read.save.elapsedGameMs,
    rngState: read.save.rngState,
    state: restored,
    continuedOk: write.ok,
    continuedRevision: write.ok ? write.revision : null,
  }),
)
