import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import {
  createResilientFetcher,
  describeFetchError,
  isInternalHost,
} from '../staging/remote/direct-http.js'

/**
 * 这组用例是「内网后台请求被死代理拦死」这次事故的回归证据。
 *
 * 事故现场：本机 `HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:7080`（无人监听）+ `NODE_USE_ENV_PROXY=1`，
 * 而 `NO_PROXY` 里写的是 CIDR `192.168.0.0/16` —— undici 的 EnvHttpProxyAgent 不解析 CIDR，
 * 于是连内网 `http://192.168.3.222:18080` 也被推给死代理 → `fetch failed`。
 * 这里把同样的环境变量摆在进程里，断言直连通道照样能取到 200。
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('直连优先：环境里摆着死代理，仍能取到内网 HTTP 200 与正确 JSON', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '0.0.0-p0', path: req.url }))
  })
  const port = await listen(server)

  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  }
  process.env.HTTP_PROXY = 'http://127.0.0.1:1'
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
  process.env.http_proxy = 'http://127.0.0.1:1'
  process.env.https_proxy = 'http://127.0.0.1:1'
  process.env.NODE_USE_ENV_PROXY = '1'
  process.env.NO_PROXY = 'localhost,127.0.0.1,::1,192.168.0.0/16'
  process.env.no_proxy = 'localhost,127.0.0.1,::1,192.168.0.0/16'

  try {
    const fetcher = createResilientFetcher()
    const res = await fetcher(`http://127.0.0.1:${port}/v1/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.version, '0.0.0-p0')
    assert.equal(body.path, '/v1/health')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await close(server)
  }
})

test('直连通道确实绕开代理：注入的回退通道一次都不该被调用', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('direct')
  })
  const port = await listen(server)

  let proxyCalls = 0
  const fetcher = createResilientFetcher({
    proxyFetch: async () => {
      proxyCalls += 1
      throw new Error('回退通道不该被调用')
    },
  })

  try {
    const res = await fetcher(`http://127.0.0.1:${port}/direct`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'direct')
    assert.equal(proxyCalls, 0, '直连成功时不得触碰代理通道')
  } finally {
    await close(server)
  }
})

test('跟随 302 重定向，且相对 location 能正确解析', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { location: '/b' })
      res.end()
      return
    }
    if (req.url === '/b') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('redirected')
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  const port = await listen(server)

  try {
    const fetcher = createResilientFetcher()
    const res = await fetcher(`http://127.0.0.1:${port}/a`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'redirected')
  } finally {
    await close(server)
  }
})

test('直连与回退都失败时，错误里同时带两次尝试的信息并保留 cause 链', async () => {
  const fetcher = createResilientFetcher({
    proxyFetch: async () => {
      throw new Error('回退通道也连不上')
    },
  })

  let caught
  try {
    await fetcher('http://127.0.0.1:1/v1/health')
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error, '必须 reject')
  // §11.8：错误是结构化对象，message 只留一行摘要；两路各自留在 attempts 里
  assert.match(caught.message, /^UPSTREAM_/)
  assert.equal(caught.code, 'UPSTREAM_UNREACHABLE')
  assert.ok(Array.isArray(caught.attempts) && caught.attempts.length === 2, '两路都要留证')
  assert.equal(caught.attempts[0].route, 'direct')
  assert.match(caught.attempts[0].cause, /ECONNREFUSED|connect/i)
  assert.match(describeFetchError(caught), /ECONNREFUSED|connect/i)
})

test('非 GET 立刻抛错，不发任何请求', async () => {
  const fetcher = createResilientFetcher()
  await assert.rejects(() => fetcher('http://127.0.0.1:1/x', { method: 'POST' }), /只实现 GET/)
})

test('超时是"空闲"语义：慢但持续在收的响应不会被掐断', async () => {
  // 事故回归：14 MB 的 dist/game.js 需要足够时间。如果按总时长掐，
  // 快网 13.7 秒能下完、慢网就必死；按空闲掐则"慢但活着"的链路能走完。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    let sent = 0
    const timer = setInterval(() => {
      sent += 1
      res.write(Buffer.alloc(1024, 0x61))
      if (sent >= 8) {
        clearInterval(timer)
        res.end()
      }
    }, 60)
    req.on('close', () => clearInterval(timer))
  })
  const port = await listen(server)

  try {
    // 单次请求空闲上限 250ms，但每 60ms 就有数据 → 总耗时会超过 250ms 仍必须成功。
    const fetcher = createResilientFetcher({ timeoutMs: 250 })
    const started = Date.now()
    const res = await fetcher(`http://127.0.0.1:${port}/slow`)
    const body = await res.arrayBuffer()
    assert.equal(res.status, 200)
    assert.equal(body.byteLength, 8 * 1024)
    assert.ok(Date.now() - started > 250, '本例必须真的超过空闲上限，否则证明不了语义')
  } finally {
    await close(server)
  }
})

test('真的没有数据时按空闲超时失败，并带上"空闲超时"字样', async () => {
  const server = http.createServer(() => {
    // 故意什么都不回：连响应头都不给。
  })
  const port = await listen(server)

  try {
    const fetcher = createResilientFetcher({ timeoutMs: 150, proxyFetch: async () => { throw new Error('unused') } })
    let caught
    try {
      await fetcher(`http://127.0.0.1:${port}/stall`)
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof Error, '必须 reject')
    assert.match(describeFetchError(caught), /空闲超时|ETIMEDOUT/)
  } finally {
    await close(server)
  }
})

test('外部 abort 必须真正打断直连请求（历史缺陷：sendOnce 完全不看 init.signal）', async () => {
  let closed = false
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.write(Buffer.alloc(64, 0x62)) // 先给一点数据，再永久挂住
    req.on('close', () => {
      closed = true
    })
  })
  const port = await listen(server)

  try {
    const fetcher = createResilientFetcher({ timeoutMs: 30_000 })
    const controller = new AbortController()
    const started = Date.now()
    const pending = fetcher(`http://127.0.0.1:${port}/hang`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 120)
    let caught
    try {
      await pending
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof Error, 'abort 后必须 reject')
    assert.equal(caught.name, 'AbortError')
    assert.ok(Date.now() - started < 3_000, '取消必须及时生效，不能等到 30s 空闲超时')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(closed, true, '取消后 socket 必须被真正关闭')
  } finally {
    await close(server)
  }
})

/**
 * 按主机分流：2026-10-30 实测 —— 同一台机器经代理 14 MB / 2.8 s，直连 15 s 拿不到首字节。
 * 所以公网有代理时必须代理优先，内网必须直连优先；两者靠 URL 主机判，不靠 NO_PROXY
 * （undici 不解析 CIDR，实测 CIDR 写法等于没写）。
 */

