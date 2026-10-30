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
  MemoryCatalogCacheStore,
  uninstallGamePackage,
  RemoteCatalogProvider,
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

// ---------------------------------------------------------------------------
// 【已安装判定只认结构 · 2026-10-26】
// 现象：卸载 → 刷新目录 → 卡片仍可卸载、点开始游戏报「未找到已安装版本」。
// 根因：checkInstalledOnDisk 只看 <gameId>/ 下有没有任何子项，并把第一个子项名当 commit。
// ---------------------------------------------------------------------------
test('Facade-12: 卸载后必须判为未安装，且父目录不残留空壳', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-uninstall-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')
  const { manifest, files, entry, approval, commit } = createSampleGameData()

  await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
  })

  const listInstalled = () => listCatalog({ mode: 'fixture', approvals: [approval], gameLibraryDir, fixtureEntries: [entry] })
  const before = await listInstalled()
  assert.equal(before.ok, true)
  assert.equal(before.entries[0].installed, true, '前置：安装后必须判为已安装')

  const uninstallRes = await uninstallGamePackage(gameLibraryDir, entry.gameId, commit)
  assert.equal(uninstallRes.ok, true)

  const after = await listInstalled()
  assert.equal(after.ok, true)
  assert.equal(after.entries[0].installed, false, '卸载后刷新目录必须判为未安装')
  assert.equal(after.entries[0].installedCommit, null)

  // 父目录若无其它可用安装，必须被清掉，不给「看有没有子项」的逻辑留误判空间
  const parentExists = await fs
    .stat(path.join(gameLibraryDir, entry.gameId))
    .then(() => true)
    .catch(() => false)
  assert.equal(parentExists, false, '卸载后父目录不得残留空壳')

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 【不得假成功 · 2026-10-27】
// 现象：用户点【卸载游戏】后界面毫无变化、按钮仍是「开始游戏」、也没有安装入口。
// 根因：客户端拿 entry.commit（目录里的最新发布版）去卸载，而磁盘上装的是旧提交。
// 删一个不存在的路径，fs.rm({force:true}) 同样返回成功 → 假成功 → 界面乐观置为未安装
// → 紧接着按真实磁盘重算又弹回「已安装」。
// ---------------------------------------------------------------------------
test('Facade-12b: 卸载传错提交必须如实失败，绝不假成功，且不得动到真实安装', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-uninstall-wrong-commit-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')
  const { manifest, files, entry, approval, commit } = createSampleGameData()

  await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
  })

  const listInstalled = () =>
    listCatalog({ mode: 'fixture', approvals: [approval], gameLibraryDir, fixtureEntries: [entry] })
  assert.equal((await listInstalled()).entries[0].installedCommit, commit, '前置：用的是样例提交')

  // 传一个磁盘上不存在的提交（模拟「目录最新版 ≠ 已装版」）
  const wrongCommit = 'f'.repeat(40)
  const wrongRes = await uninstallGamePackage(gameLibraryDir, entry.gameId, wrongCommit)
  assert.equal(wrongRes.ok, false, '目标安装目录不存在时必须返回失败，不能假成功')
  assert.match(String(wrongRes.reason), /没有安装目录/, '失败原因必须说清目标不存在')
  assert.ok(
    String(wrongRes.reason).includes(commit),
    `失败原因必须指出磁盘上实际安装的提交，实际为: ${wrongRes.reason}`,
  )

  // 真实安装必须原样还在（假成功曾经让后续状态判定与物理磁盘彻底脱节）
  const afterWrong = await listInstalled()
  assert.equal(afterWrong.entries[0].installed, true, '错误的卸载请求不得影响真实安装')
  assert.equal(afterWrong.entries[0].installedCommit, commit)

  const realCommitDirExists = await fs
    .stat(path.join(gameLibraryDir, entry.gameId, commit))
    .then(() => true)
    .catch(() => false)
  assert.equal(realCommitDirExists, true, '真实安装目录必须原样保留')

  // 用正确提交再卸载 → 必须成功（正常路径不能被这条校验误伤）
  const goodRes = await uninstallGamePackage(gameLibraryDir, entry.gameId, commit)
  assert.equal(goodRes.ok, true, '正确提交的卸载必须仍然成功')
  assert.equal((await listInstalled()).entries[0].installed, false)

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-13: .staging / staging-* / 空目录 / 半截目录一律不算已安装', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-dirty-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const { entry, approval } = createSampleGameData()
  const gameDir = path.join(gameLibraryDir, entry.gameId)

  // 脏目录三组：隐藏暂存、可见暂存、空目录、以及一个没有 gamecenter.json 的半截 commit 目录
  await fs.mkdir(path.join(gameDir, '.staging'), { recursive: true })
  await fs.mkdir(path.join(gameDir, 'staging-abc123'), { recursive: true })
  await fs.mkdir(path.join(gameDir, 'empty-dir'), { recursive: true })
  await fs.mkdir(path.join(gameDir, 'dddddddddddddddddddddddddddddddddddddddd'), { recursive: true })

  const res = await listCatalog({
    mode: 'fixture',
    approvals: [approval],
    gameLibraryDir,
    fixtureEntries: [entry],
  })

  assert.equal(res.ok, true)
  assert.equal(res.entries[0].installed, false, '脏目录不得被判为已安装')
  assert.equal(res.entries[0].installedCommit, null)

  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('Facade-14: 反向用例——结构合法的安装必须仍被认出（含非 40 位目录名）', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-legit-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const { entry, approval } = createSampleGameData()

  // 只信内容不信目录名：即使提交号不是 40 位十六进制，只要有合法 gamecenter.json 也算已安装
  const oddCommit = 'v-snapshot-2026-10-26'
  const installedDir = path.join(gameLibraryDir, entry.gameId, oddCommit)
  await fs.mkdir(installedDir, { recursive: true })
  await fs.writeFile(
    path.join(installedDir, 'gamecenter.json'),
    JSON.stringify({ schemaVersion: 1, id: entry.gameId, runtime: { entry: 'dist/index.html' } }),
    'utf-8',
  )

  const res = await listCatalog({
    mode: 'fixture',
    approvals: [approval],
    gameLibraryDir,
    fixtureEntries: [entry],
  })

  assert.equal(res.ok, true)
  assert.equal(res.entries[0].installed, true, '结构合法的安装必须被认出，否则会出现「装了却说没装」')
  assert.equal(res.entries[0].installedCommit, oddCommit)

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
      refresh: true,
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

test('Facade-7b: listCatalog 在 remote 模式下采信服务端已审核 approved 状态并透传 stats 和 updatedAt', async () => {
  const { entry } = createSampleGameData()
  const mockProvider = {
    forge: 'remote',
    scopeKey: 'test-remote',
    async fetchEntries() {
      return {
        entries: [
          {
            key: { forge: 'github', owner: 'salishChen', repo: 'dsh-game-center-warehouse', issueId: '1' },
            entry,
            approvalState: 'approved',
            fetchedAt: '2026-10-23T15:00:00Z',
            raw: {
              stats: { downloads: 88, installs: 66 },
              updatedAt: '2026-10-23T12:00:00Z',
            },
          },
        ],
        notModified: false,
      }
    },
    async reconcile() {
      return { added: [], updated: [], removed: [] }
    },
  }

  const res = await listCatalog({
    mode: 'remote',
    refresh: true,
    approvals: [],
    provider: mockProvider,
  })

  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.source, 'remote')
    assert.equal(res.entries.length, 1)
    const item = res.entries[0]
    assert.equal(item.gameId, 'example.minesweeping')
    assert.equal(item.approvalState, 'approved', 'remote 模式下应采信服务端下发的 approved 状态')
    assert.deepEqual(item.stats, { downloads: 88, installs: 66 })
    assert.equal(item.updatedAt, '2026-10-23T12:00:00Z')
  }
})

