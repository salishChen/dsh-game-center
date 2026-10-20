/**
 * P7 真实 MessagePort 链路：SDK → MessageChannel → Dispatcher → SaveStore(SQLite)。
 *
 * 与 P6 的区别（这是本轮的核心）：
 * - P6 直接调 `SaveStore`，只能证明存储层；
 * - P7 走**真实 MessageChannel**：SDK 发出 → Dispatcher 收包、校验、派发 → 真实 SQLite → 回包 → SDK resolve。
 *
 * 证据分栏：UNIT（进程内真实端口 + 真实 SQLite 文件），不是 DSH-REAL。
 * 运行：pnpm -C tests/integration test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { createHash } from 'node:crypto'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const HOST_STAGING = path.join(REPO_ROOT, 'packages/dsh-gamecenter/staging')

const GAME_ID = 'example.minesweeping'
const SAVE_ID = 'save-messageport'
const PLAYER_ID = 'player-A'
const COMMIT = 'e4905dbe4a738a8406b39013292d6a545ab3a356'

const sha256 = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex')

async function loadHost() {
  return import(pathToFileURL(path.join(HOST_STAGING, 'storage/save-store.js')).href)
}

async function loadClient() {
  const sdk = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-gamecenter-client/src/sdk/index.js')).href
  )
  const dispatcher = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-gamecenter-client/src/bridge/dispatcher.js')).href
  )
  const lease = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-gamecenter-client/src/runtime/lease.js')).href
  )
  return { sdk, dispatcher, lease }
}

/** 建一条「SDK ↔ Dispatcher ↔ SQLite」真实端口链路。 */
async function createBridgeStack(dbPath) {
  const hostMod = await loadHost()
  const clientMod = await loadClient()

  const store = new hostMod.SaveStore(new hostMod.SqliteSaveBackend({ dbPath }))
  const channel = new MessageChannel()

  const runtimeLease = clientMod.lease.createRuntimeLease({
    gameId: GAME_ID,
    saveId: SAVE_ID,
    runtimeInstanceId: 'rt-messageport-1',
    nonce: 'nonce-1',
    generation: 1,
  })
  runtimeLease.state = 'running'

  /** 宿主侧派发：把 Bridge 载荷落到真实 SQLite。 */
  const checkpointCalls = []
  const dispatcher = clientMod.dispatcher.createBridgeDispatcher({
    lease: runtimeLease,
    port: channel.port2,
    // 可信身份由宿主注入，绝不取游戏自报值
    playerId: PLAYER_ID,
    onCheckpoint: async (payload) => {
      checkpointCalls.push({
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
        playerId: payload.playerId,
      })
      const result = await store.writeCheckpoint({
        playerId: payload.playerId,
        gameId: GAME_ID,
        saveId: SAVE_ID,
        generation: runtimeLease.generation,
        activeGeneration: runtimeLease.generation,
        isSealed: false,
        installedCommit: COMMIT,
        gameStateSchemaVersion: 1,
        elapsedGameMs: payload.elapsedGameMs,
        rngState: payload.rngState,
        modelBindings: {},
        state: payload.state,
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
      })
      return result
    },
    onReady: () => {},
  })

  const { sdk, dispose } = clientMod.sdk.createGameCenterSDKWithDispose({ port: channel.port1 })

  return {
    store,
    dispatcher,
    lease: runtimeLease,
    sdk,
    dispose,
    checkpointCalls,
    channel,
    hostMod,
  }
}

