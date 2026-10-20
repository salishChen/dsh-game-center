/**
 * P6 全链路集成测试（证据分栏：UNIT + MOCK，非 DSH-REAL）。
 *
 * 串起真实模块，不打网络、不碰用户真实存档、不触碰在线产物：
 *   protocol（Issue 解析 / 五元组审批 / 安装计划）
 *   → catalog（bundleDigest 校验 / 隔离安装 / 零脚本执行）
 *   → 真实扫雷规则引擎与 dist（独立仓 dsh-game-minesweeping，本地）
 *   → Client SDK（fixture AI、虚拟时钟、种子随机）
 *   → 宿主侧存档适配器（待 Host 的 SaveStore 交付后替换为此文件的 adapter）
 *
 * 目录条目与审批记录来自本地 fixture，而不是真实 GitHub API，因此是 MOCK。
 * 运行：pnpm -C tests/integration test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import {
  parseCatalogIssueBody,
  authorizeInstall,
  buildInstallPlan,
  checkSaveCompatibility,
} from '@dsh-gamecenter/protocol'

import { calculateBundleDigest, installGamePackage } from '@dsh-gamecenter/catalog'

import { createGameCenterSDK } from '../../../packages/dsh-gamecenter-client/src/sdk/index.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

/**
 * 扫雷游戏仓位置：优先环境变量，其次默认使用与平台仓相邻的兄弟目录。
 *
 * 不用硬编码个人路径；找不到时明确失败并说明如何配置，不静默跳过。
 */
function resolveGameRepo() {
  const fromEnv = process.env.DSH_MINESWEEPING_REPO
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv)
  return path.resolve(REPO_ROOT, '..', 'dsh-game-minesweeping')
}

const GAME_REPO = resolveGameRepo()
const COMMIT = 'e4905dbe4a738a8406b39013292d6a545ab3a356'
const REPOSITORY = 'https://github.com/salishChen/dsh-game-minesweeping.git'
const GAME_ID = 'example.minesweeping'
const PLAYER_ID = 'player-A'

const sha256 = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex')

async function readGameDist() {
  const distDir = path.join(GAME_REPO, 'dist')
  const names = await fs.readdir(distDir)
  const files = []
  for (const name of names.sort()) {
    const full = path.join(distDir, name)
    const stat = await fs.stat(full)
    if (!stat.isFile()) continue
    files.push({ path: `dist/${name}`, content: await fs.readFile(full) })
  }
  return files
}

async function buildFixture() {
  const manifestRaw = await fs.readFile(path.join(GAME_REPO, 'gamecenter.json'))
  const files = await readGameDist()
  const { bundleDigest } = calculateBundleDigest(files)
  const manifestDigest = sha256(manifestRaw)

  const entry = {
    schemaVersion: 1,
    gameId: GAME_ID,
    title: '扫雷',
    summary: '确定性规则引擎，AI 仅生成对局',
    version: '1.0.0',
    source: {
      repository: REPOSITORY,
      ref: 'v1.0.0',
      commit: COMMIT,
      manifestPath: 'gamecenter.json',
      manifestDigest,
      bundleDigest,
    },
  }
  const approval = {
    gameId: GAME_ID,
    repository: REPOSITORY,
    commit: COMMIT,
    manifestDigest,
    bundleDigest,
    approvedBy: 'maintainer',
    approvedAt: '2026-10-19T00:00:00Z',
    approvalRecordPath: `approvals/${GAME_ID}/1.0.0.json`,
  }
  return { entry, approval, manifestRaw, files }
}

function issueBody(entry) {
  return [
    '<!-- dsh-gamecenter-entry:v1 -->',
    '# 扫雷',
    '',
    '```gamecenter-json',
    JSON.stringify(entry),
    '```',
  ].join('\n')
}

async function loadEngine() {
  const mod = await import(pathToFileURL(path.join(GAME_REPO, 'src', 'engine.js')).href)
  return mod.MinesweeperEngine
}