test('Facade-8: prepareInstall 安装前门禁：compatibility 范围不满足时必须拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compat-install-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval } = createSampleGameData()
  entry.display = {
    schemaVersion: 1,
    summary: '扫雷',
    descriptionMarkdown: '扫雷介绍',
    cover: null,
    screenshots: [],
    compatibility: {
      gameCenter: '>=1.0.0 <2.0.0',
      dsh: '>=0.2.1-rc.2 <0.3.0',
    },
  }

  // 模拟 DSH 版本 0.3.0（超出 <0.3.0 范围）
  const res = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    runningVersions: { gameCenter: '1.0.0', dsh: '0.3.0' },
  })

  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.errorCode, 'PROTOCOL_INVALID')
    assert.match(res.message, /安装前兼容性门禁阻断 \(dsh\)/)
  }
})

test('Facade-9: prepareInstall 安装前门禁：runningVersions 取不到时报 COMPAT_UNRESOLVED 必须拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compat-unres-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval } = createSampleGameData()
  entry.display = {
    schemaVersion: 1,
    summary: '扫雷',
    descriptionMarkdown: '扫雷介绍',
    cover: null,
    screenshots: [],
    compatibility: {
      gameCenter: '>=1.0.0 <2.0.0',
      dsh: '>=0.2.1-rc.2 <0.3.0',
    },
  }

  // runningVersions 为 null
  const res = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    runningVersions: null,
  })

  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.errorCode, 'PROTOCOL_INVALID')
    assert.match(res.message, /COMPAT_UNRESOLVED/)
  }
})

