/**
 * 上报客户端测试（证据分栏：UNIT / MOCK）
 * 覆盖：契约载荷形状、202 成功、非 2xx 失败、网络错误静默、非法输入不发送、后台入口不抛错。
 * 统计永不参与安装判定：本文件不触碰任何门禁逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteReportClient, createInstallId, sanitizeReportDetail } from '../dist/index.js'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const BASE = 'https://games.example.com/v1'
const INSTALL_ID = 'b1f0c4d2-7e35-4a1b-9a11-6c2f8d3e5a70'

function clientWith(fetcher) {
  return new RemoteReportClient({
    baseUrl: BASE,
    installId: INSTALL_ID,
    fetcher,
    client: 'dsh-gamecenter/0.1.0',
    now: () => new Date('2026-10-22T10:00:00.000Z'),
  })
}

test('Report-1: 载荷形状符合契约，不含可识别个人信息', async () => {
  const seen = []
  const client = clientWith(async (url, init) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      method: init.method,
      headers: init.headers ?? {},
    })
    return new Response(JSON.stringify({ accepted: true }), { status: 202 })
  })

  const res = await client.report('download-start', 'example.game-1', COMMIT)
  assert.equal(res.ok, true)
  assert.equal(res.status, 202)

  assert.equal(seen.length, 1)
  assert.ok(seen[0].url.endsWith('/v1/reports'), seen[0].url)
  assert.equal(seen[0].method, 'POST')
  // 契约 §3 第 4 条：/v1/reports 无凭据。没配 token 的玩家也必须能上报，请求里不允许出现 Authorization。
  assert.equal(seen[0].headers['Authorization'], undefined)
  assert.equal(seen[0].headers['authorization'], undefined)
  assert.deepEqual(seen[0].body, {
    schemaVersion: 1,
    kind: 'download-start',
    installId: INSTALL_ID,
    gameId: 'example.game-1',
    commit: COMMIT,
    at: '2026-10-22T10:00:00.000Z',
    client: 'dsh-gamecenter/0.1.0',
  })
})

test('Report-2: 非 2xx 返回 ok:false，不抛错', async () => {
  const client = clientWith(async () => new Response('nope', { status: 429 }))
  const res = await client.report('install-ok', 'example.game-1', COMMIT)
  assert.equal(res.ok, false)
  assert.equal(res.status, 429)
})

test('Report-3: 网络异常静默失败，不向上抛', async () => {
  const client = clientWith(async () => {
    throw new Error('ECONNREFUSED')
  })
  const res = await client.report('install-fail', 'example.game-1', COMMIT)
  assert.equal(res.ok, false)
  assert.match(String(res.error), /ECONNREFUSED/)
})

test('Report-4: 非法输入不发请求', async () => {
  let calls = 0
  const client = clientWith(async () => {
    calls += 1
    return new Response('{}', { status: 202 })
  })

  assert.equal((await client.report('install-ok', 'bad gameId', COMMIT)).ok, false)
  assert.equal((await client.report('install-ok', 'example.game-1', 'short-sha')).ok, false)
  assert.equal(calls, 0)
})

test('Report-8: 关闭开关后不发送、不排队、不补发', async () => {
  let calls = 0
  const client = new RemoteReportClient({
    baseUrl: BASE,
    installId: INSTALL_ID,
    fetcher: async () => {
      calls += 1
      return new Response('{"accepted":true}', { status: 202 })
    },
    enabled: false,
  })

  assert.equal(client.isEnabled, false)
  const res = await client.report('install-ok', 'example.game-1', COMMIT)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'DISABLED')

  client.downloadStarted('example.game-1', COMMIT)
  client.installFailed('example.game-1', COMMIT)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls, 0)
})

test('Report-5: 后台入口同步返回，请求失败也不抛错', async () => {
  const client = clientWith(async () => {
    throw new Error('boom')
  })
  // 不 await：只要不抛、能正常返回即可
  client.downloadStarted('example.game-1', COMMIT)
  client.installSucceeded('example.game-1', COMMIT)
  client.installFailed('example.game-1')
  assert.ok(true)
})

test('Report-7: forInstall 适配器把钩子映射到正确的 kind', async () => {
  const kinds = []
  const client = clientWith(async (_url, init) => {
    kinds.push(JSON.parse(String(init.body)).kind)
    return new Response('{"accepted":true}', { status: 202 })
  })

  const reporter = client.forInstall('example.game-1', COMMIT)
  reporter.installSucceeded()
  reporter.installFailed()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(kinds, ['install-ok', 'install-fail'])
})

test('Report-6: installId 可生成且形状稳定', () => {
  const id = createInstallId()
  assert.ok(id.length >= 8 && id.length <= 64, id)
  assert.match(id, /^[A-Za-z0-9._-]+$/)
})

test('§11.9 detail 是可选字段：不发照常记账，发了必须是白名单化后的结构', () => {
  const client = new RemoteReportClient({ baseUrl: 'http://127.0.0.1:1/v1', installId: 'inst-abcdefgh' })

  const plain = client.buildPayload('install-ok', 'example.sample')
  assert.equal(plain.detail, undefined, '不发 detail 时载荷里不能出现该键')

  const withDetail = client.buildPayload('download-fail', 'example.sample', undefined, {
    phase: 'connect',
    code: 'UPSTREAM_UNREACHABLE',
    winnerRoute: 'proxy',
    attempts: [
      {
        route: 'proxy',
        proxy: '127.0.0.1:7080',
        phase: 'connect',
        cause: 'connect ECONNREFUSED 127.0.0.1:7080',
        elapsedMs: 9.4,
        resolvedIp: '185.199.108.133',
      },
    ],
  })
  assert.equal(withDetail.detail.phase, 'connect')
  assert.equal(withDetail.detail.code, 'UPSTREAM_UNREACHABLE')
  assert.equal(withDetail.detail.attempts.length, 1)
  // cause 只收错误码形态：上游文本被折成第一个 SCREAMING_SNAKE 词
  assert.equal(withDetail.detail.attempts[0].cause, 'ECONNREFUSED')
  assert.equal(withDetail.detail.attempts[0].elapsedMs, 9)
})

test('§11.9 白名单外内容一律丢弃：未知键、越界枚举、嵌套结构、超长 attempts', () => {
  const detail = sanitizeReportDetail({
    phase: 'nonsense',
    code: 'SOMETHING_ELSE',
    winnerRoute: 'carrier-pigeon',
    payloadBase64: 'QUJDREVGRw==',
    attempts: [
      { route: 'proxy', phase: 'connect', cause: 'ECONNREFUSED', elapsedMs: 1, nested: { deep: true } },
      { route: 'direct', phase: 'body', cause: 'ETIMEDOUT', elapsedMs: 5001 },
      { route: 'mirror', phase: 'headers', cause: 'EAI_AGAIN', elapsedMs: 12 },
      { route: 'nope', phase: 'connect', cause: 'X', elapsedMs: 1 },
      'not-an-object',
    ],
  })
  assert.equal(detail.phase, undefined, '值域外 phase 必须丢弃')
  assert.equal(detail.code, undefined, '值域外 code 必须丢弃')
  assert.equal(detail.winnerRoute, undefined, '值域外 route 必须丢弃')
  assert.equal(detail.payloadBase64, undefined, '未知键必须丢弃，否则 detail 成了任意上传端点')
  assert.equal(detail.attempts.length, 3, '最多 4 条且非法条目被剔除')
  assert.deepEqual(
    detail.attempts.map((item) => item.route),
    ['proxy', 'direct', 'mirror'],
  )
  assert.equal(detail.attempts[0].nested, undefined, 'attempts 里不允许嵌套对象')
})

test('§11.9 取消与下载失败是不同类别：download-fail 与 install-fail 不互串', async () => {
  const seen = []
  const client = new RemoteReportClient({
    baseUrl: 'http://127.0.0.1:1/v1',
    installId: 'inst-abcdefgh',
    fetcher: async (url, init) => {
      seen.push(JSON.parse(init.body))
      return { ok: true, status: 202 }
    },
  })
  const reporter = client.forInstall('example.sample', 'a'.repeat(40))
  reporter.downloadFailed({ phase: 'headers', code: 'UPSTREAM_TIMEOUT', attempts: [] })
  reporter.installFailed()
  assert.deepEqual(seen.map((item) => item.kind), ['download-fail', 'install-fail'])
  assert.equal(seen[0].detail.phase, 'headers')
  assert.equal(seen[1].detail, undefined, '安装失败不带下载阶段诊断')
})