/**
 * 宿主侧存档：使用 Host 的 SaveStore，但**从 staging 产物导入**。
 *
 * 为什么不从 lib/ 导入：`profile` 的 junction 直指 `packages/dsh-gamecenter`，
 * 该目录的 `lib/` 是在线服务正在使用的磁盘产物；开发期构建/导入 `lib/` 会污染在线版本。
 * 因此集成测试只读 `staging/`（由 `pnpm run build:staging` 生成，不进版本库、不被 junction 引用）。
 *
 * 后端选择：
 * - `MemorySaveBackend` 只是内存替身，**不能**证明进程退出后可恢复；
 * - 跨进程恢复用例（P6-8）必须走 SQLite 持久后端，Host 未交付时该用例直接失败，
 *   作为可见缺口而不是静默跳过。
 */
const HOST_STAGING_DIR = path.join(REPO_ROOT, 'packages/dsh-gamecenter/staging')

async function loadHostStoreModule() {
  const candidates = ['storage/save-store.js', 'storage/save-store.ts']
  for (const rel of candidates) {
    const file = path.join(HOST_STAGING_DIR, rel)
    try {
      await fs.access(file)
      return import(pathToFileURL(file).href)
    } catch {
      // 继续尝试下一个；都不存在时抛出可读错误
    }
  }
  throw new Error(
    `未找到 Host staging 产物 ${path.join(HOST_STAGING_DIR, 'storage/save-store.js')}；请先运行 pnpm run build:staging`,
  )
}

async function createRealHostStore() {
  const mod = await loadHostStoreModule()
  const backend = new mod.MemorySaveBackend()
  return { store: new mod.SaveStore(backend), backend, mod }
}

/** 持久化后端：优先用 Host 的 SqliteSaveBackend；缺失则明确失败，不回落到内存。 */
async function createPersistentHostStore(dbPath) {
  const mod = await loadHostStoreModule()
  if (typeof mod.SqliteSaveBackend !== 'function') {
    throw new Error(
      'Host 未交付 SqliteSaveBackend：MemorySaveBackend 不能证明跨进程恢复，无法完成持久化闭环',
    )
  }
  const backend = new mod.SqliteSaveBackend({ dbPath })
  return { store: new mod.SaveStore(backend), backend, mod }
}

function makeFakePort() {
  return {
    postMessage() {},
    addEventListener() {},
    start() {},
  }
}

test('P6-1 fixture Issue → 五元组审批 → 校验 → 隔离安装 → 产物可读', async () => {
  const { entry, approval, manifestRaw, files } = await buildFixture()

  const parsed = parseCatalogIssueBody(issueBody(entry))
  assert.equal(parsed.ok, true, `机器块应可解析: ${parsed.reason ?? ''}`)

  const authorized = authorizeInstall(parsed.entry, [approval])
  assert.equal(authorized.ok, true, '五元组一致应放行')

  const planResult = buildInstallPlan(parsed.entry, [approval])
  assert.equal(planResult.ok, true)
  assert.equal(planResult.plan.installDir, `${GAME_ID}/${COMMIT}`)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-'))
  const installed = await installGamePackage({
    plan: planResult.plan,
    packagesDir: path.join(tmp, 'packages'),
    stagingDir: path.join(tmp, 'staging'),
    files,
    manifestContent: manifestRaw,
  })
  assert.equal(installed.ok, true, `安装应成功: ${installed.reason ?? ''}`)

  const html = await fs.readFile(path.join(installed.installedPath, 'dist', 'index.html'), 'utf8')
  assert.ok(html.length > 0, '安装后的入口应可读')
  const meta = JSON.parse(
    await fs.readFile(path.join(installed.installedPath, '.dsh-installed.json'), 'utf8'),
  )
  assert.equal(meta.commit, COMMIT, '安装元数据应记录固定提交')
  assert.equal(meta.bundleDigest, entry.source.bundleDigest)

  // 版本隔离：同 gameId 另一 commit 并存，不覆盖旧版本
  const otherCommit = 'f'.repeat(40)
  const second = await installGamePackage({
    plan: { ...planResult.plan, commit: otherCommit, installDir: `${GAME_ID}/${otherCommit}` },
    packagesDir: path.join(tmp, 'packages'),
    stagingDir: path.join(tmp, 'staging'),
    files,
    manifestContent: manifestRaw,
  })
  assert.equal(second.ok, true)
  assert.notEqual(second.installedPath, installed.installedPath)
  assert.ok(await fs.stat(installed.installedPath), '旧版本目录必须仍存在')

  await fs.rm(tmp, { recursive: true, force: true })
})

