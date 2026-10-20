/**
 * Publisher 发布工具测试（证据分栏：UNIT）
 * 覆盖：manifest 与 bundle 摘要计算、机器块正文生成与端到端解析自校验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generatePublishIssueBody,
  parseCatalogIssueBody,
} from '../dist/index.js'

test('Publisher-1: 发布工具生成符合协议规范的 Issue 正文并通过官方解析器校验', () => {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: 'example.minesweeper',
    name: '经典扫雷',
    version: '1.0.0',
    sdk: '^1.0.0',
    runtime: { kind: 'web', entry: 'dist/index.html' },
    save: { schemaVersion: 1, supportsResume: true, checkpointPolicy: 'each-action' },
    permissions: { storage: 'game-scoped', directNetwork: false },
  })

  const distFiles = [
    { path: 'dist/index.html', content: Buffer.from('<!DOCTYPE html><html><body>Minesweeper</body></html>') },
    { path: 'dist/game.js', content: Buffer.from('console.log("minesweeper loaded");') },
  ]

  const publishRes = generatePublishIssueBody({
    gameId: 'example.minesweeper',
    title: '经典扫雷',
    summary: '经典扫雷玩法，AI 生成保证可解棋盘。',
    version: '1.0.0',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
    ref: 'v1.0.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    manifestContent: manifest,
    distFiles,
  })

  assert.ok(publishRes.manifestDigest.startsWith('sha256:'))
  assert.ok(publishRes.bundleDigest.startsWith('sha256:'))
  assert.ok(publishRes.issueBody.includes('```gamecenter-json'))

  // 验证生成的 issueBody 能被 parseCatalogIssueBody 准确还原
  const parsed = parseCatalogIssueBody(publishRes.issueBody)
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.entry.gameId, 'example.minesweeper')
    assert.equal(parsed.entry.source.manifestDigest, publishRes.manifestDigest)
    assert.equal(parsed.entry.source.bundleDigest, publishRes.bundleDigest)
  }
})

test('Publisher-2: 修改任意 dist 产物文件内容必然引起 bundleDigest 变化', () => {
  const manifest = JSON.stringify({ schemaVersion: 1, id: 'example.test' })
  const files1 = [
    { path: 'dist/app.js', content: Buffer.from('let a = 1;') },
  ]
  const files2 = [
    { path: 'dist/app.js', content: Buffer.from('let a = 2;') },
  ]

  const res1 = generatePublishIssueBody({
    gameId: 'example.test',
    title: '测试',
    summary: '测试',
    version: '1.0.0',
    repository: 'https://github.com/example/test',
    ref: 'v1.0.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    manifestContent: manifest,
    distFiles: files1,
  })

  const res2 = generatePublishIssueBody({
    gameId: 'example.test',
    title: '测试',
    summary: '测试',
    version: '1.0.0',
    repository: 'https://github.com/example/test',
    ref: 'v1.0.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    manifestContent: manifest,
    distFiles: files2,
  })

  assert.notEqual(res1.bundleDigest, res2.bundleDigest)
})