function closeStack(stack) {
  // 成功与失败两条路径都必须释放：否则端口持有监听，进程不退出
  try {
    stack.dispose()
  } catch {
    /* 已释放 */
  }
  try {
    stack.dispatcher.dispose()
  } catch {
    /* 已释放 */
  }
  for (const port of [stack.channel.port1, stack.channel.port2]) {
    try {
      port.close()
    } catch {
      /* 已关闭 */
    }
  }
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

test('P7-1 真实 MessageChannel：SDK 保存 → Dispatcher → SQLite → 回包', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-'))
  const dbPath = path.join(tmp, 'saves.db')
  const stack = await createBridgeStack(dbPath)

  try {
    await stack.sdk.lifecycle.ready()
    // 关闭前先冻结时钟：这是真实关闭流程的顺序（先冻结再保存），
    // 同时让 elapsedGameMs 在重试间保持稳定——否则同一 operationId 的内容摘要会漂移。
    stack.sdk.clock.pause()

    const first = await stack.sdk.save.checkpoint(
      { board: [0, 1, 0], elapsed: 120 },
      { operationId: 'op-1', expectedRevision: 0 },
    )
    assert.equal(first.revision, 1, '首次保存应得到 revision=1（经真实 Bridge 回包）')
    assert.equal(first.idempotentReplay, false)
    assert.equal(stack.checkpointCalls.length, 1, 'Dispatcher 必须真的被调用')
    assert.equal(stack.checkpointCalls[0].playerId, PLAYER_ID, 'Dispatcher 必须注入宿主身份')
    assert.equal(stack.checkpointCalls[0].operationId, 'op-1', 'operationId 必须原样透传')

    // 同一 operationId 重试：必须幂等返回原 revision
    const replay = await stack.sdk.save.checkpoint(
      { board: [0, 1, 0], elapsed: 120 },
      { operationId: 'op-1', expectedRevision: 1 },
    )
    assert.equal(replay.revision, 1, '幂等重放不得 +1')
    assert.equal(replay.idempotentReplay, true, '必须标记为幂等重放')

    // 新动作（不同 operationId），即使状态相同也必须是新检查点
    const next = await stack.sdk.save.checkpoint(
      { board: [0, 1, 0], elapsed: 120 },
      { operationId: 'op-2', expectedRevision: 1 },
    )
    assert.equal(next.revision, 2, '不同 operationId 即使状态相同也必须产生新 revision')

    // 落库核对：不是只有回包对
    const read = await stack.store.readCheckpoint(GAME_ID, SAVE_ID, {
      playerId: PLAYER_ID,
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(read.ok, true)
    assert.equal(read.save.revision, 2)
    assert.deepEqual(read.save.state, { board: [0, 1, 0], elapsed: 120 })
  } finally {
    closeStack(stack)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P7-2 关闭：triggerPause → SDK pause 钩子 → pauseAck → 租约进入 paused', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-pause-'))
  const dbPath = path.join(tmp, 'saves.db')
  const stack = await createBridgeStack(dbPath)

  try {
    await stack.sdk.lifecycle.ready()
    let pauseHookCalls = 0
    stack.sdk.lifecycle.register({
      pause: () => {
        pauseHookCalls += 1
        return { board: [0, 1, 0], elapsed: 120 }
      },
    })

    await stack.sdk.save.checkpoint(
      { board: [1, 1, 0] },
      { operationId: 'op-pause-1', expectedRevision: 0 },
    )

    const triggered = stack.dispatcher.triggerPause({ reason: 'user_close' })
    assert.equal(triggered, true, '应能触发暂停')

    const reached = await waitFor(() => stack.lease.state === 'paused')
    assert.equal(reached, true, `租约应进入 paused，实际 ${stack.lease.state}`)
    assert.equal(pauseHookCalls >= 1, true, 'SDK 的 pause 钩子必须被调用')
    assert.equal(stack.lease.lastRevision, 1, '暂停确认后租约应记录最后 revision')

    // 暂停后新请求必须被拒绝（不能静默挂起）
    await assert.rejects(
      () => stack.sdk.save.checkpoint({ board: [9] }, { operationId: 'op-after-pause', expectedRevision: 1 }),
      (err) => {
        assert.equal(err.code, 'PAUSED', '暂停后应返回 PAUSED')
        return true
      },
    )
  } finally {
    closeStack(stack)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P7-3 销毁端口后用同一 DB 重建：能从 SQLite 恢复同进度', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-restore-'))
  const dbPath = path.join(tmp, 'saves.db')

  const first = await createBridgeStack(dbPath)
  let savedRevision
  try {
    await first.sdk.lifecycle.ready()
    const res = await first.sdk.save.checkpoint(
      { board: [0, 0, 1], elapsed: 777, rng: 'abc' },
      { operationId: 'op-persist-1', expectedRevision: 0 },
    )
    savedRevision = res.revision
    assert.equal(savedRevision, 1)
  } finally {
    // 销毁整个运行实例（端口、监听、SDK）
    closeStack(first)
  }

  // 全新 Store 打开同一 DB 文件：不依赖任何内存状态
  const hostMod = await loadHost()
  const reopened = new hostMod.SaveStore(new hostMod.SqliteSaveBackend({ dbPath }))
  try {
    const read = await reopened.readCheckpoint(GAME_ID, SAVE_ID, {
      playerId: PLAYER_ID,
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(read.ok, true)
    assert.equal(read.save.revision, savedRevision)
    assert.deepEqual(read.save.state, { board: [0, 0, 1], elapsed: 777, rng: 'abc' })

    // 其他玩家读不到（物理隔离）
    const otherPlayer = await reopened.readCheckpoint(GAME_ID, SAVE_ID, {
      playerId: 'player-B',
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(otherPlayer.ok, false, '其他玩家不得读到本玩家存档')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P7-4 非法 payload：必须明确回错误，不得无响应挂起', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-bad-'))
  const dbPath = path.join(tmp, 'saves.db')
  const stack = await createBridgeStack(dbPath)

  try {
    // 绕开 SDK，直接向端口发一个缺 operationId / expectedRevision 的旧式 payload
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('60s 内没有收到任何回包（挂起）')), 3000)
      const onMessage = (data) => {
        if (data && data.requestId === 'bad-req-1') {
          clearTimeout(timer)
          stack.channel.port1.off('message', onMessage)
          resolve(data)
        }
      }
      stack.channel.port1.on('message', onMessage)
      stack.channel.port1.postMessage({
        bridgeVersion: 1,
        requestId: 'bad-req-1',
        method: 'save.checkpoint',
        payload: { state: { score: 100 } },
      })
    })

    assert.equal(response.ok, false, '缺必填字段必须回错误，而不是成功写入')
    assert.equal(
      response.error?.code,
      'PROTOCOL_INVALID',
      `应返回 PROTOCOL_INVALID，实际: ${JSON.stringify(response.error)}`,
    )
  } finally {
    closeStack(stack)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P7-5 泄漏检查：销毁后端口无残留监听', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p7-leak-'))
  const dbPath = path.join(tmp, 'saves.db')
  const stack = await createBridgeStack(dbPath)

  try {
    await stack.sdk.lifecycle.ready()
    await stack.sdk.save.checkpoint({ board: [1] }, { operationId: 'op-leak', expectedRevision: 0 })
  } finally {
    closeStack(stack)
  }

  // dispose 后不应再持有监听
  assert.equal(
    stack.channel.port1.listenerCount('message'),
    0,
    'SDK dispose 后 port1 不应残留 message 监听',
  )
  assert.equal(
    stack.channel.port2.listenerCount('message'),
    0,
    'dispatcher dispose 后 port2 不应残留 message 监听',
  )
  await fs.rm(tmp, { recursive: true, force: true })
})
