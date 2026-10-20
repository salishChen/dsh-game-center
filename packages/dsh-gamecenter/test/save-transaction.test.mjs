import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SaveStore,
  MemorySaveBackend,
  SqliteSaveBackend,
  computeSaveIntegrityDigest,
  canonicalJsonStringify,
} from '../staging/storage/save-store.js'

test('canonicalJsonStringify: 閿帓搴忎笌纭畾鎬у簭鍒楀寲', () => {
  const obj1 = { b: 2, a: 1, c: { y: 'hello', x: [1, 2] } }
  const obj2 = { a: 1, c: { x: [1, 2], y: 'hello' }, b: 2 }
  assert.equal(canonicalJsonStringify(obj1), canonicalJsonStringify(obj2))
})

test('姝ｅ父鍐欏叆蹇収骞惰鍙栵紝revision 閫掑锛屽畬鏁存€ф牎楠岄€氳繃', async () => {
  const store = new SaveStore()

  const writeResult = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-1',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-a1b2c3',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 15400,
    rngState: 'rng-seed-12345',
    modelBindings: { default: { providerId: 'neuapi', modelId: 'deepseek-v4.1-flash' } },
    state: { grid: [[0, 1], [1, 0]], status: 'playing' },
    assetIds: ['board-theme-1'],
    lastAppliedOperationIds: ['op-101'],
  })

  assert.equal(writeResult.ok, true)
  assert.equal(writeResult.revision, 1)
  assert.match(writeResult.save.integrityDigest, /^sha256:[0-9a-f]{64}$/)

  // 鍐嶆鍐欏叆鍚屼竴涓?saveId锛宺evision 涓ユ牸鍗曡皟閫掑
  const secondWrite = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-1',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-a1b2c3',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 20000,
    rngState: 'rng-seed-67890',
    modelBindings: {},
    state: { grid: [[0, 1], [1, 0]], status: 'won' },
  })

  assert.equal(secondWrite.ok, true)
  assert.equal(secondWrite.revision, 2)

  // 正常读取，验证数据一致性
  const readResult = await store.readCheckpoint('minesweeper', 'save-1', { playerId: 'test-player' })
  assert.equal(readResult.ok, true)
  assert.equal(readResult.save.revision, 2)
  assert.equal(readResult.save.status, 'paused')
  assert.equal(readResult.save.elapsedGameMs, 20000)
  assert.equal(readResult.save.rngState, 'rng-seed-67890')
})

test('旧代次写入被拒绝为 STALE_RUNTIME', async () => {
  const store = new SaveStore()

  // 妯℃嫙褰撳墠娲昏穬浠ｆ涓?2锛屼絾璋冪敤鏂逛紶鍏?generation 1
  const staleWrite = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-1',
    generation: 1,
    activeGeneration: 2,
    isSealed: false,
    installedCommit: 'commit-a1b2c3',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 5000,
    rngState: 'rng-seed',
    modelBindings: {},
    state: {},
  })

  assert.equal(staleWrite.ok, false)
  assert.equal(staleWrite.code, 'STALE_RUNTIME')
})

test('宸插皝瀛橈紙sealed锛夊疄渚嬪啓鍏ヨ鎷掔粷涓?STALE_RUNTIME', async () => {
  const store = new SaveStore()

  const sealedWrite = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-1',
    generation: 1,
    activeGeneration: 1,
    isSealed: true,
    installedCommit: 'commit-a1b2c3',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 5000,
    rngState: 'rng-seed',
    modelBindings: {},
    state: {},
  })

  assert.equal(sealedWrite.ok, false)
  assert.equal(sealedWrite.code, 'STALE_RUNTIME')
})

