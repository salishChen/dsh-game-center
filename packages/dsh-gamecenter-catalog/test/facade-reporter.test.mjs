/**
 * prepareInstall 上报转发测试（证据分栏：UNIT / MOCK）
 * 覆盖：reporter 从 facade 透传到安装器；成功报 install-ok、失败报 install-fail；
 * downloadStarted 不由 facade 触发（应由真正发起下载的调用方触发）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  prepareInstall,
  calculateManifestDigest,
  calculateBundleDigest,
} from '../dist/index.js'

function makeGame(commit = '1111222233334444555566667777888899990000') {
  const gameId = 'example.reporter'
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: gameId,
    name: '上报样例',
    version: '1.0.0',
    sdk: '^1.0.0',
    runtime: { kind: 'web', entry: 'dist/index.html' },
    permissions: { storage: 'game-scoped', directNetwork: false },
  })
  const files = [
    { path: 'dist/index.html', content: Buffer.from('<!DOCTYPE html><html><body>ok</body></html>') },
  ]
  const manifestDigest = calculateManifestDigest(manifest)
  const { bundleDigest } = calculateBundleDigest(files)
  const repository = 'https://github.com/example/reporter-game'

  return {
    manifest,
    files,
    entry: {
      schemaVersion: 1,
      gameId,
      title: '上报样例',
      summary: '上报样例',
      version: '1.0.0',
      source: { repository, ref: 'v1.0.0', commit, manifestPath: 'gamecenter.json', manifestDigest, bundleDigest },
    },
    approval: {
      gameId,
      repository,
      commit,
      manifestDigest,
      bundleDigest,
      approvedBy: 'reviewer',
      approvedAt: '2026-10-22T00:00:00Z',
      approvalRecordPath: `approvals/${gameId}.json`,
    },
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

test('FacadeReporter-1: 成功安装透传并只报 install-ok', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-report-'))
  const { manifest, files, entry, approval } = makeGame()
  const { calls, reporter } = countingReporter()

  const res = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir: path.join(tmpRoot, 'library'),
    stagingDir: path.join(tmpRoot, 'staging'),
    bundledSource: { manifestContent: manifest, files },
    reporter,
  })

  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(calls.ok, 1)
  assert.equal(calls.fail, 0)
  // 下载触发点不在 facade：避免把"已安装"误记成"开始下载"
  assert.equal(calls.download, 0)
})

test('FacadeReporter-2: 摘要被篡改时安装失败并报 install-fail', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-report-'))
  const { manifest, files, entry, approval } = makeGame()
  const { calls, reporter } = countingReporter()

  const tampered = files.map((f) => ({ ...f, content: Buffer.from('tampered') }))

  const res = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir: path.join(tmpRoot, 'library'),
    stagingDir: path.join(tmpRoot, 'staging'),
    bundledSource: { manifestContent: manifest, files: tampered },
    reporter,
  })

  assert.equal(res.ok, false)
  assert.equal(calls.fail, 1)
  assert.equal(calls.ok, 0)
})