test('P6-2 篡改 bundleDigest 或 repository 必须拒绝安装', async () => {
  const { entry, approval, manifestRaw, files } = await buildFixture()

  const badDigest = { ...entry, source: { ...entry.source, bundleDigest: 'sha256:' + 'a'.repeat(64) } }
  const rejected = authorizeInstall(badDigest, [approval])
  assert.equal(rejected.ok, false, '摘要与审批不符必须拒绝')

  const movedRepo = { ...entry, source: { ...entry.source, repository: 'https://github.com/attacker/x.git' } }
  assert.equal(authorizeInstall(movedRepo, [approval]).ok, false, '仓库被改指向必须拒绝')

  // 即使绕过审批直接给安装器，摘要不符也必须失败
  const planResult = buildInstallPlan(entry, [approval])
  assert.equal(planResult.ok, true)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-bad-'))
  const tamperedFiles = files.map((f, i) =>
    i === 0 ? { ...f, content: Buffer.from('tampered') } : f,
  )
  const result = await installGamePackage({
    plan: planResult.plan,
    packagesDir: path.join(tmp, 'packages'),
    stagingDir: path.join(tmp, 'staging'),
    files: tamperedFiles,
    manifestContent: manifestRaw,
  })
  assert.equal(result.ok, false, '产物被篡改必须安装失败')
  assert.equal(result.code, 'PROTOCOL_INVALID')
  await fs.rm(tmp, { recursive: true, force: true })
})

test('P6-3 未审批条目不得生成安装计划', async () => {
  const { entry } = await buildFixture()
  assert.equal(buildInstallPlan(entry, []).ok, false)
})