test('瀛樻。闃茬鏀癸細绡℃敼 state 鍚?integrityDigest 鏍￠獙澶辫触', async () => {
  const backend = new MemorySaveBackend()
  const store = new SaveStore(backend)

  const writeResult = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-tamper',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-a1b2c3',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 1000,
    rngState: 'rng-seed',
    modelBindings: {},
    state: { score: 10 },
  })

  assert.equal(writeResult.ok, true)

  // 澶栭儴鐩存帴鎭舵剰绡℃敼 backend 鍐呭
  const key = 'saves/test-player/minesweeper/save-tamper.json'
  const raw = backend.read(key)
  assert.ok(raw)
  const tampered = JSON.parse(raw)
  tampered.state.score = 99999 // 绡℃敼鍒嗘暟浣嗘湭鏀?digest
  backend.write(key, JSON.stringify(tampered))

  // 读取时必须捕获篡改
  const readResult = await store.readCheckpoint('minesweeper', 'save-tamper', { playerId: 'test-player' })
  assert.equal(readResult.ok, false)
  assert.equal(readResult.code, 'PROTOCOL_INVALID')
  assert.match(readResult.message, /完整性校验失败/)
})

test('璺?commit / 璺ㄧ増鏈吋瀹规€ф牎楠岋細涓嶅吋瀹硅繑鍥?SAVE_INCOMPATIBLE', async () => {
  const store = new SaveStore()

  await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-compat',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-original',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 12000,
    rngState: 'seed',
    modelBindings: {},
    state: {},
  })

  // 1. 同 commit 兼容
  const compatRead = await store.readCheckpoint('minesweeper', 'save-compat', {
    playerId: 'test-player',
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1, 2],
    installedCommits: ['commit-original', 'commit-new'],
  })
  assert.equal(compatRead.ok, true)

  // 2. 存档对应的 commit 未被安装
  const inCompatCommit = await store.readCheckpoint('minesweeper', 'save-compat', {
    playerId: 'test-player',
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1, 2],
    installedCommits: ['commit-only-new'],
  })
  assert.equal(inCompatCommit.ok, false)
  assert.equal(inCompatCommit.code, 'SAVE_INCOMPATIBLE')
  assert.match(inCompatCommit.message, /unknown-game-version/)

  // 3. 游戏状态主版本不被支持
  const inCompatSchema = await store.readCheckpoint('minesweeper', 'save-compat', {
    playerId: 'test-player',
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [2, 3],
    installedCommits: ['commit-original'],
  })
  assert.equal(inCompatSchema.ok, false)
  assert.equal(inCompatSchema.code, 'SAVE_INCOMPATIBLE')
  assert.match(inCompatSchema.message, /game-state-major-unsupported/)
})

test('并发写保护：多个快照请求按序推进 revision 不覆盖', async () => {
  const store = new SaveStore()

  const p1 = store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-race',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'seed-1',
    modelBindings: {},
    state: { step: 1 },
  })

  const p2 = store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-race',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 200,
    rngState: 'seed-2',
    modelBindings: {},
    state: { step: 2 },
  })

  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.notEqual(r1.revision, r2.revision)
  assert.equal(Math.max(r1.revision, r2.revision), 2)
})

test('璺ㄥ疄渚?杩涚▼閲嶅缓鍚庯紝SaveStore 浠庡凡鏈夋寔涔呭瓨妗ｆ纭璐︽渶楂?revision', async () => {
  const backend = new MemorySaveBackend()

  // 瀹炰緥 1 鍐欏叆 revision=1, revision=2
  const store1 = new SaveStore(backend)
  const w1 = await store1.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-restart',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'seed-1',
    modelBindings: {},
    state: {},
  })
  assert.equal(w1.revision, 1)

  const w2 = await store1.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-restart',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 200,
    rngState: 'seed-2',
    modelBindings: {},
    state: {},
  })
  assert.equal(w2.revision, 2)

  // 妯℃嫙瀹炰緥閿€姣佸苟鍏ㄦ柊鍚姩瀹炰緥 2锛堝叾鍐呭瓨 revisionTracker 涓虹┖锛夛紝鎸囧悜鍚屼竴鎸佷箙 backend
  const store2 = new SaveStore(backend)
  const w3 = await store2.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-restart',
    generation: 2,
    activeGeneration: 2,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 300,
    rngState: 'seed-3',
    modelBindings: {},
    state: {},
  })

  // 蹇呴』瀵硅处鍒板凡鏈?revision=2锛屽苟鎺ㄨ繘鑷?3锛岀粷涓嶈兘鍥為€€鍒?1
  assert.equal(w3.ok, true)
  assert.equal(w3.revision, 3)
})