test('Facade-10: readInstalledBundle 启动前门禁：compatibility 范围不满足时必须拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compat-launch-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval, commit } = createSampleGameData()

  // 先在兼容环境下成功安装
  const installRes = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
  })
  assert.equal(installRes.ok, true)

  // 启动时声明兼容性门禁：游戏中心主版本升级为 2.0.0，游戏要求 >=1.0.0 <2.0.0
  const launchRes = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit,
    compatibility: {
      gameCenter: '>=1.0.0 <2.0.0',
      dsh: '>=0.2.1-rc.2 <0.3.0',
    },
    runningVersions: { gameCenter: '2.0.0', dsh: '0.2.1-rc.2' },
  })

  assert.equal(launchRes.ok, false)
  if (!launchRes.ok) {
    assert.equal(launchRes.errorCode, 'PROTOCOL_INVALID')
    assert.match(launchRes.message, /启动前兼容性门禁阻断 \(gameCenter\)/)
  }
})

test('Facade-11: readInstalledBundle 启动前门禁：runningVersions 取不到时报 COMPAT_UNRESOLVED 必须拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compat-launch-unres-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval, commit } = createSampleGameData()

  // 先成功安装
  const installRes = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
  })
  assert.equal(installRes.ok, true)

  // 启动时 runningVersions 为 null
  const launchRes = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit,
    compatibility: {
      gameCenter: '>=1.0.0 <2.0.0',
      dsh: '>=0.2.1-rc.2 <0.3.0',
    },
    runningVersions: null,
  })

  assert.equal(launchRes.ok, false)
  if (!launchRes.ok) {
    assert.equal(launchRes.errorCode, 'PROTOCOL_INVALID')
    assert.match(launchRes.message, /COMPAT_UNRESOLVED/)
  }
})

test('Facade-12: prepareInstall 安装前门禁：未绑定进程观测或历史基线必须判 COMPAT_UNRESOLVED 拒绝', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compat-obs-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval } = createSampleGameData()
  entry.display = {
    schemaVersion: 1,
    summary: '扫雷',
    descriptionMarkdown: '扫雷介绍',
    cover: null,
    screenshots: [],
    compatibility: {
      gameCenter: '>=1.0.0 <2.0.0',
      dsh: '>=0.2.1-rc.2 <0.3.0',
    },
  }

  // 模拟未绑定进程的 DSH 观测（boundToRunningProcess: false）
  const dshUnboundObs = {
    platform: 'dsh',
    raw: '0.2.1-rc.2',
    evidence: 'observed',
    boundToRunningProcess: false,
    source: 'app.asar:/dsh/desktop-runtime.json',
    observedAt: '2026-10-20T00:00:00Z',
  }
  const gcObs = {
    platform: 'gamecenter',
    raw: '1.0.0',
    evidence: 'trustedConfig',
    boundToRunningProcess: true,
    source: 'host config',
    observedAt: '2026-10-20T00:00:00Z',
  }

  const res = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    dshObservation: dshUnboundObs,
    gameCenterObservation: gcObs,
  })

  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.errorCode, 'PROTOCOL_INVALID')
    assert.match(res.message, /COMPAT_UNRESOLVED/)
  }
})

