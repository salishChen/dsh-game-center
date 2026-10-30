import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  GameCenterCore,
  defineGameCenterService,
  GameCenterService,
  calculateManifestDigest,
  calculateBundleDigest,
  fetchCommitArtifacts,
  ARTIFACT_TOTAL_TIMEOUT_MS,
  readReportDownloadFailEnv,
} from '../staging/remote/game-center-service.js'

const T0 = Date.parse('2026-10-18T00:00:00.000Z')

function makeCore(overrides = {}) {
  let generation = 0
  return new GameCenterCore({
    nowMs: () => T0,
    ttlMs: 30_000,
    createToken: () => 'tok-1',
    digestToken: (t) => `sha256:${t}`,
    nextGeneration: () => { generation += 1; return generation },
    ...overrides,
  })
}

test('ctx 缺失 effect 时显式抛出 TypeError，严禁静默空转', () => {
  const core = makeCore()
  assert.throws(() => defineGameCenterService(core, {}), TypeError)
  assert.throws(() => defineGameCenterService(core, { effect: 'not-a-function' }), TypeError)
})

test('装配后服务绑定 gameCenter 命名空间', () => {
  const root = new Context()
  const core = makeCore()
  const service = defineGameCenterService(core, root)
  assert.ok(service)
  assert.equal(service.name, 'gameCenter')
  assert.equal(service.typertRemote.namespace, 'gameCenter')
  assert.equal(service.typertRemote.serviceKey, 'gameCenter')
})

test('全部 15 个方法都被真实 @Remote 装饰器标记（否则 Gateway 不会暴露）', () => {
  const root = new Context()
  const core = makeCore()
  const service = defineGameCenterService(core, root)
  assert.ok(service)
  const methods = remoteMethods(service).map((m) => m.exportName ?? m.method).sort()
  assert.deepEqual(methods, [
    'abandonRuntime',
    'aiGenerate',
    'setAiBinding',
    'suspendRuntime',
    'resumeRuntime',
    'cancelAi',
    'landlordAction',
    'walletStatus',
    'walletAction', 'arenaAction',
    'catalogInstall',
    'catalogUninstall',
    'catalogList',
    'gameBundle',
    'handshake',
    'leaseStatus',
    'mediaFetch',
    'modelCatalog',
    'pause',
    'previewBundle',
    'previewList',
    'saveAck',
    'saveCheckpoint',
    'saveLatest',
  ].sort())
})

test('handshake 下发 generation 与 runtimeToken，并生成运行凭证摘要', () => {
  const root = new Context()
  const core = makeCore()
  const service = defineGameCenterService(core, root)

  const first = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n1', gameId: 'example.game',
    gameVersion: '1.0.0', sdkVersion: '1.0.0', bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(first.ok, true)
  assert.equal(first.generation, 1)
  assert.equal(first.runtimeToken, 'tok-1')
  assert.equal(first.tokenDigest, 'sha256:tok-1')
})

test('bridgeVersion 不是 1 时拒绝握手', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  const result = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n', gameId: 'g',
    gameVersion: '1', sdkVersion: '1', bridgeVersion: 2,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'PROTOCOL_INVALID')
})

test('saveAck 形状：凭证 + revision → 当前代次接受，旧代次或无效凭证拒绝', async () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)

  const hs = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n', gameId: 'g',
    gameVersion: '1', sdkVersion: '1', bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(hs.ok, true)

  const paused = service.pause({ runtimeToken: hs.runtimeToken, reason: 'overlay-closed' })
  assert.equal(paused.accepted, true)
  assert.equal(paused.state, 'pausing')
  assert.equal(paused.timeoutMs, 3000)

  const stale = await service.saveAck({ runtimeToken: 'invalid-token', revision: 1 })
  assert.equal(stale.accepted, false)
  assert.equal(stale.error.code, 'PROTOCOL_INVALID')

  const ok = await service.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 })
  assert.equal(ok.accepted, true)
  assert.equal(ok.state, 'paused')
  assert.equal(ok.lastPersistedRevision, 1)
})