test('SqliteSaveBackend 原子事务：operationId 幂等重放与内容篡改拒绝', async () => {
  const sqlite = new SqliteSaveBackend({ dbPath: ':memory:' })
  const store = new SaveStore(sqlite)

  // 1. 鍒濇鎻愪氦 operation-001
  const w1 = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-idemp',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 1000,
    rngState: 'rng-1',
    modelBindings: {},
    state: { step: 1 },
    operationId: 'op-001',
    expectedRevision: 0,
  })
  assert.equal(w1.ok, true)
  assert.equal(w1.revision, 1)
  assert.equal(w1.idempotentReplay, false, '鍒濇鍐欏叆 idempotentReplay 蹇呴』涓?false')

  // 2. 鐩稿悓 operationId + 鐩稿悓鍐呭閲嶆斁 -> 骞傜瓑杩斿洖 revision=1锛屼笖 idempotentReplay=true
  const w2 = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-idemp',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 1000,
    rngState: 'rng-1',
    modelBindings: {},
    state: { step: 1 },
    operationId: 'op-001',
    expectedRevision: 0,
  })
  assert.equal(w2.ok, true)
  assert.equal(w2.revision, 1, '骞傜瓑閲嶆斁蹇呴』杩斿洖鍘?revision锛屼弗绂佽嚜澧烇紒')
  assert.equal(w2.idempotentReplay, true, '骞傜瓑閲嶆斁鏃?idempotentReplay 蹇呴』涓?true')

  // 3. 鐩稿悓 operationId + 涓嶅悓鍐呭 -> 鎷掔粷涓?PROTOCOL_INVALID
  const w3 = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-idemp',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 2000, // 鍙樺姩
    rngState: 'rng-changed',
    modelBindings: {},
    state: { step: 1 },
    operationId: 'op-001',
  })
  assert.equal(w3.ok, false)
  assert.equal(w3.code, 'PROTOCOL_INVALID')
  assert.match(w3.message, /状态内容不一致/)
})

test('SqliteSaveBackend 乐观版本冲突：expectedRevision 不匹配拒绝为 STALE_RUNTIME', async () => {
  const sqlite = new SqliteSaveBackend({ dbPath: ':memory:' })
  const store = new SaveStore(sqlite)

  // 褰撳墠搴撳唴涓虹┖锛屾湡鏈?revision=1 蹇呯劧鍐茬獊
  const w1 = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-conflict',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'rng',
    modelBindings: {},
    state: {},
    expectedRevision: 1, // 搴撳唴姝ゆ椂涓?0
  })
  assert.equal(w1.ok, false)
  assert.equal(w1.code, 'STALE_RUNTIME')
  assert.match(w1.message, /存档版本冲突/)
})