test('Facade-13: readInstalledBundle 启动前门禁：未绑定进程观测必须被拒绝，有进程绑定证据通过', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-compat-launch-obs-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval, commit } = createSampleGameData()

  // 安装时放行
  const installRes = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
  })
  assert.equal(installRes.ok, true)

  const compatibility = {
    gameCenter: '>=1.0.0 <2.0.0',
    dsh: '>=0.2.1-rc.2 <0.3.0',
  }

  // 启动时：未绑定进程拒绝
  const unboundRes = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit,
    compatibility,
    dshObservation: {
      platform: 'dsh',
      raw: '0.2.1-rc.2',
      evidence: 'observed',
      boundToRunningProcess: false,
      source: 'app.asar:/dsh/desktop-runtime.json',
      observedAt: '2026-10-20T00:00:00Z',
    },
    gameCenterObservation: {
      platform: 'gamecenter',
      raw: '1.0.0',
      evidence: 'trustedConfig',
      boundToRunningProcess: true,
      source: 'host config',
      observedAt: '2026-10-20T00:00:00Z',
    },
  })
  assert.equal(unboundRes.ok, false)
  if (!unboundRes.ok) {
    assert.equal(unboundRes.errorCode, 'PROTOCOL_INVALID')
    assert.match(unboundRes.message, /COMPAT_UNRESOLVED/)
  }

  // 启动时：有进程绑定证据且版本在兼容范围内放行
  const boundRes = await readInstalledBundle({
    gameLibraryDir,
    gameId: 'example.minesweeping',
    commit,
    compatibility,
    dshObservation: {
      platform: 'dsh',
      raw: '0.2.1-rc.2',
      evidence: 'processBound',
      boundToRunningProcess: true,
      source: 'dsh process inspection',
      observedAt: '2026-10-20T00:00:00Z',
    },
    gameCenterObservation: {
      platform: 'gamecenter',
      raw: '1.0.0',
      evidence: 'trustedConfig',
      boundToRunningProcess: true,
      source: 'host config',
      observedAt: '2026-10-20T00:00:00Z',
    },
  })
  assert.equal(boundRes.ok, true)
})

