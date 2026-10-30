/**
 * Host 侧远端设置透传测试（证据分栏：UNIT）
 * 覆盖：defineGameCenterService 必须把 catalogBaseUrl / installId 透传进服务；
 * catalogMode:'remote' 且 endpoint 为空时必须静默返回空列表（契约 §3 条款 14）。
 * 这组用例是为了防住"选项在类上、但工厂把它丢了"这类静默失效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { GameCenterCore, defineGameCenterService } from '../staging/remote/game-center-service.js'

const T0 = Date.parse('2026-10-18T00:00:00.000Z')

function makeCore() {
  let generation = 0
  return new GameCenterCore({
    nowMs: () => T0,
    ttlMs: 30_000,
    createToken: () => 'tok-1',
    digestToken: (t) => `sha256:${t}`,
    nextGeneration: () => {
      generation += 1
      return generation
    },
  })
}

test('RemoteSettings-1: catalogBaseUrl 与 installId 必须透传到服务实例', () => {
  const baseUrl = 'https://games.example.com/v1'
  const installId = 'b1f0c4d2-7e35-4a1b-9a11-6c2f8d3e5a70'
  const service = defineGameCenterService(makeCore(), new Context(), {
    catalogBaseUrl: baseUrl,
    installId,
  })

  assert.equal(service.catalogBaseUrl, baseUrl)
  assert.equal(service.installId, installId)
})

test('RemoteSettings-2: 未配置时保持 undefined，不臆造默认地址', () => {
  const service = defineGameCenterService(makeCore(), new Context())
  assert.equal(service.catalogBaseUrl, undefined)
  assert.equal(service.installId, undefined)
})

test('RemoteSettings-3: catalogMode=remote 且 endpoint 为空时静默返回空列表', async () => {
  const service = defineGameCenterService(makeCore(), new Context(), {
    catalogMode: 'remote',
    gameLibraryDir: undefined,
  })

  const res = await service.catalogList({ refresh: true })
  assert.equal(res.ok, true)
  assert.equal(res.source, 'remote')
  assert.deepEqual(res.entries, [])
})