test('P6-4 关闭 → 持久化 → 重建：棋盘、虚拟时间、RNG 必须一致', async () => {
  const MinesweeperEngine = await loadEngine()
  const { entry, approval, manifestRaw, files } = await buildFixture()
  const planResult = buildInstallPlan(entry, [approval])
  assert.equal(planResult.ok, true)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-save-'))
  const installed = await installGamePackage({
    plan: planResult.plan,
    packagesDir: path.join(tmp, 'packages'),
    stagingDir: path.join(tmp, 'staging'),
    files,
    manifestContent: manifestRaw,
  })
  assert.equal(installed.ok, true)

  // 第一次运行：玩几步，产生棋盘、时间与 RNG 状态
  const engineA = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 424242 })
  const sdkA = createGameCenterSDK({
    port: makeFakePort(),
    initialSeed: 424242,
    initialElapsedMs: 0,
  })
  engineA.reveal(4, 4)
  engineA.reveal(0, 0)
  engineA.toggleFlag(2, 2)
  engineA.tick(1500)
  sdkA.clock.resume()
  sdkA.clock.tick?.(1500)

  // 关闭：SDK 的 pause 钩子产出快照，交给 Host 真实 SaveStore + 真实 SQLite 文件持久化
  const snapshotBeforeClose = engineA.serialize()
  const saveDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-close-'))
  const { store: host } = await createPersistentHostStore(path.join(saveDbDir, 'saves.db'))
  const write = await host.writeCheckpoint({
    playerId: PLAYER_ID,    gameId: GAME_ID,
    saveId: 'save-1',
    operationId: 'close-op-1',
    expectedRevision: 0,
    generation: 3,
    activeGeneration: 3,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: engineA.elapsedMs,
    rngState: engineA.rng.getState(),
    modelBindings: {},
    state: snapshotBeforeClose,
  })
  assert.equal(write.ok, true, '关闭时应能写入检查点')
  assert.equal(write.revision, 1)

  // 重建：从存档恢复
  const read = await host.readCheckpoint(GAME_ID, 'save-1', {
    playerId: PLAYER_ID,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: [COMMIT],
  })
  assert.equal(read.ok, true)
  assert.equal(read.save.installedCommit, COMMIT)
  assert.equal(read.save.status, 'paused')

  const engineB = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 424242 })
  engineB.restore(read.save.state)

  assert.deepEqual(engineB.serialize(), snapshotBeforeClose, '重建后棋盘必须与关闭前一致')
  assert.equal(engineB.elapsedMs, read.save.elapsedGameMs, '虚拟时间必须一致')
  assert.equal(engineB.rng.getState(), read.save.rngState, 'RNG 状态必须一致')

  // 恢复后继续操作，结果与不中断时一致（同种子确定性）
  engineB.reveal(8, 8)
  const continued = engineB.serialize()
  const control = new MinesweeperEngine({ rows: 9, cols: 9, mineCount: 10, seed: 424242 })
  control.restore(snapshotBeforeClose)
  control.reveal(8, 8)
  assert.deepEqual(continued, control.serialize(), '恢复后续操作必须与连续运行一致')

  await fs.rm(saveDbDir, { recursive: true, force: true })
  await fs.rm(tmp, { recursive: true, force: true })
})

test('P6-5 存档：旧代次写入拒绝为 STALE_RUNTIME，revision 单调', async () => {
  const { store } = await createRealHostStore()
  const base = {
    playerId: PLAYER_ID,    gameId: GAME_ID,
    saveId: 'save-2',
    activeGeneration: 5,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: 100,
    rngState: 'a1',
    modelBindings: {},
    state: { step: 1 },
  }
  const first = await store.writeCheckpoint({ ...base, generation: 5 })
  assert.equal(first.ok, true)
  assert.equal(first.revision, 1)

  const second = await store.writeCheckpoint({ ...base, generation: 5 })
  assert.equal(second.ok, true)
  assert.equal(second.revision, 2)

  const stale = await store.writeCheckpoint({ ...base, generation: 4 })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'STALE_RUNTIME')

  const sealed = await store.writeCheckpoint({ ...base, generation: 5, isSealed: true })
  assert.equal(sealed.ok, false)
  assert.equal(sealed.code, 'STALE_RUNTIME')
})

test('P6-6 存档：篡改内容后读取必须失败（完整性摘要）', async () => {
  const { store, backend } = await createRealHostStore()
  await store.writeCheckpoint({
    playerId: PLAYER_ID,    gameId: GAME_ID,
    saveId: 'save-3',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: 10,
    rngState: 'b1',
    modelBindings: {},
    state: { step: 7 },
  })

  const key = `saves/${PLAYER_ID}/${GAME_ID}/save-3.json`
  const raw = JSON.parse(backend.read(key))
  assert.equal(raw.state.step, 7, '写入的内容应可读回')
  raw.state.step = 999
  backend.write(key, JSON.stringify(raw))

  const read = await store.readCheckpoint(GAME_ID, 'save-3', { playerId: PLAYER_ID })
  assert.equal(read.ok, false, '被篡改的存档必须读取失败')
  assert.equal(read.code, 'PROTOCOL_INVALID', '错误码必须是 PROTOCOL_INVALID')
})