test('isInternalHost：内网/回环识别，公网不误判', () => {
  for (const host of [
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '127.8.9.10',
    '192.168.3.222',
    '10.0.0.222',
    '172.16.0.1',
    '172.31.255.254',
    '169.254.1.1',
    '100.64.0.1',
    'nas.local',
    'db.internal',
    '::1',
    '0:0:0:0:0:0:0:1',
    // URL.hostname 对 IPv6 会带方括号（Clash 是 :::7080 双栈）——回环必须两种形态都认得
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    'fe80::1',
    'fd00::5',
  ]) {
    assert.equal(isInternalHost(host), true, `${host} 应判为内网`)
  }
  for (const host of [
    'raw.githubusercontent.com',
    'github.com',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    'no-such-host.invalid',
    '[2001:db8::1]',
  ]) {
    assert.equal(isInternalHost(host), false, `${host} 应判为公网`)
  }
})

function withEnv(overrides, fn) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']
  const saved = {}
  for (const key of keys) saved[key] = process.env[key]
  for (const key of keys) delete process.env[key]
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value
  return (async () => fn())().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('公网主机 + 进程里有代理 → 代理优先（直连不当主路）', async () => {
  await withEnv({ HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }, async () => {
    const fetcher = createResilientFetcher({
      timeoutMs: 600,
      proxyFetch: async () => {
        // 故意用「非网络类」错误：这条只有代理优先分支才会立刻冒出来；
        // 若实现退化成直连优先，本机 TUN 会把直连接走，根本不会抛错 —— 于是断言就必然失败。
        throw new Error('代理这一路也失败了')
      },
    })
    let caught
    try {
      await fetcher('http://198.51.100.7:9/v1/health')
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof Error, '必须 reject')
    assert.match(caught.message, /代理这一路也失败了/)
    // 非网络类错误不触发回退，因此错误里不该出现"直连失败"这段合成文本
    assert.doesNotMatch(caught.message, /直连失败/)
  })
})
// 说明：公网 + 无代理时走 `!proxyFirst` 分支（与改动前完全一致），该分支已由上面的
// 内网用例覆盖（同样是直连优先、网络类失败才回退），故不重复造一个需要真实公网失败的用例
// —— 本机的 DNS/TUN 会把任意公网地址接走，写出来只会变成一条不稳定测试。

