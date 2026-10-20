/**
 * 目录 Provider 测试（证据分栏：UNIT / MOCK）
 * 覆盖：GitHub PR 排除、条件请求（304）、限流响应、离线缓存保障、全量对账。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubCatalogProvider,
  MemoryCatalogCacheStore,
} from '../dist/index.js'

function makeMockIssue(number, isPR = false) {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const entry = {
    schemaVersion: 1,
    gameId: `example.game-${number}`,
    title: `游戏 ${number}`,
    summary: `游戏 ${number} 介绍`,
    version: '1.0.0',
    source: {
      repository: 'https://github.com/example/game',
      ref: 'v1.0.0',
      commit,
      manifestPath: 'gamecenter.json',
      manifestDigest: 'sha256:' + 'a'.repeat(64),
      bundleDigest: 'sha256:' + 'b'.repeat(64),
    },
  }

  const payload = {
    number,
    updated_at: '2026-10-19T10:00:00Z',
    body: `\`\`\`gamecenter-json\n${JSON.stringify(entry, null, 2)}\n\`\`\``,
  }

  if (isPR) {
    payload.pull_request = { url: `https://api.github.com/pulls/${number}` }
  }

  return payload
}

test('Provider-1: GitHub Issues 列表自动排除 Pull Request', async () => {
  const mockIssues = [
    makeMockIssue(1, false), // 正常 Issue
    makeMockIssue(2, true),  // PR，必须排除
    makeMockIssue(3, false), // 正常 Issue
  ]

  const mockFetcher = async () => {
    return new Response(JSON.stringify(mockIssues), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        etag: '"test-etag-1"',
      },
    })
  }

  const provider = new GitHubCatalogProvider({
    owner: 'example',
    repo: 'game-catalog',
    fetcher: mockFetcher,
  })

  const res = await provider.fetchEntries()
  assert.equal(res.entries.length, 2)
  assert.equal(res.entries[0].key.issueId, '1')
  assert.equal(res.entries[1].key.issueId, '3')
  assert.equal(res.notModified, false)
})

test('Provider-2: 条件请求返回 304 时返回缓存且标记 notModified: true', async () => {
  const cacheStore = new MemoryCatalogCacheStore()
  // 预置缓存
  const cachedEntry = {
    key: { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '99' },
    entry: {
      schemaVersion: 1,
      gameId: 'example.cached',
      title: '缓存游戏',
      summary: '缓存',
      version: '1.0.0',
      source: {
        repository: 'https://github.com/example/game',
        ref: 'v1.0.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        manifestPath: 'gamecenter.json',
        manifestDigest: 'sha256:' + 'a'.repeat(64),
        bundleDigest: 'sha256:' + 'b'.repeat(64),
      },
    },
    approvalState: 'unknown',
    fetchedAt: '2026-10-18T10:00:00Z',
    raw: {},
  }
  await cacheStore.save({
    entries: [cachedEntry],
    fetchedAt: '2026-10-18T10:00:00Z',
    etag: '"cached-etag"',
  })

  const mockFetcher = async (url, init) => {
    assert.equal(init?.headers?.['If-None-Match'], '"cached-etag"')
    return new Response(null, { status: 304 })
  }

  const provider = new GitHubCatalogProvider({
    owner: 'example',
    repo: 'game-catalog',
    fetcher: mockFetcher,
    cacheStore,
  })

  const res = await provider.fetchEntries({ ifNoneMatch: '"cached-etag"' })
  assert.equal(res.notModified, true)
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].key.issueId, '99')
})

test('Provider-3: 遭遇 GitHub 限流（403 / 429 且 remaining=0）时返回 RATE_LIMIT 错误', async () => {
  const mockFetcher = async () => {
    return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
      },
    })
  }

  const provider = new GitHubCatalogProvider({
    owner: 'example',
    repo: 'game-catalog',
    fetcher: mockFetcher,
  })

  await assert.rejects(
    async () => {
      await provider.fetchEntries()
    },
    (err) => {
      assert.equal(err.code, 'RATE_LIMIT')
      return true
    },
  )
})

test('Provider-4: 网络断开时触发离线降级，保留上次成功缓存，不抹掉本地数据', async () => {
  const cacheStore = new MemoryCatalogCacheStore()
  const cachedEntry = {
    key: { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '10' },
    entry: {
      schemaVersion: 1,
      gameId: 'example.offline',
      title: '离线游戏',
      summary: '离线',
      version: '1.0.0',
      source: {
        repository: 'https://github.com/example/game',
        ref: 'v1.0.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        manifestPath: 'gamecenter.json',
        manifestDigest: 'sha256:' + 'a'.repeat(64),
        bundleDigest: 'sha256:' + 'b'.repeat(64),
      },
    },
    approvalState: 'unknown',
    fetchedAt: '2026-10-18T10:00:00Z',
    raw: {},
  }
  await cacheStore.save({
    entries: [cachedEntry],
    fetchedAt: '2026-10-18T10:00:00Z',
  })

  // 模拟网络异常抛出
  const brokenFetcher = async () => {
    throw new TypeError('fetch failed: network is unreachable')
  }

  const provider = new GitHubCatalogProvider({
    owner: 'example',
    repo: 'game-catalog',
    fetcher: brokenFetcher,
    cacheStore,
  })

  const res = await provider.fetchEntries()
  assert.equal(res.notModified, true)
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].entry.gameId, 'example.offline')

  // 再次核对缓存并未被抹掉
  const currentCache = await cacheStore.load()
  assert.equal(currentCache?.entries.length, 1)
})

test('Provider-5: 对账能够准确识别新增、更新与已下架/删除条目', async () => {
  // 远端只剩下 Issue 1 (更新) 和 Issue 3 (新增)；Issue 2 已被关闭或删除
  const mockIssues = [
    makeMockIssue(1, false),
    makeMockIssue(3, false),
  ]

  const mockFetcher = async () => {
    return new Response(JSON.stringify(mockIssues), { status: 200 })
  }

  const provider = new GitHubCatalogProvider({
    owner: 'example',
    repo: 'game-catalog',
    fetcher: mockFetcher,
  })

  const knownKeys = [
    { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '1' },
    { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '2' },
  ]

  const rec = await provider.reconcile(knownKeys)
  assert.equal(rec.updated.length, 1)
  assert.equal(rec.updated[0].key.issueId, '1')

  assert.equal(rec.added.length, 1)
  assert.equal(rec.added[0].key.issueId, '3')

  assert.equal(rec.removed.length, 1)
  assert.equal(rec.removed[0].issueId, '2')
})