test('P6-8 跨进程持久化：真实子进程 A 写入退出 → 子进程 B 重开 DB 恢复并继续递增', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-sqlite-'))
  const dbPath = path.join(tmp, 'saves.db')
  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const writerScript = path.join(fixturesDir, 'checkpoint-child-writer.mjs')
  const readerScript = path.join(fixturesDir, 'checkpoint-child-reader.mjs')

  // 必须是独立 OS 进程，不是同进程里 new 一个 Store
  const run = (script, extraArgs) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, dbPath, REPO_ROOT, ...extraArgs], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`子进程退出码 ${code}: ${err || out}`))
          return
        }
        const lastLine = out.trim().split(/\r?\n/).pop()
        try {
          resolve({ json: JSON.parse(lastLine), pid: child.pid, exitCode: code })
        } catch {
          reject(new Error(`子进程输出不是 JSON: ${out}`))
        }
      })
    })

  // 进程 A：连写 3 次后退出（进程结束，内存状态全部消失）
  const writer = await run(writerScript, ['3'])
  assert.notEqual(writer.pid, process.pid, '写入方必须是独立进程')
  assert.equal(writer.pid > 0, true, '必须记录到真实 OS 进程号')
  assert.equal(writer.exitCode, 0, '进程 A 必须正常退出（退出码 0），证明进程已结束')
  assert.equal(writer.json.ok, true, `子进程 A 写入失败: ${writer.json.message ?? ''}`)
  assert.equal(writer.json.revision, 3, '子进程 A 应写到 revision=3')
  assert.equal(writer.json.pid, writer.pid, '子进程自报 PID 必须与父进程记录一致，证明是真实 OS 进程')
  // 进程已退出的证据：子进程自报 pid 后，close 事件带来的 exitCode=0；
  // 注意 Windows 上进程退出后 PID 可能被复用，`kill(pid,0)` 不可靠，因此不用它作判据。

  // 进程 B：全新独立进程，重开同一 DB
  const reader = await run(readerScript, [])
  assert.notEqual(reader.pid, process.pid, '恢复方必须是独立进程')
  assert.notEqual(reader.pid, writer.pid, '恢复方必须是另一个进程')
  assert.equal(reader.json.ok, true, `子进程 B 恢复失败: ${reader.json.message ?? ''}`)

  assert.equal(reader.json.readRevision, 3, '进程 B 必须读到进程 A 最后写入的 revision=3')
  assert.equal(reader.json.elapsedGameMs, writer.json.elapsedGameMs, '虚拟时间必须跨进程一致')
  assert.equal(reader.json.rngState, writer.json.rngState, 'RNG 状态必须跨进程一致')
  assert.deepEqual(reader.json.state, writer.json.state, '棋盘必须跨进程一致')

  assert.equal(reader.json.continuedOk, true, '进程 B 继续保存应成功')
  assert.equal(reader.json.continuedRevision, 4, 'revision 必须接着库内值递增到 4，不得回退')

  await fs.rm(tmp, { recursive: true, force: true })
})