test('传输失败必须自证：结构化 attempts（route/phase/cause/elapsedMs）而非拼一句人话', async () => {
  const fetcher = createResilientFetcher({
    timeoutMs: 150,
    proxyFetch: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
    },
  })
  const savedProxy = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY }
  delete process.env.HTTPS_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  try {
    await assert.rejects(
      () => fetcher('http://203.0.113.9:8080/v1/health?probe=1', { method: 'GET' }),
      (err) => {
        assert.equal(err.code, 'UPSTREAM_UNREACHABLE', '有一路是非超时失败就该报不可达')
        assert.equal(err.host, '203.0.113.9')
        assert.equal(err.path, '/v1/health?probe=1')
        assert.match(err.proxy, /^on\(http:\/\/127\.0\.0\.1:9, src=env\)$/, 'proxy 要带 host:port 与来源')
        assert.ok(Array.isArray(err.attempts) && err.attempts.length === 2, '两路都要留证')
        assert.deepEqual(
          err.attempts.map((item) => item.route),
          ['proxy', 'direct'],
          '顺序要能复现"先走哪条路"',
        )
        for (const attempt of err.attempts) {
          assert.ok(['connect', 'headers', 'body', 'verify', 'unknown'].includes(attempt.phase), 'phase 必备')
          assert.ok(typeof attempt.cause === 'string' && attempt.cause !== '', 'cause 必备')
          assert.ok(Number.isInteger(attempt.elapsedMs), '每路自己的耗时必须存在')
        }
        return true
      },
    )
  } finally {
    if (savedProxy.http === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = savedProxy.http
    if (savedProxy.https === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = savedProxy.https
  }
})

test('phase=unknown 时 cause 不得为空：必须写明"为什么观测不到"', async () => {
  // 代理通道只抛裸 TypeError（无 cause、无 code）——这正是 undici 走环境代理失败时的真实形态。
  const fetcher = createResilientFetcher({
    timeoutMs: 150,
    proxyFetch: async () => {
      throw new TypeError('fetch failed')
    },
  })
  const savedProxy = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY }
  delete process.env.HTTPS_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  try {
    await assert.rejects(
      () => fetcher('http://203.0.113.11:8080/v1/health', { method: 'GET' }),
      (err) => {
        const proxyAttempt = err.attempts.find((item) => item.route === 'proxy')
        assert.ok(proxyAttempt, '代理那一路必须留证')
        assert.equal(proxyAttempt.phase, 'unknown', '拿不到可观测阶段就得如实标 unknown')
        assert.ok(
          typeof proxyAttempt.cause === 'string' && proxyAttempt.cause.trim() !== '',
          '空 cause 的 unknown 在聚合里与"没采集"无法区分',
        )
        assert.match(proxyAttempt.cause, /无 cause code/, '必须写明是"没有 code 所以判不了阶段"')
        assert.doesNotMatch(proxyAttempt.cause, /^(undefined|null)$/)
        return true
      },
    )
  } finally {
    if (savedProxy.http === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = savedProxy.http
    if (savedProxy.https === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = savedProxy.https
  }
})

test('超时类失败归到 UPSTREAM_TIMEOUT，而不是笼统的网络不可达', async () => {
  const fetcher = createResilientFetcher({
    timeoutMs: 150,
    proxyFetch: async () => {
      throw Object.assign(new Error('直连空闲超时：150ms 内没有任何数据'), { code: 'ETIMEDOUT' })
    },
  })
  const savedProxy = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY }
  delete process.env.HTTPS_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  try {
    await assert.rejects(
      () => fetcher('http://203.0.113.10:8080/v1/health', { method: 'GET' }),
      (err) => {
        assert.equal(err.code, 'UPSTREAM_TIMEOUT')
        return true
      },
    )
  } finally {
    if (savedProxy.http === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = savedProxy.http
    if (savedProxy.https === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = savedProxy.https
  }
})