test('暂停后 pause 幂等；未握手就 pause 返回状态错误', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  const hs = service.handshake({
    runtimeInstanceId: 'rt-1', nonce: 'n', gameId: 'g',
    gameVersion: '1', sdkVersion: '1', bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(service.pause({ runtimeToken: hs.runtimeToken, reason: 'a' }).accepted, true)
  assert.equal(service.pause({ runtimeToken: hs.runtimeToken, reason: 'b' }).accepted, true)
  assert.equal(service.pause({ runtimeToken: 'invalid', reason: 'c' }).error.code, 'PROTOCOL_INVALID')
})

test('leaseStatus 对不存在的存档返回 absent，不编造状态', () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root)
  assert.deepEqual(service.leaseStatus({ runtimeToken: 'nope' }), { absent: true })
})

test('modelCatalog 是最后一个参数为 AbortSignal 的零 wire 参数方法', async () => {
  const root = new Context()
  root.provide('llm')
  root.llm = {
    async listProviders() { return ['p'] },
    async listModels() { return [{ id: 'm' }] },
  }
  const service = defineGameCenterService(makeCore(), root)

  assert.equal(service.modelCatalog.length, 1, 'wire 参数为 0，末尾只留 signal 位')

  const controller = new AbortController()
  const result = await service.modelCatalog(controller.signal)
  assert.equal(result.available, true)
  assert.equal(result.entries.length, 1)

  controller.abort()
  const aborted = await service.modelCatalog(controller.signal)
  assert.equal(aborted.available, false, '已取消的调用不得继续读目录')
})

test('catalogList 生产默认 github 模式：传递 githubOptions (salishChen/dsh-game-center-warehouse) 并支持匿名只读', async () => {
  const root = new Context()
  let capturedOptions = null
  const service = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    catalogFetcher: async (url, opts) => {
      capturedOptions = { url, opts }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => [],
      }
    },
  })
  assert.equal(service.catalogMode, 'github')
  assert.deepEqual(service.catalogRepo, { owner: 'salishChen', repo: 'dsh-game-center-warehouse' })

  const res = await service.catalogList({refresh:true})
  assert.equal(res.ok, true)
  assert.equal(res.source, 'github')
  assert.ok(capturedOptions)
  assert.match(capturedOptions.url, /repos\/salishChen\/dsh-game-center-warehouse\/issues/)
  // 匿名只读：未配置 token 时不得携带 Authorization 头
  assert.equal(capturedOptions.opts?.headers?.authorization, undefined)
})

test('catalogList 生产异常显式返回：GitHub API 错误时明确返回 HTTP 状态与错误码，不静默回退', async () => {
  const root = new Context()
  const service = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    catalogFetcher: async () => {
      return {
        ok: false,
        status: 403,
        headers: new Map([
          ['content-type', 'application/json'],
          ['x-ratelimit-remaining', '0'],
        ]),
        json: async () => ({ message: 'API rate limit exceeded' }),
      }
    },
  })

  const res = await service.catalogList({refresh:true})
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'RATE_LIMIT')
  assert.match(res.message, /403/)
})

test('catalogInstall 严格审批匹配：请求成功但列表里没有该提交，坚决拒绝为 UNAPPROVED_RELEASE', async () => {
  const root = new Context()
  let fetchCalled = false
  const service = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    approvals: [], // 空审批列表
    catalogBaseUrl: 'http://lan.example:18080/v1',
    catalogFetcher: async () => {
      fetchCalled = true
      // 必须是"请求成功 + 合法 JSON + 空列表"：这样才证明拒绝的原因是"没有匹配条目"，
      // 而不是"根本连不上后台"（后者现在是 CATALOG_UNREACHABLE）。
      return {
        ok: true,
        status: 200,
        json: async () => ({ versions: [] }),
      }
    },
  })

  const res = await service.catalogInstall({
    gameId: 'example.minesweeping',
    commit: '1111222233334444555566667777888899990000',
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    bundleDigest: 'sha256:' + 'b'.repeat(64),
  })

  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'UNAPPROVED_RELEASE')
  assert.match(res.message, /未找到游戏 example.minesweeping 对应提交.*的审批记录/)
  assert.equal(fetchCalled, true, '远端模式必须先向后台核对审批状态')
})