test('SqliteSaveBackend 真实子进程并发竞争与独立进程崩溃恢复', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proc-test-'))
  const dbPath = path.join(tmpDir, 'concurrent.db')

  // 1. 鍒濆鍖栧啓鍏ュ熀鍑?revision 1
  const initBackend = new SqliteSaveBackend({ dbPath })
  const initStore = new SaveStore(initBackend)
  const initWrite = await initStore.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-race',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'rng-init',
    modelBindings: {},
    state: { grid: [[0]] },
    operationId: 'op-init',
    expectedRevision: 0,
  })
  assert.equal(initWrite.ok, true)
  assert.equal(initWrite.revision, 1)

  // 2. 缂栧啓鐙珛瀛愯繘绋嬭剼鏈細灏濊瘯浠?expectedRevision=1 鍐欏叆
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const childScript = path.join(tmpDir, 'child-worker.mjs')
  const hostStaging = path.resolve(fileURLToPath(import.meta.url), '../../staging/storage/save-store.js')
  const stagingUrl = pathToFileURL(hostStaging).href
  const scriptContent = `
    import { SaveStore, SqliteSaveBackend } from '${stagingUrl}';
    const [,, dbPath, opId, step] = process.argv;
    const backend = new SqliteSaveBackend({ dbPath });
    const store = new SaveStore(backend);
    try {
      const res = await store.writeCheckpoint({
        playerId: 'test-player',
    gameId: 'minesweeper',
        saveId: 'save-race',
        generation: 1,
        activeGeneration: 1,
        isSealed: false,
        installedCommit: 'commit-1',
        gameStateSchemaVersion: 1,
        elapsedGameMs: 200,
        rngState: 'rng-' + opId,
        modelBindings: {},
        state: { step: Number(step) },
        operationId: opId,
        expectedRevision: 1,
      });
      process.stdout.write(JSON.stringify(res));
      process.exit(res.ok ? 0 : 2);
    } catch (err) {
      process.stderr.write(err.message);
      process.exit(1);
    }
  `
  fs.writeFileSync(childScript, scriptContent, 'utf8')

  // 3. 娲剧敓鐙珛瀛愯繘绋?A 涓?B 骞跺彂绔炰簤鍐欏叆鍚屼竴 expectedRevision=1
  const pA = execFileAsync(process.execPath, [childScript, dbPath, 'op-A', '10']).catch((e) => e)
  const pB = execFileAsync(process.execPath, [childScript, dbPath, 'op-B', '20']).catch((e) => e)

  const [resA, resB] = await Promise.all([pA, pB])
  const outA = resA.stdout ? JSON.parse(resA.stdout) : { ok: false, code: 'STALE_RUNTIME' }
  const outB = resB.stdout ? JSON.parse(resB.stdout) : { ok: false, code: 'STALE_RUNTIME' }

  // 蹇呴』鏈変笖浠呮湁涓€涓瓙杩涚▼鎴愬姛鑾峰緱 revision 2锛屽彟涓€涓繀鍥犵増鏈啿绐佽鎷掔粷涓?STALE_RUNTIME
  const aSuccess = outA.ok === true
  const bSuccess = outB.ok === true
  assert.equal(aSuccess !== bSuccess, true, '瀛愯繘绋?A 涓?B 蹇呴』鏈変笖浠呮湁涓€涓垚鍔燂紒')

  const winningRes = aSuccess ? outA : outB
  const losingRes = aSuccess ? outB : outA
  assert.equal(winningRes.revision, 2)
  assert.equal(losingRes.code, 'STALE_RUNTIME')

  // 4. 娴嬭瘯鐙珛杩涚▼涓柇鍚庢仮澶嶏細妯℃嫙涓€涓啓鍏ヤ腑閫旀姏閿欑殑杩涚▼
  const crashScript = path.join(tmpDir, 'child-crash.mjs')
  const crashContent = `
    import { DatabaseSync } from 'node:sqlite';
    const [,, dbPath] = process.argv;
    const db = new DatabaseSync(dbPath);
    db.exec('BEGIN IMMEDIATE');
    // 鎻掑叆鑴忔暟鎹?    db.exec("INSERT INTO gamecenter_saves (key, game_id, save_id, revision, data, updated_at) VALUES ('dirty', 'g', 's', 99, 'dirty-data', 0)");
    // 妯℃嫙瀛愯繘绋嬬獊鐒跺紓甯镐腑鏂紝鏈?COMMIT
    process.exit(1);
  `
  fs.writeFileSync(crashScript, crashContent, 'utf8')
  await execFileAsync(process.execPath, [crashScript, dbPath]).catch(() => {})

  // 5. 独立进程 C 重新打开 DB，断言事务未提交的脏数据已被 SQLite 自动回滚排除
  const recoverStore = new SaveStore(new SqliteSaveBackend({ dbPath }))
  const dirtyCheck = await recoverStore.readCheckpoint('g', 's', { playerId: 'test-player' })
  assert.equal(dirtyCheck.ok, false, '未提交的脏记录必须不存在！')

  // 且原存档正常可读，revision 依然保持为 2
  const finalRead = await recoverStore.readCheckpoint('minesweeper', 'save-race', { playerId: 'test-player' })
  assert.equal(finalRead.ok, true)
  assert.equal(finalRead.save.revision, 2)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('SqliteSaveBackend 事务中断原子回滚：中途异常绝不产生脏记录与 revision 漂移', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tx-abort-'))
  const dbPath = path.join(tmpDir, 'abort.db')
  const sqlite = new SqliteSaveBackend({ dbPath })
  const store = new SaveStore(sqlite)

  // 1. 鎴愬姛鍐欏叆涓€娆?revision 1
  const w1 = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-abort',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'rng',
    modelBindings: {},
    state: { step: 1 },
    operationId: 'op-1',
    expectedRevision: 0,
  })
  assert.equal(w1.ok, true)
  assert.equal(w1.revision, 1)

  // 2. 妯℃嫙涓€旀姏閿欙紙渚嬪浼犲叆琚?Object.defineProperty 鎷︽埅鎶涢敊鐨勫彲鏋氫妇灞炴€э級
  const poisonState = {}
  Object.defineProperty(poisonState, 'explode', {
    enumerable: true,
    get() {
      throw new Error('Transaction exploded in middle!')
    },
  })

  const failWrite = await store.writeCheckpoint({
    playerId: 'test-player',
    gameId: 'minesweeper',
    saveId: 'save-abort',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: 'commit-1',
    gameStateSchemaVersion: 1,
    elapsedGameMs: 200,
    rngState: 'rng',
    modelBindings: {},
    state: poisonState,
    operationId: 'op-fail',
    expectedRevision: 1,
  })
  assert.equal(failWrite.ok, false)
  assert.equal(failWrite.code, 'INTERNAL')
  assert.match(failWrite.message, /Transaction exploded in middle/)

  // 3. 鍥炴粴鍚庤鍙栵細revision 浠嶇劧缁存寔 1锛屾暟鎹湭琚牬鍧忥紝涓旀湭鐣欎笅 op-fail
  const readAfter = await store.readCheckpoint('minesweeper', 'save-abort', { playerId: 'test-player' })
  assert.equal(readAfter.ok, true)
  assert.equal(readAfter.save.revision, 1)
  assert.equal(readAfter.save.state.step, 1)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('SqliteSaveBackend 鎹熷潖鏁版嵁鎷掕锛欴B 涓啓鍏ヨ鎴柇鐨勬崯鍧?payload 蹇呴』鏄庣‘鎷掔粷', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-corrupt-'))
  const dbPath = path.join(tmpDir, 'corrupt.db')
  const sqlite = new SqliteSaveBackend({ dbPath })
  const store = new SaveStore(sqlite)

  const key = 'saves/test-player/minesweeper/save-broken.json'
  // 1. 写入语法非法的截断 JSON
  sqlite.write(key, '{"saveFormatVersion": 1, "gameId": "minesweeper", "broken...')
  const readCorrupt = await store.readCheckpoint('minesweeper', 'save-broken', { playerId: 'test-player' })
  assert.equal(readCorrupt.ok, false)
  assert.equal(readCorrupt.code, 'PROTOCOL_INVALID')
  assert.match(readCorrupt.message, /非合法 JSON/)

  // 2. 写入缺失 integrityDigest 的残缺对象
  sqlite.write(key, JSON.stringify({ saveFormatVersion: 1, playerId: 'test-player', gameId: 'minesweeper', saveId: 'save-broken' }))
  const readMissingDigest = await store.readCheckpoint('minesweeper', 'save-broken', { playerId: 'test-player' })
  assert.equal(readMissingDigest.ok, false)
  assert.equal(readMissingDigest.code, 'PROTOCOL_INVALID')
  assert.match(readMissingDigest.message, /缺失完整性校验码/)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})




