/**
 * P7-6/P7-7 重试语义（严格版）。
 *
 * PM 2026-10-19 要求：不能只凭"重放成功"推断前提成立，必须
 * 1. 显式制造**虚拟时间**与**RNG**变化；
 * 2. 断言首次请求与重试请求**实际发送的完整载荷逐字段一致**；
 * 3. 验证**新逻辑动作不复用旧快照**（即使状态相同也要新 op、新 revision）；
 * 4. 验证同 operationId 改业务内容被明确拒绝。
 *
 * 为此本文件在 dispatcher 的 onCheckpoint 处挂**载荷探针**，
 * 记录每次 Bridge 请求真实到达宿主的字段，再做断言——而不是看 SDK 的返回值。
 *
 * 证据分栏：UNIT（进程内真实 MessageChannel + 真实 SQLite），不是 DSH-REAL。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const HOST_STAGING = path.join(REPO_ROOT, 'packages/dsh-gamecenter/staging')

const GAME_ID = 'example.minesweeping'
const SAVE_ID = 'save-retry-strict'
const PLAYER_ID = 'player-A'
const COMMIT = 'e4905dbe4a738a8406b39013292d6a545ab3a356'

async function createLink(dbPath) {
  const hostMod = await import(pathToFileURL(path.join(HOST_STAGING, 'storage/save-store.js')).href)
  const dispatcherMod = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-gamecenter-client/src/bridge/dispatcher.js')).href
  )
  const leaseMod = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-gamecenter-client/src/runtime/lease.js')).href
  )

  const store = new hostMod.SaveStore(new hostMod.SqliteSaveBackend({ dbPath }))
  const lease = leaseMod.createRuntimeLease({
    gameId: GAME_ID,
    saveId: SAVE_ID,
    runtimeInstanceId: 'rt-retry',
    nonce: 'n',
    generation: 1,
  })
  lease.state = 'running'

  /** 每次真实到达宿主的载荷（只记录契约字段，便于逐字段比对）。 */
  const payloads = []

  const link = dispatcherMod.connectSDKToDispatcher({
    lease,
    playerId: PLAYER_ID,
    initialSeed: 424242,
    initialElapsedMs: 0,
    onCheckpoint: async (input) => {
      payloads.push({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        state: input.state,
        elapsedGameMs: input.elapsedGameMs,
        rngState: input.rngState,
        playerId: input.playerId,
      })
      return store.writeCheckpoint({
        ...input,
        gameId: GAME_ID,
        saveId: SAVE_ID,
        generation: lease.generation,
        activeGeneration: lease.generation,
        isSealed: false,
        installedCommit: COMMIT,
        gameStateSchemaVersion: 1,
        modelBindings: {},
      })
    },
  })

  return { store, lease, link, payloads }
}

function closeLink(link) {
  try {
    link.dispose()
  } catch {
    /* 已释放 */
  }
}

