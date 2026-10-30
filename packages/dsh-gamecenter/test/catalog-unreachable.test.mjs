import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { GameCenterCore, defineGameCenterService } from '../staging/remote/game-center-service.js'

/**
 * 「网络故障 ≠ 未审批」的回归用例。
 *
 * 旧行为：请求抛错只 `console.warn` 一句，然后继续往下走，最后统一返回
 * `UNAPPROVED_RELEASE`「未找到…审批记录」。断网、代理挂掉、后台重启、404
 * 全部长得一模一样，排查方向每次都被带偏。
 * 新行为：连不上 / 非 2xx ⇒ `CATALOG_UNREACHABLE`；只有请求成功且确实没有匹配条目
 * 才回 `UNAPPROVED_RELEASE`。
 */

const COMMIT = '1111222233334444555566667777888899990000'
const MANIFEST = 'sha256:' + 'a'.repeat(64)
const BUNDLE = 'sha256:' + 'b'.repeat(64)

function makeService(overrides = {}) {
  let generation = 0
  const core = new GameCenterCore({
    nowMs: () => Date.parse('2026-10-18T00:00:00.000Z'),
    ttlMs: 30_000,
    createToken: () => 'tok-1',
    digestToken: (t) => `sha256:${t}`,
    nextGeneration: () => { generation += 1; return generation },
  })
  return defineGameCenterService(core, new Context(), {
    playerId: 'test-player',
    approvals: [],
    // 置了 catalogBaseUrl 才会走远端审批校验分支
    catalogBaseUrl: 'http://lan.example:18080/v1',
    ...overrides,
  })
}

function installInput() {
  return {
    gameId: 'example.minesweeping',
    commit: COMMIT,
    manifestDigest: MANIFEST,
    bundleDigest: BUNDLE,
  }
}

test('后台不可达时返回 CATALOG_UNREACHABLE，绝不再伪装成未审批', async () => {
  const networkError = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7080'), {
      code: 'ECONNREFUSED',
    }),
  })

  const service = makeService({
    catalogFetcher: async () => {
      throw networkError
    },
  })

  const res = await service.catalogInstall(installInput())

  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'CATALOG_UNREACHABLE')
  assert.notEqual(res.errorCode, 'UNAPPROVED_RELEASE')
  assert.match(res.message, /fetch failed/)
  assert.match(res.message, /ECONNREFUSED/)
  assert.match(res.message, /不是"未审批"/)
  assert.doesNotMatch(res.message, /未找到游戏/)
})

test('后台返回非 2xx 时也报 CATALOG_UNREACHABLE（并带上状态码）', async () => {
  const service = makeService({
    catalogFetcher: async () => new Response('bad gateway', { status: 502 }),
  })

  const res = await service.catalogInstall(installInput())

  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'CATALOG_UNREACHABLE')
  assert.match(res.message, /HTTP 502/)
})

test('请求成功但没有匹配条目时，仍然是 UNAPPROVED_RELEASE（真实未审批不被误判成不可达）', async () => {
  let fetchCalled = false
  const service = makeService({
    catalogFetcher: async () => {
      fetchCalled = true
      return {
        ok: true,
        status: 200,
        json: async () => ({ versions: [] }),
      }
    },
  })

  const res = await service.catalogInstall(installInput())

  assert.equal(fetchCalled, true, '远端校验必须真的发出请求')
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'UNAPPROVED_RELEASE')
  assert.match(res.message, /未找到游戏 example.minesweeping 对应提交.*的审批记录/)
})