test('fetchCommitArtifacts 严格校验 40 位小写十六进制 SHA，拒绝 HEAD 或分支名', async () => {
  const res1 = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: 'main',
  })
  assert.equal(res1.ok, false)
  assert.equal(res1.errorCode, 'PROTOCOL_INVALID')
  assert.match(res1.message, /必须为 40 位小写十六进制 SHA/)

  const res2 = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: 'HEAD',
  })
  assert.equal(res2.ok, false)
  assert.equal(res2.errorCode, 'PROTOCOL_INVALID')
  assert.match(res2.message, /必须为 40 位小写十六进制 SHA/)
})

test('fetchCommitArtifacts HTTP 异常显式返回 PROTOCOL_INVALID 且携带 HTTP 状态', async () => {
  const mockFetcher = async () => new Response('File Not Found', { status: 404 })
  const res = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f',
    fetcher: mockFetcher,
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'PROTOCOL_INVALID')
  assert.match(res.message, /HTTP 404/)
})

test('fetchCommitArtifacts 单文件超限边读边断主动拦截', async () => {
  const bigChunk = new Uint8Array(1024 * 1024) // 1MB
  let cancelled = false
  const stream = new ReadableStream({
    async pull(controller) {
      controller.enqueue(bigChunk)
    },
    cancel() {
      cancelled = true
    },
  })
  const mockFetcher = async () => new Response(stream, { status: 200 })

  const res = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f',
    fetcher: mockFetcher,
    maxSingleFileBytes: 512 * 1024, // 512KB 上限
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'PROTOCOL_INVALID')
  assert.match(res.message, /单文件上限/)
  assert.equal(cancelled, true, '流式超限必须主动 cancel 中断网络')
})

test('fetchCommitArtifacts 慢但可用的链路必须成功：默认总时限远大于旧的 15 秒', async () => {
  // 事故回归：大体积游戏包的 dist/game.js 曾达 14.16 MB，旧的 `timeoutMs ?? 15_000` 等于要求
  // 链路稳定跑满 ≥0.94 MB/s，跨公网到 raw.githubusercontent.com 必然踩线。
  assert.ok(
    ARTIFACT_TOTAL_TIMEOUT_MS >= 120_000,
    `默认单文件总时限必须给慢链路留足余量，当前 ${ARTIFACT_TOTAL_TIMEOUT_MS}ms`,
  )

  const slowFetcher = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (url.endsWith('/gamecenter.json')) {
      return new Response(JSON.stringify({ schemaVersion: 1, id: 'example.slow', runtime: { entry: 'dist/index.html' } }), { status: 200 })
    }
    if (url.endsWith('/dist/index.html')) {
      return new Response('<html><body>ok</body></html>', { status: 200 })
    }
    if (url.endsWith('/dist/game.js')) {
      return new Response('/* game */', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }

  const started = Date.now()
  const res = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f',
    fetcher: slowFetcher,
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(Date.now() - started < ARTIFACT_TOTAL_TIMEOUT_MS)
})

test('fetchCommitArtifacts 总时限即使注入的 fetcher 不理会 signal 也必须真的结束', async () => {
  // 历史缺陷：`direct-http.sendOnce` 完全不看 `init.signal`，外层到点 abort 之后
  // `await fetcher(...)` 依然不返回 —— 界面一直转圈，错误也不会产生。
  const hangFetcher = () => new Promise(() => {})
  const started = Date.now()
  const res = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f',
    fetcher: hangFetcher,
    timeoutMs: 150,
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'PROTOCOL_INVALID')
  assert.match(res.message, /超过总时限 \(150ms\)/)
  assert.ok(Date.now() - started < 5_000, '不能挂在永远不会返回的 fetcher 上')
})

test('fetchCommitArtifacts 错误分层：链路空闲超时与网络异常不能被叫成同一句话', async () => {
  const idleTimeoutFetcher = async () => {
    const err = new Error('直连空闲超时：15000ms 内没有任何数据（https://raw.githubusercontent.com/x）')
    err.code = 'ETIMEDOUT'
    throw err
  }
  const idle = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f',
    fetcher: idleTimeoutFetcher,
  })
  assert.equal(idle.ok, false)
  assert.match(idle.message, /链路长时间无数据/)

  const networkFetcher = async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:7080')
    err.code = 'ECONNREFUSED'
    throw err
  }
  const network = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f',
    fetcher: networkFetcher,
  })
  assert.equal(network.ok, false)
  assert.match(network.message, /拉取文件网络异常/)
})