test('P7-6 时间与 RNG 都漂移时，重试必须发送与首次逐字段一致的完整载荷', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-strict-'))
  const dbPath = path.join(tmp, 'saves.db')
  const { store, link, payloads } = await createLink(dbPath)

  try {
    // 让虚拟时钟真的走起来（否则"漂移"不成立）
    await link.sdk.lifecycle.ready()
    assert.equal(link.sdk.clock.isClockFrozen(), false, '时钟必须在运行中')

    const first = await link.sdk.save.checkpoint({ board: [1, 0, 1] }, { operationId: 'op-live', expectedRevision: 0 })
    assert.equal(first.revision, 1)
    assert.equal(payloads.length, 1)
    const firstPayload = payloads[0]

    // ---- 显式制造两类漂移 ----
    // 1) 虚拟时间：把累计时间改成悬殊值
    link.sdk.clock.reset(99999)
    assert.equal(link.sdk.clock.getElapsedMs(), 99999, '虚拟时间必须已漂移')
    // 2) RNG：推进随机序列
    link.sdk.random.next()
    link.sdk.random.next()
    const driftedRng = link.sdk.random.getState()
    assert.notEqual(driftedRng, firstPayload.rngState, 'RNG 状态必须已漂移')

    // 重试同一逻辑请求
    const retry = await link.sdk.save.checkpoint({ board: [1, 0, 1] }, { retry: true })
    assert.equal(retry.revision, 1, '重试不得推进 revision')
    assert.equal(retry.idempotentReplay, true)

    // ---- 核心断言：实际发送的完整载荷必须逐字段一致 ----
    assert.equal(payloads.length, 2, '必须发生两次真实 Bridge 请求')
    const retryPayload = payloads[1]
    assert.deepEqual(
      retryPayload,
      firstPayload,
      `重试载荷必须与首次逐字段一致；实际首次=${JSON.stringify(firstPayload)} 重试=${JSON.stringify(retryPayload)}`,
    )
    // 单独点名三个易漂移字段，失败时定位更清楚
    assert.equal(retryPayload.elapsedGameMs, firstPayload.elapsedGameMs, '重试 elapsedGameMs 必须复用首次值（而非当前 99999）')
    assert.equal(retryPayload.rngState, firstPayload.rngState, '重试 rngState 必须复用首次值')
    assert.deepEqual(retryPayload.state, firstPayload.state, '重试 state 必须一致')
    assert.equal(retryPayload.operationId, 'op-live')
    assert.equal(retryPayload.expectedRevision, 0)

    const read = await store.readCheckpoint(GAME_ID, SAVE_ID, {
      playerId: PLAYER_ID,
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(read.ok, true)
    assert.equal(read.save.revision, 1)
  } finally {
    closeLink(link)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P7-7 新逻辑动作不复用旧快照：状态相同也必须是新 operationId 与新 revision', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-newact-'))
  const dbPath = path.join(tmp, 'saves.db')
  const { store, link, payloads } = await createLink(dbPath)

  try {
    await link.sdk.lifecycle.ready()

    const a = await link.sdk.save.checkpoint({ board: [1, 0, 1] }, { operationId: 'act-A', expectedRevision: 0 })
    assert.equal(a.revision, 1)

    // 完全相同的状态，但这是**新动作**（无 operationId、非 retry）
    const b = await link.sdk.save.checkpoint({ board: [1, 0, 1] })
    assert.notEqual(b.operationId, a.operationId, '新动作必须生成新 operationId，不得复用')
    assert.equal(b.revision, 2, '新动作即使状态相同也必须推进 revision')
    assert.equal(payloads.length, 2)
    assert.notEqual(payloads[1].operationId, payloads[0].operationId, '载荷中的 operationId 必须不同')

    const read = await store.readCheckpoint(GAME_ID, SAVE_ID, {
      playerId: PLAYER_ID,
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(read.ok, true)
    assert.equal(read.save.revision, 2)
  } finally {
    closeLink(link)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P7-8 同一 operationId 改业务内容：必须拒绝为 PROTOCOL_INVALID 且不改库', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-conflict-'))
  const dbPath = path.join(tmp, 'saves.db')
  const { store, link, payloads } = await createLink(dbPath)

  try {
    await link.sdk.lifecycle.ready()
    const first = await link.sdk.save.checkpoint({ board: [1, 0, 1] }, { operationId: 'op-fixed', expectedRevision: 0 })
    assert.equal(first.revision, 1)

    let error = null
    try {
      await link.sdk.save.checkpoint({ board: [9, 9, 9] }, { operationId: 'op-fixed', expectedRevision: 1 })
    } catch (err) {
      error = err
    }
    assert.notEqual(error, null, '同 op 不同内容必须抛错')
    assert.equal(error.code, 'PROTOCOL_INVALID', `实际 code=${error.code}`)

    // 载荷层面确认：第二次确实带了不同 state，不是被 SDK 静默改回旧值
    assert.equal(payloads.length, 2)
    assert.notDeepEqual(payloads[1].state, payloads[0].state, '第二次请求应携带调用方显式给出的不同 state')

    const read = await store.readCheckpoint(GAME_ID, SAVE_ID, {
      playerId: PLAYER_ID,
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(read.ok, true)
    assert.equal(read.save.revision, 1, '拒绝后库内 revision 不得变化')
    assert.deepEqual(read.save.state, { board: [1, 0, 1] }, '拒绝后库内内容不得被覆盖')
  } finally {
    closeLink(link)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
