/**
 * 验收项 A3：固定提交安装安全与校验（证据分栏：UNIT / MOCK）
 * 覆盖：manifestDigest 校验、bundleDigest 校验、路径逃逸、符号链接、超限拦截。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateManifestDigest,
  verifyManifestDigest,
  calculateBundleDigest,
  verifyBundleDigest,
  validateInstallSecurity,
} from '../dist/index.js'

test('A3-1: manifest 摘要篡改（字节变动）必须校验失败', () => {
  const originalManifest = JSON.stringify({ schemaVersion: 1, id: 'example.minesweeper' })
  const expectedDigest = calculateManifestDigest(originalManifest)

  const tamperedManifest = JSON.stringify({ schemaVersion: 1, id: 'example.minesweeper', evil: true })
  const res = verifyManifestDigest(tamperedManifest, expectedDigest)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.code, 'PROTOCOL_INVALID')
    assert.match(res.reason, /manifestDigest 摘要不匹配/)
  }
})

test('A3-2: bundle 文件内容被修改导致 bundleDigest 不匹配必须拒绝', () => {
  const files = [
    { path: 'dist/index.html', content: Buffer.from('<html>Hello</html>') },
    { path: 'dist/game.js', content: Buffer.from('console.log("game");') },
  ]
  const { bundleDigest } = calculateBundleDigest(files)

  // 篡改其中一个文件的内容
  const tamperedFiles = [
    { path: 'dist/index.html', content: Buffer.from('<html>Hello</html>') },
    { path: 'dist/game.js', content: Buffer.from('console.log("tampered evil code");') },
  ]
  const res = verifyBundleDigest(tamperedFiles, bundleDigest)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.code, 'PROTOCOL_INVALID')
    assert.match(res.reason, /bundleDigest 摘要不匹配/)
  }
})

test('A3-3: 缺失文件或多出未签名文件导致 bundleDigest 改变必须拒绝', () => {
  const files = [
    { path: 'dist/index.html', content: Buffer.from('<html>Hello</html>') },
    { path: 'dist/game.js', content: Buffer.from('console.log("game");') },
  ]
  const { bundleDigest } = calculateBundleDigest(files)

  // 额外夹带恶意脚本文件
  const extraFiles = [
    ...files,
    { path: 'dist/backdoor.js', content: Buffer.from('fetch("https://evil.com")') },
  ]
  const res = verifyBundleDigest(extraFiles, bundleDigest)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.code, 'PROTOCOL_INVALID')
  }
})

test('A3-4: 路径逃逸样本（..、绝对路径、盘符、UNC）必须全部被拒绝', () => {
  const escapeSamples = [
    '../escaped.js',
    '..\\escaped.js',
    'dist/../../root.js',
    '/etc/passwd',
    '\\Windows\\System32\\cmd.exe',
    'C:\\sensitive.dat',
    'D:/games/steal.js',
    'dist/./sub.js',
    'dist//double-slash.js',
    'dist/null\0byte.js',
  ]

  for (const badPath of escapeSamples) {
    const res = validateInstallSecurity([
      { path: badPath, content: Buffer.from('evil payload') },
    ])
    assert.equal(res.ok, false, `应该拒绝非法路径: ${badPath}`)
    assert.equal(res.code, 'PROTOCOL_INVALID')
  }
})

test('A3-5: 符号链接必须坚决拒绝', () => {
  const symlinkFile = {
    path: 'dist/link_to_system',
    content: Buffer.from('/etc/shadow'),
    isSymlink: true,
  }
  const res = validateInstallSecurity([symlinkFile])
  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROTOCOL_INVALID')
  assert.match(res.reason || '', /符号链接/)
})

test('A3-6: 单文件体积超限必须拒绝', () => {
  const bigFile = {
    path: 'dist/huge.bin',
    content: Buffer.alloc(1024 * 1024 * 3), // 3MB
  }
  // 限制为 2MB
  const res = validateInstallSecurity([bigFile], { maxSingleFileBytes: 2 * 1024 * 1024 })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROTOCOL_INVALID')
  assert.match(res.reason || '', /单文件 .* 大小 .* 超过上限/)
})

test('A3-7: 总包体积超限或文件数量超限必须拒绝', () => {
  const file1 = { path: 'dist/1.bin', content: Buffer.alloc(1024 * 1024) }
  const file2 = { path: 'dist/2.bin', content: Buffer.alloc(1024 * 1024) }

  // 总大小上限 1.5MB
  const resTotal = validateInstallSecurity([file1, file2], { maxTotalBytes: 1.5 * 1024 * 1024 })
  assert.equal(resTotal.ok, false)
  assert.equal(resTotal.code, 'PROTOCOL_INVALID')
  assert.match(resTotal.reason || '', /总大小 .* 超过上限/)

  // 文件数上限 1 个
  const resCount = validateInstallSecurity([file1, file2], { maxFileCount: 1 })
  assert.equal(resCount.ok, false)
  assert.equal(resCount.code, 'PROTOCOL_INVALID')
  assert.match(resCount.reason || '', /文件数 .* 超过允许上限/)
})

test('A3-8: 包含 .git / .github / node_modules 等受限敏感目录必须拒绝', () => {
  const gitHook = {
    path: '.git/hooks/pre-commit',
    content: Buffer.from('#!/bin/sh\nrm -rf /'),
  }
  const res = validateInstallSecurity([gitHook])
  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROTOCOL_INVALID')
  assert.match(res.reason || '', /受限目录/)
})
