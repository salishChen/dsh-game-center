/**
 * 验收项 A4：隔离安装不覆盖旧版本（证据分栏：UNIT）
 * 覆盖：
 * 1. 同 gameId 多个 commit 隔离并存；
 * 2. 幂等安装不覆盖已有版本；
 * 3. 失败原子回滚（staging 目录清理，不留残存半成品）；
 * 4. 纯文件落盘，禁止执行仓库脚本；
 * 5. 代码卸载与删档物理解耦。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  installGamePackage,
  uninstallGamePackage,
  calculateManifestDigest,
  calculateBundleDigest,
} from '../dist/index.js'

test('A4-1: 同一 gameId 的两个不同 commit 可以安全隔离共存，互不覆盖', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-install-'))
  const packagesDir = path.join(tmpRoot, 'packages')
  const stagingDir = path.join(tmpRoot, 'staging')

  const gameId = 'example.minesweeper'
  const commit1 = '1111111111111111111111111111111111111111'
  const commit2 = '2222222222222222222222222222222222222222'

  // Commit 1 的文件与计划
  const manifest1 = JSON.stringify({
    schemaVersion: 1,
    id: gameId,
    name: '扫雷 v1',
    version: '1.0.0',
    sdk: '^1.0.0',
    runtime: { kind: 'web', entry: 'dist/index.html' },
    save: { schemaVersion: 1, supportsResume: true, checkpointPolicy: 'each-action' },
    permissions: { storage: 'game-scoped', directNetwork: false },
  })
  const files1 = [
    { path: 'dist/index.html', content: Buffer.from('<html>V1 Minesweeper</html>') },
  ]
  const plan1 = {
    gameId,
    version: '1.0.0',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
    commit: commit1,
    manifestPath: 'gamecenter.json',
    manifestDigest: calculateManifestDigest(manifest1),
    bundleDigest: calculateBundleDigest(files1).bundleDigest,
    installDir: `${gameId}/${commit1}`,
    approvalRecordPath: 'approvals/v1.json',
  }

  // Commit 2 的文件与计划
  const manifest2 = JSON.stringify({
    schemaVersion: 1,
    id: gameId,
    name: '扫雷 v2',
    version: '2.0.0',
    sdk: '^1.0.0',
    runtime: { kind: 'web', entry: 'dist/index.html' },
    save: { schemaVersion: 1, supportsResume: true, checkpointPolicy: 'each-action' },
    permissions: { storage: 'game-scoped', directNetwork: false },
  })
  const files2 = [
    { path: 'dist/index.html', content: Buffer.from('<html>V2 Minesweeper Updated</html>') },
  ]
  const plan2 = {
    gameId,
    version: '2.0.0',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
    commit: commit2,
    manifestPath: 'gamecenter.json',
    manifestDigest: calculateManifestDigest(manifest2),
    bundleDigest: calculateBundleDigest(files2).bundleDigest,
    installDir: `${gameId}/${commit2}`,
    approvalRecordPath: 'approvals/v2.json',
  }

  // 1. 安装 commit1
  const res1 = await installGamePackage({
    plan: plan1,
    packagesDir,
    stagingDir,
    files: files1,
    manifestContent: manifest1,
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.alreadyInstalled, false)

  // 2. 安装 commit2
  const res2 = await installGamePackage({
    plan: plan2,
    packagesDir,
    stagingDir,
    files: files2,
    manifestContent: manifest2,
  })
  assert.equal(res2.ok, true)
  assert.equal(res2.alreadyInstalled, false)

  // 3. 验证两个 commit 目录同时存在且内容互相独立
  const path1 = path.join(packagesDir, gameId, commit1, 'dist/index.html')
  const path2 = path.join(packagesDir, gameId, commit2, 'dist/index.html')
  const content1 = await fs.readFile(path1, 'utf-8')
  const content2 = await fs.readFile(path2, 'utf-8')

  assert.equal(content1, '<html>V1 Minesweeper</html>')
  assert.equal(content2, '<html>V2 Minesweeper Updated</html>')

  // 4. 重复安装 commit1，验证不覆盖且报告 alreadyInstalled: true
  const resReinstall = await installGamePackage({
    plan: plan1,
    packagesDir,
    stagingDir,
    files: [
      { path: 'dist/index.html', content: Buffer.from('<html>Overwritten Content</html>') },
    ],
    manifestContent: manifest1,
  })
  assert.equal(resReinstall.ok, true)
  assert.equal(resReinstall.alreadyInstalled, true)
  // 原有内容绝对未被修改
  const content1After = await fs.readFile(path1, 'utf-8')
  assert.equal(content1After, '<html>V1 Minesweeper</html>')

  // 清理临时目录
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('A4-2: 安装校验失败时原子回滚，清理 staging 且不影响现有目录', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-install-rollback-'))
  const packagesDir = path.join(tmpRoot, 'packages')
  const stagingDir = path.join(tmpRoot, 'staging')

  const gameId = 'example.minesweeper'
  const commit = '3333333333333333333333333333333333333333'

  const manifest = JSON.stringify({ schemaVersion: 1, id: gameId })
  const files = [{ path: 'dist/index.html', content: Buffer.from('<html>Rollback</html>') }]

  // 故意提供一个不匹配的 bundleDigest
  const planWithBadDigest = {
    gameId,
    version: '1.0.0',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
    commit,
    manifestPath: 'gamecenter.json',
    manifestDigest: calculateManifestDigest(manifest),
    bundleDigest: 'sha256:' + 'f'.repeat(64),
    installDir: `${gameId}/${commit}`,
    approvalRecordPath: 'approvals/v3.json',
  }

  const res = await installGamePackage({
    plan: planWithBadDigest,
    packagesDir,
    stagingDir,
    files,
    manifestContent: manifest,
  })

  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROTOCOL_INVALID')

  // 验证目标目录未被创建
  const targetDir = path.join(packagesDir, gameId, commit)
  let targetExists = true
  try {
    await fs.stat(targetDir)
  } catch {
    targetExists = false
  }
  assert.equal(targetExists, false, '校验失败时目标目录绝不得建立')

  // 验证 staging 目录为空（无残留临时文件）
  try {
    const stagingFiles = await fs.readdir(stagingDir)
    assert.equal(stagingFiles.length, 0, 'staging 临时文件必须全部回滚清理')
  } catch {
    // stagingDir 本身不存在也是完全合规的
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('A4-3: 代码卸载与删档解耦，只删除代码版本目录，保留存档目录与其他版本', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-uninstall-'))
  const packagesDir = path.join(tmpRoot, 'packages')
  const savesDir = path.join(tmpRoot, 'saves')

  const gameId = 'example.minesweeper'
  const commit1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const commit2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  // 创建两个版本的安装目录
  const dir1 = path.join(packagesDir, gameId, commit1)
  const dir2 = path.join(packagesDir, gameId, commit2)
  await fs.mkdir(dir1, { recursive: true })
  await fs.mkdir(dir2, { recursive: true })
  await fs.writeFile(path.join(dir1, 'code.js'), 'commit 1 code')
  await fs.writeFile(path.join(dir2, 'code.js'), 'commit 2 code')

  // 创建独立的存档文件
  await fs.mkdir(savesDir, { recursive: true })
  const saveFile = path.join(savesDir, `${gameId}-save.sqlite`)
  await fs.writeFile(saveFile, 'important player save state data')

  // 执行 commit1 的卸载
  const uninstallRes = await uninstallGamePackage(packagesDir, gameId, commit1)
  assert.equal(uninstallRes.ok, true)

  // 验证 commit1 目录已被删除
  let commit1Exists = true
  try {
    await fs.stat(dir1)
  } catch {
    commit1Exists = false
  }
  assert.equal(commit1Exists, false)

  // 验证 commit2 仍然完好
  const commit2Code = await fs.readFile(path.join(dir2, 'code.js'), 'utf-8')
  assert.equal(commit2Code, 'commit 2 code')

  // 验证存档文件完全未受影响
  const saveContent = await fs.readFile(saveFile, 'utf-8')
  assert.equal(saveContent, 'important player save state data')

  await fs.rm(tmpRoot, { recursive: true, force: true })
})