test('fetchCommitArtifacts 支持换产物主机（镜像前缀），且前缀保留 pathname 里的原 URL', async () => {
  const urls = []
  const fetcher = async (url) => {
    urls.push(String(url))
    if (String(url).endsWith('/gamecenter.json')) {
      return new Response(JSON.stringify({ schemaVersion: 1, id: 'example.mirror', runtime: { entry: 'dist/index.html' } }), { status: 200 })
    }
    if (String(url).endsWith('/dist/index.html')) {
      return new Response('<html><body>ok</body></html>', { status: 200 })
    }
    if (String(url).endsWith('/dist/game.js')) {
      return new Response('/* game */', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }

  const rawBase = 'https://ghfast.top/https://raw.githubusercontent.com'
  const res = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-demo.git',
    commit: '3960e3f6f97b0000000000000000000000000000',
    fetcher,
    rawBase,
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(urls.length > 0, '必须真的发过请求')
  assert.ok(
    urls.every((u) => u.startsWith(`${rawBase}/salishChen/dsh-game-demo/3960e3f6f97b0000000000000000000000000000/`)),
    `镜像前缀必须被原样保留，实际：${urls[0]}`,
  )
})

test('fetchCommitArtifacts 拒绝非法产物主机前缀（非 http/https、带凭据）', async () => {
  const bad = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-demo.git',
    commit: '3960e3f6f97b0000000000000000000000000000',
    rawBase: 'ftp://mirror.example.com',
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.errorCode, 'PROTOCOL_INVALID')
  assert.match(bad.message, /只允许 http\/https/)

  const withCreds = await fetchCommitArtifacts({
    repository: 'https://github.com/salishChen/dsh-game-demo.git',
    commit: '3960e3f6f97b0000000000000000000000000000',
    rawBase: 'https://user:pass@mirror.example.com',
  })
  assert.equal(withCreds.ok, false)
  assert.match(withCreds.message, /不允许携带用户名或密码/)
})

test('catalogInstall 完整端到端：拉取固定提交产物并完成隔离安装与幂等保护', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gc-install-test-'))
  t.after(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  const commit = '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f'
  const manifestRaw = JSON.stringify({
    schemaVersion: 1,
    id: 'example.minesweeping',
    name: '扫雷',
    version: '1.0.0',
    runtime: { entry: 'dist/index.html' },
  })
  const indexHtml = '<!DOCTYPE html><html><head><title>Minesweeper</title></head><body><div id="game"></div></body></html>'
  const gameJs = 'console.log("minesweeper loaded");'
  const styleCss = 'body { margin: 0; }'

  const manifestDigest = calculateManifestDigest(manifestRaw)
  const bundleFiles = [
    { path: 'dist/index.html', content: Buffer.from(indexHtml) },
    { path: 'dist/game.js', content: Buffer.from(gameJs) },
    { path: 'dist/style.css', content: Buffer.from(styleCss) },
  ]
  const { bundleDigest } = calculateBundleDigest(bundleFiles)

  const approval = {
    gameId: 'example.minesweeping',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit,
    manifestDigest,
    bundleDigest,
  }

  let fetchCalls = []
  const mockFetcher = async (url) => {
    fetchCalls.push(url)
    if (url.endsWith('/gamecenter.json')) {
      return new Response(manifestRaw, { status: 200 })
    }
    if (url.endsWith('/dist/index.html')) {
      return new Response(indexHtml, { status: 200 })
    }
    if (url.endsWith('/dist/game.js')) {
      return new Response(gameJs, { status: 200 })
    }
    if (url.endsWith('/dist/style.css')) {
      return new Response(styleCss, { status: 200 })
    }
    return new Response('Not Found', { status: 404 })
  }

  const root = new Context()
  const service = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    approvals: [approval],
    gameLibraryDir: tmpDir,
    catalogFetcher: mockFetcher,
    runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
  })

  // 1. 初次安装成功
  const res = await service.catalogInstall({
    gameId: 'example.minesweeping',
    commit,
    manifestDigest,
    bundleDigest,
  })
  assert.equal(res.ok, true)
  assert.equal(res.gameId, 'example.minesweeping')
  assert.equal(res.commit, commit)
  assert.equal(res.entryPath, 'dist/index.html')

  // 磁盘文件实际存在且内容完全一致
  const installedHtml = await fs.promises.readFile(
    path.join(tmpDir, 'example.minesweeping', commit, 'dist/index.html'),
    'utf-8',
  )
  assert.equal(installedHtml, indexHtml)

  // 2. 再次调用幂等返回 alreadyInstalled: true 且不再发网络请求
  const callCountBefore = fetchCalls.length
  const res2 = await service.catalogInstall({
    gameId: 'example.minesweeping',
    commit,
    manifestDigest,
    bundleDigest,
  })
  assert.equal(res2.ok, true)
  assert.equal(res2.alreadyInstalled, true)
  assert.equal(fetchCalls.length, callCountBefore, '幂等安装不重复发起网络请求')
})