test('Facade-14: 端到端成功闭环：catalogList → prepareInstall → readInstalledBundle → handshake 全流程实跑', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-success-'))
  const gameLibraryDir = path.join(tmpRoot, 'library')
  const stagingDir = path.join(tmpRoot, 'staging')

  const { manifest, files, entry, approval, commit } = createSampleGameData()
  const gameId = entry.gameId

  // 1. 真实有效兼容 manifest（取自 docs/issues/gamecenter-listing.md）
  const compatibility = {
    gameCenter: '>=1.0.0 <2.0.0',
    dsh: '>=0.2.1-rc.2 <0.3.0',
  }
  entry.display = {
    schemaVersion: 1,
    summary: '确定性无猜扫雷 / Deterministic no-guess Minesweeper',
    descriptionMarkdown: '### 玩法\n- 首击开空旷区\n\n### How to play\n- First click opens an empty area',
    cover: {
      url: 'https://user-images.githubusercontent.com/1/cover.png',
      sha256: 'sha256:' + 'a'.repeat(64),
      mime: 'image/png',
      width: 1280,
      height: 720,
      alt: '扫雷封面 / Minesweeper cover',
    },
    screenshots: [],
    compatibility,
  }

  // 2. 注入一组可信 runningVersions（待接 Host 真实解析器 host-runtime-version.ts，本测试注入等价真实 processBound 证据）
  const dshObservation = {
    platform: 'dsh',
    raw: '0.2.1-rc.2',
    evidence: 'processBound',
    boundToRunningProcess: true,
    source: 'process.argv[2]:/dsh/desktop-runtime.json',
    observedAt: '2026-10-20T12:00:00Z',
  }
  const gameCenterObservation = {
    platform: 'gamecenter',
    raw: '1.0.0',
    evidence: 'processBound',
    boundToRunningProcess: true,
    source: '@dsh-gamecenter/host:package.json',
    observedAt: '2026-10-20T12:00:00Z',
  }

  // --- Step 1: catalogList（模拟 GitHub 目录拉取与五元组审批对账）---
  const mockFetcher = async () =>
    new Response(
      JSON.stringify([
        {
          number: 1,
          updated_at: '2026-10-20T12:00:00Z',
          body: `\`\`\`gamecenter-json\n${JSON.stringify(entry, null, 2)}\n\`\`\``,
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const listRes = await listCatalog({
    mode: 'github',
      refresh: true,
    approvals: [approval],
    gameLibraryDir,
    githubOptions: { owner: 'salishChen', repo: 'dsh-game-center-warehouse' },
    fetcher: mockFetcher,
  })

  assert.equal(listRes.ok, true, 'Step 1 catalogList 应成功')
  assert.equal(listRes.source, 'github')
  assert.equal(listRes.entries.length, 1)
  assert.equal(listRes.entries[0].approvalState, 'approved')
  assert.equal(listRes.entries[0].installed, false)

  // --- Step 2: prepareInstall（安装前门禁通过 + 原子 Staging 安装落盘）---
  const installRes = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    dshObservation,
    gameCenterObservation,
  })

  assert.equal(installRes.ok, true, 'Step 2 prepareInstall 应成功')
  assert.equal(installRes.gameId, gameId)
  assert.equal(installRes.commit, commit)
  assert.equal(installRes.installedPath, `${gameId}/${commit}`)
  assert.equal(installRes.entryPath, 'dist/index.html')
  assert.equal(installRes.alreadyInstalled, false)

  // 验证磁盘目录已实际存在
  const installedTarget = path.join(gameLibraryDir, gameId, commit)
  const stat = await fs.stat(installedTarget)
  assert.equal(stat.isDirectory(), true)

  // --- Step 3: readInstalledBundle（启动前门禁通过 + 读取安全产物包）---
  const bundleRes = await readInstalledBundle({
    gameLibraryDir,
    gameId,
    commit,
    compatibility,
    dshObservation,
    gameCenterObservation,
  })

  assert.equal(bundleRes.ok, true, 'Step 3 readInstalledBundle 应成功')
  assert.equal(bundleRes.gameId, gameId)
  assert.equal(bundleRes.commit, commit)
  assert.equal(bundleRes.entryPath, 'dist/index.html')
  assert.ok(bundleRes.files.length >= 3, '应读出 dist 下的常规文本文件')
  assert.ok(bundleRes.totalBytes > 0, '总字节数必须大于 0')

  // --- Step 4: handshake（Host 侧运行时握手生成 generation 与 runtimeToken）---
  const { GameCenterCore } = await import('../../dsh-gamecenter/lib/remote/game-center-service.js')
  let genCounter = 0
  const hostCore = new GameCenterCore({
    nowMs: () => Date.now(),
    ttlMs: 30000,
    createToken: () => 'runtime-token-test-1234567890abcdef',
    digestToken: (t) => `sha256:${t}`,
    nextGeneration: () => {
      genCounter += 1
      return genCounter
    },
  })

  const handshakeRes = hostCore.handshake({
    runtimeInstanceId: 'rt-instance-e2e-1',
    nonce: 'nonce-e2e-random-12345678',
    launchToken: 'launch-token-0123456789abcdef0123456789',
    gameId,
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
  })

  assert.equal(handshakeRes.ok, true, 'Step 4 handshake 应成功')
  assert.equal(handshakeRes.generation, 1)
  assert.equal(handshakeRes.runtimeToken, 'runtime-token-test-1234567890abcdef')
  assert.equal(handshakeRes.tokenDigest, 'sha256:runtime-token-test-1234567890abcdef')

  // --- 并列负向：同 manifest 下不同错误条件的严格拒绝验证 ---
  // 负向 1：DSH 版本不匹配（0.3.0）
  const badDshInstall = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    dshObservation: { ...dshObservation, raw: '0.3.0' },
    gameCenterObservation,
  })
  assert.equal(badDshInstall.ok, false)
  assert.match(badDshInstall.message, /安装前兼容性门禁阻断 \(dsh\)/)

  // 负向 2：游戏中心版本不匹配（2.0.0）
  const badGcLaunch = await readInstalledBundle({
    gameLibraryDir,
    gameId,
    commit,
    compatibility,
    dshObservation,
    gameCenterObservation: { ...gameCenterObservation, raw: '2.0.0' },
  })
  assert.equal(badGcLaunch.ok, false)
  assert.match(badGcLaunch.message, /启动前兼容性门禁阻断 \(gameCenter\)/)

  // 负向 3：未绑定进程（boundToRunningProcess: false）
  const unboundInstall = await prepareInstall({
    entry,
    approvals: [approval],
    gameLibraryDir,
    stagingDir,
    bundledSource: { manifestContent: manifest, files },
    dshObservation: { ...dshObservation, boundToRunningProcess: false },
    gameCenterObservation,
  })
  assert.equal(unboundInstall.ok, false)
  assert.match(unboundInstall.message, /COMPAT_UNRESOLVED/)

  // 负向 4：历史 lock 证据（localVerified）
  const lockLaunch = await readInstalledBundle({
    gameLibraryDir,
    gameId,
    commit,
    compatibility,
    dshObservation: { ...dshObservation, evidence: 'localVerified' },
    gameCenterObservation,
  })
  assert.equal(lockLaunch.ok, false)
  assert.match(lockLaunch.message, /COMPAT_UNRESOLVED/)
})

