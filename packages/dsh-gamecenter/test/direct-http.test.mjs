import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createResilientFetcher, describeFetchError } from '../staging/remote/direct-http.js'

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
  assert.match(caught.message, /直连失败/)
  assert.match(caught.message, /回退通道也连不上/)
  assert.match(describeFetchError(caught), /直连失败/)
  assert.ok(caught.cause instanceof Error, 'cause 必须指回直连错误')
  assert.match(String(caught.cause.message), /ECONNREFUSED|connect/i)
})

test('非 GET 立刻抛错，不发任何请求', async () => {
  const fetcher = createResilientFetcher()
  await assert.rejects(() => fetcher('http://127.0.0.1:1/x', { method: 'POST' }), /只实现 GET/)
})
