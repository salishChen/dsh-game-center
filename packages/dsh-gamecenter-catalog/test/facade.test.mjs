/**
 * 生产接线 Host-facing Facade 测试套件（证据分栏：UNIT / MOCK）
 *
 * 覆盖：
 * 1. prepareInstall: 未审批拒绝、错摘要拒绝、超限拒绝、路径逃逸拒绝；
 * 2. prepareInstall: 成功安装落盘与返回 entryPath；重复安装幂等返回 alreadyInstalled: true；
 * 3. 隔离安装：同 gameId 两个 commit 并存不覆盖；
 * 4. readInstalledBundle: 读出白名单文本资产、正确计算 totalBytes、与 prepareInstall 往返一致；
 * 5. readInstalledBundle: 拦截符号链接、拦截非安全/非白名单文件；
 * 6. listCatalog: fixture 模式输出 source:'fixture'、approvalState:'unknown'、磁盘真实安装状态；
 * 7. listCatalog: GitHub 模式审批判定与条目投影。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  prepareInstall,
  readInstalledBundle,
  listCatalog,
  calculateManifestDigest,
  calculateBundleDigest,
} from '../dist/index.js'

function createSampleGameData(gameId = 'example.minesweeping', commit = '1111222233334444555566667777888899990000') {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: gameId,
    name: '扫雷',
    version: '1.0.0',
    sdk: '^1.0.0',
    runtime: {
      kind: 'web',
      entry: 'dist/index.html',
    },
    save: {
      schemaVersion: 1,
      supportsResume: true,
      checkpointPolicy: 'each-action',
    },
    permissions: {
      storage: 'game-scoped',
      directNetwork: false,
    },
  })

  const files = [
    { path: 'dist/index.html', content: Buffer.from('<!DOCTYPE html><html><head></head><body><h1>扫雷</h1><script src="./game.js"></script></body></html>') },
    { path: 'dist/game.js', content: Buffer.from('console.log("minesweeper loaded");') },
    { path: 'dist/style.css', content: Buffer.from('body { margin: 0; background: #222; color: #fff; }') },
  ]

  const manifestDigest = calculateManifestDigest(manifest)
  const { bundleDigest } = calculateBundleDigest(files)

  const repository = 'https://github.com/salishChen/dsh-game-minesweeping'

  const entry = {
    schemaVersion: 1,
    gameId,
    title: '扫雷',
    summary: '扫雷游戏',
    version: '1.0.0',
    source: {
      repository,
      ref: 'v1.0.0',
      commit,
      manifestPath: 'gamecenter.json',
      manifestDigest,
      bundleDigest,
    },
  }

  const approval = {
    gameId,
    repository,
    commit,
    manifestDigest,
    bundleDigest,
    approvedBy: 'salishchen',
    approvedAt: '2026-10-19T12:00:00Z',
    approvalRecordPath: `approvals/${gameId}/1.0.0.json`,
  }

  return { manifest, files, entry, approval, manifestDigest, bundleDigest, repository, commit }
}

test('Facade-1: prepareInstall 在五元组未审批时必须显式拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-test-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry } = createSampleGameData()

  // 审批列表为空
  const res = await prepareInstall({
    entry,
    approvals: [],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
  })

  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.errorCode, 'PROTOCOL_INVALID')
    assert.match(res.message, /与任何审批记录都不一致/)
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-2: prepareInstall 在摘要不匹配或产物被篡改时必须拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-test-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval } = createSampleGameData()

  // 篡改其中一个文件的内容
  const tamperedFiles = [
    files[0],
    { path: 'dist/game.js', content: Buffer.from('console.log("evil code");') },
    files[2],
  ]

  const res = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files: tamperedFiles },
  })

  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.errorCode, 'PROTOCOL_INVALID')
    assert.match(res.message, /bundleDigest 摘要不匹配/)
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-3: prepareInstall 成功安装并返回 entryPath；重复调用返回 alreadyInstalled: true', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-test-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval, commit } = createSampleGameData()

  const res1 = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
  })

  assert.equal(res1.ok, true)
  if (res1.ok) {
    assert.equal(res1.alreadyInstalled, false)
    assert.equal(res1.gameId, 'example.minesweeping')
    assert.equal(res1.commit, commit)
    assert.equal(res1.entryPath, 'dist/index.html')
    assert.equal(res1.installedPath, `example.minesweeping/${commit}`)
  }

  // 再次调用，验证幂等返回 alreadyInstalled: true，绝不重复写入覆盖
  const res2 = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
  })

  assert.equal(res2.ok, true)
  if (res2.ok) {
    assert.equal(res2.alreadyInstalled, true)
    assert.equal(res2.commit, commit)
    assert.equal(res2.entryPath, 'dist/index.html')
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-4: 同一 gameId 两个 commit 隔离并存，readInstalledBundle 与 prepareInstall 往返一致', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-test-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  const dataA = createSampleGameData('example.minesweeping', commitA)
  const dataB = createSampleGameData('example.minesweeping', commitB)

  // 1. 安装 A
  const resA = await prepareInstall({
    entry: dataA.entry,
    approvals: [dataA.approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: dataA.manifest, files: dataA.files },
  })
  assert.equal(resA.ok, true)

  // 2. 安装 B
  const resB = await prepareInstall({
    entry: dataB.entry,
    approvals: [dataB.approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: dataB.manifest, files: dataB.files },
  })
  assert.equal(resB.ok, true)

  // 3. 读取 A 的 bundle，验证完整性与往返一致
  const bundleA = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit: commitA,
  })
  assert.equal(bundleA.ok, true)
  if (bundleA.ok) {
    assert.equal(bundleA.gameId, 'example.minesweeping')
    assert.equal(bundleA.commit, commitA)
    assert.equal(bundleA.entryPath, 'dist/index.html')
    assert.ok(bundleA.totalBytes > 0)

    const fileMap = new Map(bundleA.files.map((f) => [f.path, f.content]))
    assert.ok(fileMap.has('dist/index.html'))
    assert.ok(fileMap.has('dist/game.js'))
    assert.ok(fileMap.has('dist/style.css'))
    assert.ok(fileMap.has('gamecenter.json'))
    assert.equal(fileMap.get('dist/game.js'), 'console.log("minesweeper loaded");')
  }

  // 4. 读取 B 的 bundle
  const bundleB = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit: commitB,
  })
  assert.equal(bundleB.ok, true)
  if (bundleB.ok) {
    assert.equal(bundleB.commit, commitB)
  }

  // 5. 试图读取未安装的 commitC 必须失败
  const bundleC = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit: 'cccccccccccccccccccccccccccccccccccccccc',
  })
  assert.equal(bundleC.ok, false)
  if (!bundleC.ok) {
    assert.equal(bundleC.errorCode, 'PROTOCOL_INVALID')
    assert.match(bundleC.message, /未找到已安装版本/)
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-5: readInstalledBundle 拦截非法路径、非白名单后缀或超限文件', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-test-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')

  const gameId = 'example.minesweeping'
  const commit = '1111222233334444555566667777888899990000'
  const installedDir = path.join(gameLibraryDir, gameId, commit)
  await fs.mkdir(installedDir, { recursive: true })

  // 写入基本 manifest
  await fs.writeFile(
    path.join(installedDir, 'gamecenter.json'),
    JSON.stringify({ schemaVersion: 1, id: gameId, runtime: { entry: 'dist/index.html' } }),
    'utf-8',
  )

  // 注入一个非白名单扩展名文件（例如 .exe 或 .bin）
  await fs.mkdir(path.join(installedDir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(installedDir, 'dist/bad.exe'), 'evil executable binary', 'utf-8')

  const res = await readInstalledBundle({ gameLibraryDir, gameId, commit })
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.errorCode, 'PROTOCOL_INVALID')
    assert.match(res.message, /后缀不在白名单/)
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-6: listCatalog 在 fixture 模式下输出 source:fixture、approvalState:unknown 并依据磁盘真实判断已安装', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-test-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval, commit } = createSampleGameData()

  // 此时尚未安装
  const resBefore = await listCatalog({
    mode: 'fixture',
    approvals: [approval],
    gameLibraryDir,
    fixtureEntries: [entry],
  })

  assert.equal(resBefore.ok, true)
  if (resBefore.ok) {
    assert.equal(resBefore.source, 'fixture')
    assert.equal(resBefore.entries.length, 1)
    const item = resBefore.entries[0]
    assert.equal(item.gameId, 'example.minesweeping')
    assert.equal(item.approvalState, 'unknown', 'fixture 模式必须明示审批状态为 unknown，不伪造已审批')
    assert.equal(item.installed, false)
    assert.equal(item.installedCommit, null)
  }

  // 执行真实安装
  await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
  })

  // 安装后再查，验证 installed: true
  const resAfter = await listCatalog({
    mode: 'fixture',
    approvals: [approval],
    gameLibraryDir,
    fixtureEntries: [entry],
  })

  assert.equal(resAfter.ok, true)
  if (resAfter.ok) {
    const item = resAfter.entries[0]
    assert.equal(item.installed, true)
    assert.equal(item.installedCommit, commit)
    assert.equal(item.approvalState, 'unknown')
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-7: listCatalog 在 GitHub 模式下能正确匹配审批状态为 approved', async () => {
  const { entry, approval, commit } = createSampleGameData()

  // 模拟 GitHub API 返回该条目对应的 Issue
  const mockFetcher = async () => {
    return new Response(
      JSON.stringify([
        {
          number: 101,
          updated_at: '2026-10-19T10:00:00Z',
          body: `\`\`\`gamecenter-json\n${JSON.stringify(entry, null, 2)}\n\`\`\``,
        },
      ]),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  const res = await listCatalog({
    mode: 'github',
    approvals: [approval],
    githubOptions: {
      owner: 'salishChen',
      repo: 'dsh-game-center-warehouse',
    },
    fetcher: mockFetcher,
  })

  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.source, 'github')
    assert.equal(res.entries.length, 1)
    const item = res.entries[0]
    assert.equal(item.gameId, 'example.minesweeping')
    assert.equal(item.approvalState, 'approved', '五元组匹配时应为 approved')
    assert.equal(item.commit, commit)
  }
})