test('catalogInstall 摘要篡改负例：远端产物被篡改导致权威摘要校验失败', async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gc-install-tamper-'))
  t.after(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  const commit = '8d415d8c002b3f8d33ad819a90afbbebd49c3f8f'
  const manifestRaw = JSON.stringify({
    schemaVersion: 1,
    id: 'example.minesweeping',
    name: '扫雷',
    version: '1.0.0',
  })
  const manifestDigest = calculateManifestDigest(manifestRaw)
  const bundleDigest = 'sha256:' + 'e'.repeat(64) // 预设未篡改前的摘要

  const approval = {
    gameId: 'example.minesweeping',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit,
    manifestDigest,
    bundleDigest,
  }

  // 返回被注入恶意代码的 game.js，导致 bundleDigest 不匹配
  const mockFetcher = async (url) => {
    if (url.endsWith('/gamecenter.json')) return new Response(manifestRaw, { status: 200 })
    if (url.endsWith('/dist/index.html')) return new Response('<html></html>', { status: 200 })
    if (url.endsWith('/dist/game.js')) return new Response('malicious_code()', { status: 200 })
    return new Response('Not Found', { status: 404 })
  }

  const root = new Context()
  const service = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    approvals: [approval],
    gameLibraryDir: tmpDir,
    catalogFetcher: mockFetcher,
    runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
  })

  const res = await service.catalogInstall({
    gameId: 'example.minesweeping',
    commit,
    manifestDigest,
    bundleDigest,
  })

  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'PROTOCOL_INVALID')
  assert.match(res.message, /bundleDigest 摘要不匹配/)
})

test('可选存档能力感知：未声明 save 能力的游戏调用 saveLatest/saveCheckpoint/saveAck 均返回 SAVE_UNSUPPORTED', async () => {
  const root = new Context()
  const manifestNoSave = {
    schemaVersion: 1,
    id: 'game.no-save',
    name: '无存档游戏',
    version: '1.0.0',
    // 明确无 save 字段
  }

  const service = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    manifestResolver: async (gameId) => {
      if (gameId === 'game.no-save') return manifestNoSave
      return null
    },
  })

  // 1. saveLatest 判定为 SAVE_UNSUPPORTED
  const latestRes = await service.saveLatest({
    gameId: 'game.no-save',
    saveId: 'save-default',
  })
  assert.equal(latestRes.ok, false)
  assert.equal(latestRes.errorCode, 'SAVE_UNSUPPORTED')
  assert.match(latestRes.message, /未声明存档能力/)

  // 2. 握手与检查点
  const hs = service.handshake({
    runtimeInstanceId: 'rt-no-save-1',
    nonce: 'n1',
    gameId: 'game.no-save',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(hs.ok, true)

  const cpRes = await service.saveCheckpoint({
    runtimeToken: hs.runtimeToken,
    operationId: 'op-1',
    expectedRevision: 0,
    elapsedGameMs: 100,
    rngState: 'rng-1',
    state: { score: 10 },
  })
  assert.equal(cpRes.ok, false)
  assert.equal(cpRes.errorCode, 'SAVE_UNSUPPORTED')
  assert.equal(cpRes.retryable, false)

  // 3. saveAck 判定为 SAVE_UNSUPPORTED
  const ackRes = await service.saveAck({
    runtimeToken: hs.runtimeToken,
    revision: 1,
  })
  assert.equal(ackRes.accepted, false)
  assert.equal(ackRes.error.code, 'SAVE_UNSUPPORTED')
})