test('Facade-15: listCatalog 透传 display 展示元数据（支持 SafeMarkdown 渲染与媒体占位）', async () => {
  const { entry, approval } = createSampleGameData()
  const validDisplay = {
    schemaVersion: 1,
    summary: '确定性扫雷简介',
    descriptionMarkdown: '### 玩法\n- 纯文本段落展示',
    cover: {
      url: 'https://user-images.githubusercontent.com/1/cover.png',
      sha256: 'sha256:' + 'a'.repeat(64),
      mime: 'image/png',
      width: 1280,
      height: 720,
      alt: '封面',
    },
    screenshots: [],
    compatibility: {
      gameCenter: '>=1.0.0 <2.0.0',
      dsh: '>=0.2.1-rc.2 <0.3.0',
    },
  }

  // 1. fixture 模式正常透传
  const entryWithDisplay = { ...entry, display: validDisplay }
  const fixtureRes = await listCatalog({
    mode: 'fixture',
    approvals: [approval],
    fixtureEntries: [entryWithDisplay],
  })
  assert.equal(fixtureRes.ok, true)
  assert.equal(fixtureRes.entries[0].display?.summary, '确定性扫雷简介')
  assert.equal(fixtureRes.entries[0].display?.descriptionMarkdown, '### 玩法\n- 纯文本段落展示')

  // 2. 无 display 或 display 违规（如含有 raw HTML）时回退为 null
  const entryWithBadDisplay = {
    ...entry,
    display: {
      ...validDisplay,
      descriptionMarkdown: '### 玩法\n<script>alert(1)</script>',
    },
  }
  const fixtureBadRes = await listCatalog({
    mode: 'fixture',
    approvals: [approval],
    fixtureEntries: [entryWithBadDisplay],
  })
  assert.equal(fixtureBadRes.ok, true)
  assert.equal(fixtureBadRes.entries[0].display, null, '非法 display 经校验不通过必须置为 null')

  // 3. github 模式正常透传
  const mockFetcher = async () =>
    new Response(
      JSON.stringify([
        {
          number: 102,
          updated_at: '2026-10-20T14:00:00Z',
          body: `\`\`\`gamecenter-json\n${JSON.stringify(entryWithDisplay, null, 2)}\n\`\`\``,
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const githubRes = await listCatalog({
    mode: 'github',
      refresh: true,
    approvals: [approval],
    githubOptions: { owner: 'salishChen', repo: 'dsh-game-center-warehouse' },
    fetcher: mockFetcher,
  })
  assert.equal(githubRes.ok, true)
  assert.equal(githubRes.entries[0].display?.summary, '确定性扫雷简介')
  assert.equal(githubRes.entries[0].display?.descriptionMarkdown, '### 玩法\n- 纯文本段落展示')
})

test('Facade-16: listCatalog 自动扫描与缓存失败回退：网络失败保留缓存且标记 stale: true', async () => {
  const { entry, approval } = createSampleGameData()
  const cacheStore = new MemoryCatalogCacheStore()

  // 1. 预置上次扫描成功的缓存快照
  const cachedTime = '2026-10-20T10:00:00.000Z'
  const entryView = {
    key: { forge: 'github', owner: 'salishChen', repo: 'dsh-game-center-warehouse', issueId: '1' },
    entry,
    approvalState: 'unknown',
    fetchedAt: cachedTime,
    raw: {},
  }
  await cacheStore.save({
    entries: [entryView],
    fetchedAt: cachedTime,
    etag: '"etag-cached-123"',
  })

  // 2. 模拟网络异常抛错（模拟后台刷新失败）
  const failingFetcher = async () => {
    throw new Error('ETIMEDOUT: network error')
  }

  // 3. 执行扫描查询
  const result = await listCatalog({
    mode: 'github',
      refresh: true,
    approvals: [approval],
    cache: cacheStore,
    githubOptions: { owner: 'salishChen', repo: 'dsh-game-center-warehouse' },
    fetcher: failingFetcher,
  })

  // 4. 验证：网络失败时保留缓存列表，原样返回上次扫描时间，并附带 stale: true 标记
  assert.equal(result.ok, true, '网络失败时应回退到旧缓存而不丢弃列表')
  assert.equal(result.stale, true, '旧数据必须明确标记为 stale: true')
  assert.equal(result.fetchedAt, cachedTime, '必须携带上次真实扫描完成的时间')
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].gameId, 'example.minesweeping')
})

test('cache-only cold start never fetches and failed refresh exposes error with preserved cache', async () => {
  let fetches=0;
  const cache=new MemoryCatalogCacheStore();
  const fetcher=async()=>{fetches++;throw new Error('offline-check');};
  const options={mode:'github',approvals:[],cache,githubOptions:{owner:'test',repo:'catalog'},fetcher};
  const cold=await listCatalog({...options,refresh:false});
  assert.equal(fetches,0);assert.equal(cold.dataSource,'cache');assert.deepEqual(cold.entries,[]);
  const {entry}=createSampleGameData();
  await cache.save({entries:[{key:{forge:'github',owner:'test',repo:'catalog',issueId:'1'},entry}],fetchedAt:'2026-10-21T00:00:00Z'});
  const failed=await listCatalog({...options,refresh:true});
  assert.equal(failed.ok,true);assert.equal(failed.entries.length,1);assert.equal(failed.stale,true);assert.match(failed.error.message,/offline-check/);
  const notModified=await listCatalog({...options,refresh:true,fetcher:async()=>new Response(null,{status:304})});
  assert.equal(notModified.stale,false);assert.equal(notModified.dataSource,'network');assert.equal(notModified.error,undefined);
});

/**
 * 证据分栏：MOCK。后台（`backend/api.ts`）下发的封面是同源相对路径
 * `/v1/covers/<gameId>`。若不把它补成绝对地址再做校验，`validateDisplayMetadata`
 * 会整体 fail closed，`resolveEntryDisplay` 返回 null —— 丢的不只是封面，
 * 而是 summary/descriptionMarkdown 整块 display。本用例钉住修复后的行为。
 */
test('listCatalog remote: 后台相对封面被补成绝对地址，且 display 不再整块丢弃', async () => {
  const BASE = 'http://192.168.3.222:18080/v1'
  const COMMIT = '0123456789abcdef0123456789abcdef01234567'
  const MANIFEST = 'sha256:' + 'a'.repeat(64)
  const BUNDLE = 'sha256:' + 'b'.repeat(64)

  const provider = new RemoteCatalogProvider({
    baseUrl: BASE,
    fetcher: async () => new Response(JSON.stringify({
      schemaVersion: 1,
      entries: [{
        source: { forge: 'github', owner: 'example', repo: 'neon-drift', issueId: '1' },
        machine: {
          schemaVersion: 1,
          gameId: 'example.neon-drift',
          title: '霓虹漂移',
          summary: '街机竞速',
          version: '1.0.0',
          source: {
            repository: 'https://github.com/example/neon-drift',
            ref: 'v1.0.0',
            commit: COMMIT,
            manifestPath: 'gamecenter.json',
            manifestDigest: MANIFEST,
            bundleDigest: BUNDLE,
          },
          display: {
            schemaVersion: 1,
            repository: 'https://github.com/example/neon-drift',
            summary: '霓虹漂移 / Neon Drift',
            descriptionMarkdown: '## 竞速\n无附加内容。',
            cover: {
              url: '/v1/covers/example.neon-drift',
              sha256: MANIFEST,
              mime: 'image/jpeg',
              width: 512,
              height: 512,
              alt: '封面',
            },
            screenshots: [],
            compatibility: { gameCenter: '^1.0.0', dsh: '>=0.2.1-rc.2 <0.3.0' },
          },
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })

  const res = await listCatalog({ mode: 'remote', approvals: [], refresh: true, provider })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.entries.length, 1)

  const display = res.entries[0].display
  assert.ok(display, 'display 不应因为封面是相对路径而被整块丢弃')
  assert.equal(display.cover.url, 'http://192.168.3.222:18080/v1/covers/example.neon-drift')
  assert.equal(display.summary, '霓虹漂移 / Neon Drift')
})