test('P6-9 并发竞争：两个独立进程持相同 expectedRevision，只有一个能提交', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-race-'))
  const dbPath = path.join(tmp, 'saves.db')
  const racerScript = path.join(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures'),
    'checkpoint-racer.mjs',
  )

  const runRacer = (operationId, expectedRevision) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [racerScript, dbPath, REPO_ROOT, String(expectedRevision), operationId],
        { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => {
        out += c
      })
      child.stderr.on('data', (c) => {
        err += c
      })
      child.on('error', reject)
      child.on('close', (code) => {
        const last = out.trim().split(/\r?\n/).pop()
        try {
          resolve({ json: JSON.parse(last), code, err, pid: child.pid })
        } catch {
          reject(new Error(`racer 输出非 JSON (exit ${code}): ${out} ${err}`))
        }
      })
    })

  // 两个独立进程同时以 expectedRevision=0 抢写同一存档。
  // 锁忙期间各自有界重试（复用同一 operationId），最终必然一个成功、另一个见到版本冲突。
  const [a, b] = await Promise.all([
    runRacer('race-op-a', 0),
    runRacer('race-op-b', 0),
  ])

  assert.notEqual(a.pid, b.pid, '必须是两个不同进程')
  const winners = [a.json, b.json].filter((r) => r.ok === true)
  const losers = [a.json, b.json].filter((r) => r.ok === false)

  assert.equal(winners.length, 1, `必须恰好一个成功，实际: ${JSON.stringify([a.json, b.json])}`)
  assert.equal(losers.length, 1, '必须恰好一个被拒绝')
  assert.equal(winners[0].revision, 1, '成功方 revision 应为 1')
  // 按 PM 固定口径：取得锁后版本变化必须是 STALE_RUNTIME；
  // 失败方若停在 RATE_LIMIT，说明重试预算不足或锁未被释放，属测试前提未满足，不能放行。
  assert.equal(
    losers[0].finalCode,
    'STALE_RUNTIME',
    `失败方最终必须是版本冲突（不是锁忙），实际: ${JSON.stringify(losers[0])}`,
  )
  assert.equal(
    losers[0].hasCurrentRevision,
    true,
    'STALE_RUNTIME 应回带 currentRevision 供上层重读',
  )

  // 库内只能有一条记录，且 revision 是 1，未被覆盖成 2
  const { store } = await createPersistentHostStore(dbPath)
  const read = await store.readCheckpoint(GAME_ID, 'save-cross', {
    playerId: PLAYER_ID,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: [COMMIT],
  })
  assert.equal(read.ok, true)
  assert.equal(read.save.revision, 1, '并发后库内 revision 必须仍为 1')

  await fs.rm(tmp, { recursive: true, force: true })
})