test('aiGenerate 两态门禁与受控成功路径：默认未授权不可用，注入受控 Broker 成功执行独立 AI fixture', async () => {
  const root = new Context()
  const manifest = {
    schemaVersion: 1,
    id: 'example.ai-fixture',
    name: '扫雷',
    version: '1.0.0',
    ai: {
      slots: {
        boardGeneration: {
          required: false,
          operation: 'chat.generate',
        },
      },
    },
  }

  // 1. 默认未配置 aiBroker 时：零网络、返回 CAPABILITY_UNAVAILABLE
  const defaultService = defineGameCenterService(makeCore(), root, {
    playerId: 'test-player',
    manifestResolver: async () => manifest,
  })

  const hs1 = defaultService.handshake({
    runtimeInstanceId: 'rt-ai-1',
    nonce: 'n1',
    gameId: 'example.ai-fixture',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(hs1.ok, true)

  const unauthRes = await defaultService.aiGenerate({
    runtimeToken: hs1.runtimeToken,
    operationId: 'op-ai-1',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 10 },
  })
  assert.equal(unauthRes.ok, false)
  assert.equal(unauthRes.errorCode, 'CAPABILITY_UNAVAILABLE')
  assert.match(unauthRes.message, /AI 生成能力暂不可用/)

  // 2. 注入受控 Broker：成功路径、幂等回放与未声明 slot 拒绝
  let brokerCalls = 0
  const fakeBroker = async (slot, input, signal) => {
    brokerCalls += 1
    if (signal?.aborted) throw new Error('aborted')
    // 返回合规扫雷无猜棋盘数据
    return {
      rows: (input).rows,
      cols: (input).cols,
      mines: [
        { row: 0, col: 0 },
        { row: 1, col: 1 },
      ],
      minesCount: 2,
    }
  }

  const root2 = new Context()
  const controlledService = defineGameCenterService(makeCore(), root2, {
    playerId: 'test-player',
    manifestResolver: async () => manifest,
    aiBroker: fakeBroker,
  })

  const hs2 = controlledService.handshake({
    runtimeInstanceId: 'rt-ai-2',
    nonce: 'n2',
    gameId: 'example.ai-fixture',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })

  // 2.1 成功调用
  const successRes = await controlledService.aiGenerate({
    runtimeToken: hs2.runtimeToken,
    operationId: 'op-ai-2',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 2 },
  })
  assert.equal(successRes.ok, true)
  assert.equal(successRes.output.rows, 9)
  assert.equal(successRes.output.mines.length, 2)
  assert.equal(brokerCalls, 1)

  // 2.2 幂等回放：相同 operationId + 相同 input 直接返回缓存，不重复调 Broker
  const replayRes = await controlledService.aiGenerate({
    runtimeToken: hs2.runtimeToken,
    operationId: 'op-ai-2',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 2 },
  })
  assert.equal(replayRes.ok, true)
  assert.equal(brokerCalls, 1, '相同 operationId 必须幂等，不重复触发 Broker')

  // 2.3 相同 operationId 但不同 input：PROTOCOL_INVALID
  const conflictRes = await controlledService.aiGenerate({
    runtimeToken: hs2.runtimeToken,
    operationId: 'op-ai-2',
    slot: 'boardGeneration',
    input: { rows: 10, cols: 10, mines: 5 },
  })
  assert.equal(conflictRes.ok, false)
  assert.equal(conflictRes.errorCode, 'PROTOCOL_INVALID')

  // 2.4 未声明的 slot 拒绝
  const undeclaredSlotRes = await controlledService.aiGenerate({
    runtimeToken: hs2.runtimeToken,
    operationId: 'op-ai-3',
    slot: 'undeclaredSlot',
    input: {},
  })
  assert.equal(undeclaredSlotRes.ok, false)
  assert.equal(undeclaredSlotRes.errorCode, 'PROTOCOL_INVALID')
  assert.match(undeclaredSlotRes.message, /未声明 AI slot/)

  // 2.5 幂等键隔离性验证：不同 slot 或不同实例，相同的 operationId 不应串扰
  const otherSlotManifest = {
    ...manifest,
    ai: {
      slots: {
        boardGeneration: { required: false, operation: 'chat.generate' },
        hintGeneration: { required: false, operation: 'chat.generate' },
      },
    },
  }
  const multiSlotService = defineGameCenterService(makeCore(), new Context(), {
    playerId: 'test-player',
    manifestResolver: async () => otherSlotManifest,
    aiBroker: fakeBroker,
  })
  const hsMulti = multiSlotService.handshake({
    runtimeInstanceId: 'rt-ai-multi',
    nonce: 'n-multi',
    gameId: 'example.ai-fixture',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  await multiSlotService.aiGenerate({
    runtimeToken: hsMulti.runtimeToken,
    operationId: 'op-shared-id',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 2 },
  })
  const callsBeforeSlot = brokerCalls
  // 更换为 hintGeneration，即便使用相同 operationId 也必须独立执行而不误读 boardGeneration 的缓存
  await multiSlotService.aiGenerate({
    runtimeToken: hsMulti.runtimeToken,
    operationId: 'op-shared-id',
    slot: 'hintGeneration',
    input: { hint: 'find' },
  })
  assert.equal(brokerCalls, callsBeforeSlot + 1, '跨 slot 隔离：不同 slot 使用相同 operationId 不得错误回放')

  // 2.6 并发单飞防重入（Single-Flight）：在途两个相同 operationId 仅触发一次 broker，返回同一 promise 结果
  let inFlightBrokerCalls = 0
  let releaseInFlight
  const inFlightStartPromise = new Promise((r) => { releaseInFlight = r })
  let inFlightResolve
  const singleFlightBroker = async (slot, input, signal) => {
    inFlightBrokerCalls++
    return new Promise((resolve) => {
      inFlightResolve = () => resolve({ rows: 9, cols: 9, mines: [], minesCount: 0 })
      releaseInFlight()
    })
  }
  const singleFlightService = defineGameCenterService(makeCore(), new Context(), {
    playerId: 'test-player',
    manifestResolver: async () => manifest,
    aiBroker: singleFlightBroker,
  })
  const hsFlight = singleFlightService.handshake({
    runtimeInstanceId: 'rt-ai-flight',
    nonce: 'n-flight',
    gameId: 'example.ai-fixture',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  const p1 = singleFlightService.aiGenerate({
    runtimeToken: hsFlight.runtimeToken,
    operationId: 'op-flight-1',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 2 },
  })
  const p2 = singleFlightService.aiGenerate({
    runtimeToken: hsFlight.runtimeToken,
    operationId: 'op-flight-1',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 2 },
  })
  // 在途并发冲突入参必须立即被拒绝
  const pConflict = singleFlightService.aiGenerate({
    runtimeToken: hsFlight.runtimeToken,
    operationId: 'op-flight-1',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 5 },
  })
  const resConflict = await pConflict
  assert.equal(resConflict.ok, false)
  assert.equal(resConflict.errorCode, 'PROTOCOL_INVALID')
  assert.match(resConflict.message, /不同的 input 内容/)

  await inFlightStartPromise
  inFlightResolve()
  const [res1, res2] = await Promise.all([p1, p2])
  assert.equal(res1.ok, true)
  assert.equal(res2.ok, true)
  assert.equal(inFlightBrokerCalls, 1, '在途相同 operationId 并发只调用一次底层 Broker（单飞复用）')

  // 2.7 取消与中途关闭拦截：验证 Broker 实际接收到了 AbortSignal 且触发 abort 事件
  let slowBrokerResolve
  let slowBrokerSignal
  let signalAbortedFired = false
  let slowBrokerStarted
  const startedPromise = new Promise((r) => { slowBrokerStarted = r })
  const slowBroker = async (slot, input, signal) => {
    slowBrokerSignal = signal
    if (signal) {
      signal.addEventListener('abort', () => {
        signalAbortedFired = true
      })
    }
    return new Promise((resolve) => {
      slowBrokerResolve = resolve
      slowBrokerStarted()
    })
  }
  const cancelService = defineGameCenterService(makeCore(), new Context(), {
    playerId: 'test-player',
    manifestResolver: async () => manifest,
    aiBroker: slowBroker,
  })
  const hsCancel = cancelService.handshake({
    runtimeInstanceId: 'rt-ai-cancel',
    nonce: 'n-cancel',
    gameId: 'example.ai-fixture',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  const callerAc = new AbortController()
  const pendingPromise = cancelService.aiGenerate({
    runtimeToken: hsCancel.runtimeToken,
    operationId: 'op-cancel-1',
    slot: 'boardGeneration',
    input: { rows: 9, cols: 9, mines: 2 },
  }, callerAc.signal)
  await startedPromise
  assert.ok(slowBrokerSignal, '慢 Broker 必须实际接收到非空 AbortSignal')
  assert.equal(slowBrokerSignal.aborted, false)

  // 模拟关闭流程：暂停并封存实例，必须主动触发级联 abort
  cancelService.pause({ runtimeToken: hsCancel.runtimeToken, reason: 'closing' })
  assert.equal(signalAbortedFired, true, '调用 pause 必须主动触发慢 Broker 的 abort 事件')
  assert.equal(slowBrokerSignal.aborted, true, '慢 Broker 的 AbortSignal 必须被置为 aborted')

  // 释放慢 broker
  slowBrokerResolve({ rows: 9, cols: 9, mines: [], minesCount: 0 })
  const cancelRes = await pendingPromise
  assert.equal(cancelRes.ok, false)
  assert.equal(cancelRes.errorCode, 'STALE_RUNTIME')
  assert.match(cancelRes.message, /实例已作废或关闭/)
})

test('catalogUninstall: 正常卸载与运行中租约拦截', async () => {
  const root = new Context()
  const core = makeCore()
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-test-uninstall-remote-'))
  const service = defineGameCenterService(core, root, {
    playerId: 'test-player',
    gameLibraryDir: tmpRoot,
  })

  const gameId = 'example.minesweeping'
  const commit = '1111222233334444555566667777888899990000'
  const targetDir = path.join(tmpRoot, gameId, commit)
  await fs.promises.mkdir(targetDir, { recursive: true })
  await fs.promises.writeFile(path.join(targetDir, 'gamecenter.json'), '{}', 'utf-8')

  // 1. 运行中拦截：若游戏实例处于 running 态，拒绝卸载
  const hs = service.handshake({
    runtimeInstanceId: 'rt-uninst-1',
    nonce: 'n-uninst',
    gameId,
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
    saveId: 'save-default',
    launchToken: 'launch-token-0123456789abcdef0123456789',
  })
  assert.equal(hs.ok, true)

  const busyRes = await service.catalogUninstall({ gameId, commit })
  assert.equal(busyRes.ok, false)
  assert.equal(busyRes.errorCode, 'STALE_RUNTIME')
  assert.match(busyRes.message, /正在运行中/)

  // 2. 释放实例后，正常卸载指定 commit
  service.abandonRuntime({
    launchToken: 'launch-token-0123456789abcdef0123456789',
    runtimeInstanceId: 'rt-uninst-1',
  })
  const uninstRes = await service.catalogUninstall({ gameId, commit })
  assert.equal(uninstRes.ok, true)
  assert.equal(uninstRes.gameId, gameId)
  assert.equal(uninstRes.commit, commit)
  assert.equal(fs.existsSync(targetDir), false, '指定版本目录必须被清除')
})

test('§11.9 开关取值：1/true/yes/on 开启，其余一律关闭（含拼错的值）', () => {
  const saved = process.env.DSH_GAMECENTER_REPORT_DOWNLOAD_FAIL
  const cases = [
    ['1', true],
    ['true', true],
    ['TRUE', true],
    [' yes ', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['off', false],
    ['', false],
    ['maybe', false],
    ['2', false],
  ]
  try {
    for (const [raw, expected] of cases) {
      process.env.DSH_GAMECENTER_REPORT_DOWNLOAD_FAIL = raw
      assert.equal(readReportDownloadFailEnv(), expected, `值 ${JSON.stringify(raw)} 的解析结果必须安全`)
    }
    delete process.env.DSH_GAMECENTER_REPORT_DOWNLOAD_FAIL
    assert.equal(readReportDownloadFailEnv(), false, '未设变量必须是关闭')
  } finally {
    if (saved === undefined) delete process.env.DSH_GAMECENTER_REPORT_DOWNLOAD_FAIL
    else process.env.DSH_GAMECENTER_REPORT_DOWNLOAD_FAIL = saved
  }
})
