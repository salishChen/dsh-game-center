/**
 * 安装上报接线测试（证据分栏：UNIT / MOCK）
 * 覆盖：安装失败触发 install-fail、已安装幂等不重复上报、
 * forInstall 适配器把钩子映射到正确的 kind。
 * 铁律：上报异常不得改变安装结果。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { installGamePackage, calculateManifestDigest, calculateBundleDigest } from '../dist/index.js'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function makePlan(overrides = {}) {
  return {
    gameId: 'example.game-1',
    version: '1.0.0',
    repository: 'https://github.com/example/game',
    commit: COMMIT,
    manifestPath: 'gamecenter.json',
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    bundleDigest: 'sha256:' + 'b'.repeat(64),
    installDir: `example.game-1/${COMMIT}`,
    approvalRecordPath: 'approvals/example.game-1.json',
    ...overrides,
  }
}

function countingReporter() {
  const calls = { download: 0, ok: 0, fail: 0 }
  return {
    calls,
    reporter: {
      downloadStarted: () => { calls.download += 1 },
      installSucceeded: () => { calls.ok += 1 },
      installFailed: () => { calls.fail += 1 },
    },
  }
}

test('Install-1: 安装失败触发 install-fail，上报抛错也不影响安装结果', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-install-'))
  const { calls, reporter } = countingReporter()
  const thrown = {
    installFailed: () => { calls.fail += 1; throw new Error('reporter boom') },
    installSucceeded: () => { calls.ok += 1 },
  }

  // gameId 含路径段非法字符：安装必然失败
  const res = await installGamePackage({
    plan: makePlan({ gameId: '../escape' }),
    packagesDir: path.join(root, 'packages'),
    stagingDir: path.join(root, 'staging'),
    files: [],
    manifestContent: '{}',
    reporter: thrown,
  })

  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROTOCOL_INVALID')
  assert.equal(calls.fail, 1)
  assert.equal(calls.ok, 0)

  // 正常 reporter 同样只记一次失败
  const second = countingReporter()
  await installGamePackage({
    plan: makePlan({ gameId: '../escape' }),
    packagesDir: path.join(root, 'packages'),
    stagingDir: path.join(root, 'staging'),
    files: [],
    manifestContent: '{}',
    reporter: second.reporter,
  })
  assert.equal(second.calls.fail, 1)
  assert.equal(second.calls.ok, 0)
})

test('Install-2: 已安装幂等路径不上报 install-ok', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-install-'))
  const target = path.join(root, 'packages', 'example.game-1', COMMIT)
  await fs.mkdir(target, { recursive: true })

  const { calls, reporter } = countingReporter()
  const res = await installGamePackage({
    plan: makePlan(),
    packagesDir: path.join(root, 'packages'),
    stagingDir: path.join(root, 'staging'),
    files: [],
    manifestContent: '{}',
    reporter,
  })

  assert.equal(res.ok, true)
  assert.equal(res.alreadyInstalled, true)
  assert.equal(calls.ok, 0)
  assert.equal(calls.fail, 0)
})

test('Install-4: 上报抛错但安装成功，安装结果不被改写', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-install-'))
  const gameId = 'example.report-ok'
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: gameId,
    name: '上报样例',
    version: '1.0.0',
    sdk: '^1.0.0',
    runtime: { kind: 'web', entry: 'dist/index.html' },
    permissions: { storage: 'game-scoped', directNetwork: false },
  })
  const files = [{ path: 'dist/index.html', content: Buffer.from('<html><body>ok</body></html>') }]
  const manifestDigest = calculateManifestDigest(manifest)
  const { bundleDigest } = calculateBundleDigest(files)

  let okCalls = 0
  const res = await installGamePackage({
    plan: makePlan({ gameId, manifestDigest, bundleDigest }),
    packagesDir: path.join(root, 'packages'),
    stagingDir: path.join(root, 'staging'),
    files,
    manifestContent: manifest,
    reporter: {
      installSucceeded: () => {
        okCalls += 1
        throw new Error('reporter exploded')
      },
      installFailed: () => { throw new Error('should not be called') },
    },
  })

  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(okCalls, 1)
})

test('Install-3: 没有 reporter 时安装行为完全不变', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-install-'))
  const res = await installGamePackage({
    plan: makePlan({ gameId: '../escape' }),
    packagesDir: path.join(root, 'packages'),
    stagingDir: path.join(root, 'staging'),
    files: [],
    manifestContent: '{}',
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROTOCOL_INVALID')
})