test('P6-9b 事务未取得锁：必须返回 RATE_LIMIT、不带 currentRevision、且不产生第二条写入', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-lockbusy-'))
  const dbPath = path.join(tmp, 'saves.db')
  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const holderScript = path.join(fixturesDir, 'lock-holder.mjs')

  // 先建立合法存档（revision=1），确保"锁忙不会产生第二条写入"可被观测
  const { store } = await createPersistentHostStore(dbPath)
  const first = await store.writeCheckpoint({
    playerId: PLAYER_ID,
    gameId: GAME_ID,
    saveId: 'save-lock',
    operationId: 'lock-op-1',
    expectedRevision: 0,
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: 10,
    rngState: 'aa',
    modelBindings: {},
    state: { step: 1 },
  })
  assert.equal(first.ok, true)
  assert.equal(first.revision, 1)

  // 子进程持排他锁 1200ms
  const holder = spawn(process.execPath, [holderScript, dbPath, '1200'], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let holderOut = ''
  holder.stdout.on('data', (c) => {
    holderOut += c
  })

  try {
    // 等它真正拿到锁
    await new Promise((resolve) => setTimeout(resolve, 250))

    const blocked = await store.writeCheckpoint({
      playerId: PLAYER_ID,
      gameId: GAME_ID,
      saveId: 'save-lock',
      operationId: 'lock-op-2',
      expectedRevision: 1,
      generation: 1,
      activeGeneration: 1,
      isSealed: false,
      installedCommit: COMMIT,
      gameStateSchemaVersion: 1,
      elapsedGameMs: 20,
      rngState: 'bb',
      modelBindings: {},
      state: { step: 2 },
    })

    assert.equal(blocked.ok, false, '锁被他人持有时不得写入成功')
    assert.equal(blocked.code, 'RATE_LIMIT', `锁忙应返回 RATE_LIMIT，实际: ${blocked.code}`)
    assert.equal(
      Object.hasOwn(blocked, 'currentRevision'),
      false,
      '锁忙时没有读到可信 revision，不得回带 currentRevision',
    )

    // 锁释放后再确认：库内仍是 revision=1、内容未被第二条写入覆盖
    await new Promise((resolve, reject) => {
      holder.on('close', resolve)
      holder.on('error', reject)
    })
    const after = await store.readCheckpoint(GAME_ID, 'save-lock', {
      playerId: PLAYER_ID,
      currentSaveFormatVersion: 1,
      supportedGameStateVersions: [1],
      installedCommits: [COMMIT],
    })
    assert.equal(after.ok, true)
    assert.equal(after.save.revision, 1, '锁忙被拒后库内 revision 不得变化')
    assert.deepEqual(after.save.state, { step: 1 }, '锁忙被拒后内容不得被覆盖')
    assert.match(holderOut, /"held":true/, '锁持有子进程应确认已持锁')
  } finally {
    holder.kill()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('P6-10 幂等：同一 operationId 重放返回原 revision，不新增；同 op 不同内容被拒绝', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p6-idem-'))
  const dbPath = path.join(tmp, 'saves.db')
  const { store } = await createPersistentHostStore(dbPath)

  const base = {
    playerId: PLAYER_ID,    gameId: GAME_ID,
    saveId: 'save-idem',
    operationId: 'op-replay',
    generation: 1,
    activeGeneration: 1,
    isSealed: false,
    installedCommit: COMMIT,
    gameStateSchemaVersion: 1,
    elapsedGameMs: 500,
    rngState: 'ab',
    modelBindings: {},
    state: { turn: 1 },
  }

  const first = await store.writeCheckpoint({ ...base, expectedRevision: 0 })
  assert.equal(first.ok, true)
  assert.equal(first.revision, 1)
  assert.equal(first.idempotentReplay, false, '首次写入必须明确标记非重放')

  // 同 operationId、同内容重放：必须返回原 revision，不得 +1，且标记 idempotentReplay
  const replay = await store.writeCheckpoint({ ...base, expectedRevision: 1 })
  assert.equal(replay.ok, true)
  assert.equal(replay.revision, 1, '幂等重放必须返回原 revision，不得 +1')
  assert.equal(replay.idempotentReplay, true, '幂等重放必须回传 idempotentReplay=true（契约强断言）')

  // 同 operationId、不同内容：必须拒绝
  const conflict = await store.writeCheckpoint({
    ...base,
    expectedRevision: 1,
    state: { turn: 999 },
  })
  assert.equal(conflict.ok, false, '同 operationId 不同内容必须拒绝')
  assert.equal(conflict.code, 'PROTOCOL_INVALID')

  await fs.rm(tmp, { recursive: true, force: true })
})

test('P6-7 跨 commit 恢复：未安装的提交必须判不兼容', async () => {
  const { entry, approval } = await buildFixture()
  const planResult = buildInstallPlan(entry, [approval])
  assert.equal(planResult.ok, true)

  const save = {
    saveFormatVersion: 1,
    gameStateSchemaVersion: 1,
    playerId: PLAYER_ID,    gameId: GAME_ID,
    saveId: 'save-4',
    installedCommit: COMMIT,
    revision: 1,
    status: 'paused',
    elapsedGameMs: 0,
    rngState: 'c1',
    modelBindings: {},
    state: {},
    assetIds: [],
    lastAppliedOperationIds: [],
  }

  // 旧提交仍在安装目录中：兼容
  const stillInstalled = checkSaveCompatibility({
    save,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: [COMMIT],
  })
  assert.equal(stillInstalled.compatible, true)

  // 旧提交已不在安装目录：必须明确判不兼容，不能静默加载
  const gone = checkSaveCompatibility({
    save,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: ['f'.repeat(40)],
  })
  assert.equal(gone.compatible, false)
  assert.equal(gone.reason, 'unknown-game-version')

  // gameplay 结构版本不被支持：必须明确判不兼容
  const stateUnsupported = checkSaveCompatibility({
    save: { ...save, gameStateSchemaVersion: 9 },
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: [COMMIT],
  })
  assert.equal(stateUnsupported.compatible, false)
  assert.equal(stateUnsupported.reason, 'game-state-major-unsupported')
})
