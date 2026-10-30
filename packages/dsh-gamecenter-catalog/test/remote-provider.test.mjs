/**
 * 远端目录 Provider 测试（证据分栏：UNIT / MOCK）
 * 覆盖：后台载荷严格校验、非法条目跳过、展示型条目（无来源身份/机器块）不产生伪条目、
 * 整批非法拒绝、离线缓存回退、全量对账。
 * 信任根不在此验证：安装门禁仍是客户端本地 `authorizeInstall`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryCatalogCacheStore,
  RemoteCatalogProvider,
  parsePayload,
} from '../dist/index.js'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST = 'sha256:' + 'a'.repeat(64)
const BUNDLE = 'sha256:' + 'b'.repeat(64)

function makeMachine(n) {
  return {
    schemaVersion: 1,
    gameId: `example.game-${n}`,
    title: `游戏 ${n}`,
    summary: `游戏 ${n} 介绍`,
    version: '1.0.0',
    source: {
      repository: 'https://github.com/example/game',
      ref: 'v1.0.0',
      commit: COMMIT,
      manifestPath: 'gamecenter.json',
      manifestDigest: MANIFEST,
      bundleDigest: BUNDLE,
    },
  }
}

function makeItem(n, machine = makeMachine(n)) {
  return {
    source: { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: String(n) },
    machine,
  }
}

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('Remote-1: 解析后台条目，非法机器块被跳过', async () => {
  const cache = new MemoryCatalogCacheStore()
  const seenUrls = []
  const provider = new RemoteCatalogProvider({
    baseUrl: 'https://games.example.com/v1',
    cacheStore: cache,
    fetcher: async (url) => {
      seenUrls.push(String(url))
      return jsonResponse({
        schemaVersion: 1,
        entries: [
          makeItem(1),
          makeItem(2),
          // 摘要不合法：必须被丢弃，不影响同批合法条目
          makeItem(3, {
            ...makeMachine(3),
            source: { ...makeMachine(3).source, manifestDigest: 'sha256:short' },
          }),
        ],
        nextCursor: 'p2',
      })
    },
  })

  const res = await provider.fetchEntries()
  assert.equal(res.entries.length, 2)
  assert.equal(res.entries[0].key.issueId, '1')
  assert.equal(res.entries[1].key.issueId, '2')
  assert.equal(res.nextCursor, 'p2')
  assert.equal(res.notModified, false)
  // 契约路径是 /v1/catalog（不是 /v1/games）
  assert.ok(seenUrls[0].includes('/v1/catalog'), seenUrls[0])

  const cached = await cache.load()
  assert.equal(cached.entries.length, 2)
})

test('Remote-2: 只有展示字段、没有来源身份与机器块的条目被跳过，不产生伪条目', async () => {
  const provider = new RemoteCatalogProvider({
    baseUrl: 'https://games.example.com/v1',
    fetcher: async () =>
      jsonResponse({
        schemaVersion: 1,
        entries: [
          { gameId: 'example.display-only', title: '只有展示', version: '1.0.0', approvalState: 'approved' },
          makeItem(1),
        ],
      }),
  })

  const res = await provider.fetchEntries()
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].entry.gameId, 'example.game-1')
})

test('Remote-3: 整批条目全部非法时按协议错误失败，不伪装成空目录', async () => {
  const provider = new RemoteCatalogProvider({
    baseUrl: 'https://games.example.com/v1',
    fetcher: async () => jsonResponse({ schemaVersion: 1, entries: [makeItem(1, { nope: true })] }),
  })

  let error
  try {
    await provider.fetchEntries()
  } catch (err) {
    error = err
  }
  assert.equal(error?.code, 'PROTOCOL_INVALID')
})

test('Remote-4: 后台不可达时回退缓存并标记 offline', async () => {
  const cache = new MemoryCatalogCacheStore()
  const parsed = parsePayload({ schemaVersion: 1, entries: [makeItem(1), makeItem(2)] })
  assert.equal(parsed.ok, true)
  await cache.save({ entries: parsed.entries, fetchedAt: '2026-10-22T08:00:00.000Z', etag: '"etag-1"' })

  const provider = new RemoteCatalogProvider({
    baseUrl: 'https://games.example.com/v1',
    cacheStore: cache,
    fetcher: async () => {
      throw new Error('connect ETIMEDOUT')
    },
  })

  const res = await provider.fetchEntries()
  assert.equal(res.offline, true)
  assert.equal(res.notModified, true)
  assert.equal(res.entries.length, 2)
  // 离线回退必须是明确的"后台不可达"，而不是含糊的 INTERNAL 兜底码
  assert.equal(res.error.code, 'CATALOG_UNREACHABLE')
})

test('Remote-6: 只有 raw 没有 machine 时以 raw 代替，仍然走同一解析器', async () => {
  const provider = new RemoteCatalogProvider({
    baseUrl: 'https://games.example.com/v1',
    fetcher: async () =>
      jsonResponse({
        schemaVersion: 1,
        entries: [
          {
            source: { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '9' },
            raw: makeMachine(9),
          },
        ],
      }),
  })

  const res = await provider.fetchEntries()
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].entry.gameId, 'example.game-9')
  assert.deepEqual(res.entries[0].raw, makeMachine(9))
})

test('Remote-5: reconcile 区分新增、更新与移除', async () => {
  const provider = new RemoteCatalogProvider({
    baseUrl: 'https://games.example.com/v1',
    fetcher: async () => jsonResponse({ schemaVersion: 1, entries: [makeItem(1), makeItem(3)] }),
  })

  const res = await provider.reconcile([
    { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '1' },
    { forge: 'github', owner: 'example', repo: 'game-catalog', issueId: '2' },
  ])

  assert.deepEqual(res.added.map((e) => e.key.issueId), ['3'])
  assert.deepEqual(res.updated.map((e) => e.key.issueId), ['1'])
  assert.deepEqual(res.removed.map((k) => k.issueId), ['2'])
})
