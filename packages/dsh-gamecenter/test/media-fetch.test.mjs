/**
 * Host mediaFetch Remote 端点受控拉取测试套件（证据分栏：UNIT / MOCK）
 *
 * 覆盖：
 * 1. 白名单 URL + 正确 MIME + 正确 SHA-256：拉取成功，返回 base64 数据与字节数；
 * 2. 非白名单 URL / 非 https / userinfo：被拒绝为 PROTOCOL_INVALID；
 * 3. 响应非 2xx 或网络异常：返回 MEDIA_UNREACHABLE；
 * 4. MIME 不在允许范围（如 image/svg+xml）：返回 MEDIA_MIME_MISMATCH；
 * 5. MIME 与 expectedMime 不符：返回 MEDIA_MIME_MISMATCH；
 * 6. SHA-256 摘要与 expectedSha256 不符：返回 MEDIA_DIGEST_MISMATCH；
 * 7. 体积超过 maxBytes：返回 MEDIA_TOO_LARGE。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'

import {
  GameCenterCore,
  defineGameCenterService,
} from '../staging/remote/game-center-service.js'

function makeService(overrides = {}) {
  const root = new Context()
  let gen = 0
  const core = new GameCenterCore({
    nowMs: () => Date.now(),
    ttlMs: 30000,
    createToken: () => 'token-test',
    digestToken: (t) => t,
    nextGeneration: () => ++gen,
  })
  return defineGameCenterService(core, root, {
    playerId: 'test-player',
    mediaSecurityVerified: true, // 单测显式开启验证底层安全逻辑
    ...overrides,
  })
}

test('mediaFetch 生产默认未决保护（fail closed）：默认未开启 mediaSecurityVerified 时直接返回 MEDIA_UNAVAILABLE 且不发网络请求', async () => {
  let networkCalled = false
  const defaultService = makeService({
    mediaSecurityVerified: false,
    mediaFetcher: async () => {
      networkCalled = true
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(0) }
    },
  })

  const res = await defaultService.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/image.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })

  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_UNAVAILABLE')
  assert.match(res.message, /安全校验未通过，暂不可用/)
  assert.equal(networkCalled, false, '默认禁用时坚决不得触发任何网络请求')
})

test('mediaFetch 成功正例：白名单 URL + 合法图片 + 匹配 expectedSha256 成功返回 base64', async () => {
  // 合法 PNG 头 + IHDR 块 (100x200)
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x64, // width 100
    0x00, 0x00, 0x00, 0xc8, // height 200
    0x08, 0x02, 0x00, 0x00, 0x00,
  ])
  const sha256Hex = createHash('sha256').update(imageBytes).digest('hex')

  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async (url) => {
      assert.equal(url, 'https://raw.githubusercontent.com/owner/repo/main/cover.png')
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png; charset=utf-8' : null),
        },
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      }
    },
  })

  const validSha = 'sha256:' + sha256Hex

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/cover.png',
    expectedMime: 'image/png',
    expectedSha256: validSha,
  })

  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.mime, 'image/png')
    assert.equal(res.sha256, validSha)
    assert.equal(res.byteLength, imageBytes.length)
    assert.equal(res.dataBase64, imageBytes.toString('base64'))
  }
})

test('mediaFetch 安全防御负例：非 https / 包含 userinfo / 非白名单 host 坚决拒绝为 PROTOCOL_INVALID', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
  })
  const dummySha = 'sha256:' + 'a'.repeat(64)

  // 非 https
  const resHttp = await service.mediaFetch({
    url: 'http://raw.githubusercontent.com/img.png',
    expectedMime: 'image/png',
    expectedSha256: dummySha,
  })
  assert.equal(resHttp.ok, false)
  assert.equal(resHttp.errorCode, 'PROTOCOL_INVALID')

  // 含 userinfo
  const resUser = await service.mediaFetch({
    url: 'https://user:pass@raw.githubusercontent.com/img.png',
    expectedMime: 'image/png',
    expectedSha256: dummySha,
  })
  assert.equal(resUser.ok, false)
  assert.equal(resUser.errorCode, 'PROTOCOL_INVALID')

  // 非白名单 host
  const resEvil = await service.mediaFetch({
    url: 'https://evil-attacker.com/img.png',
    expectedMime: 'image/png',
    expectedSha256: dummySha,
  })
  assert.equal(resEvil.ok, false)
  assert.equal(resEvil.errorCode, 'PROTOCOL_INVALID')
})

test('mediaFetch 异常负例：响应 404 或网络抛错返回 MEDIA_UNREACHABLE', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/not-found.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_UNREACHABLE')
})

test('mediaFetch 安全负例：SVG 媒体（含主动脚本面）被 MEDIA_MIME_MISMATCH 拒绝', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/svg+xml' : null) },
        arrayBuffer: async () => Buffer.from('<svg></svg>').buffer,
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/icon.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_MIME_MISMATCH')
  assert.match(res.message, /不在允许的白名单内/)
})

test('mediaFetch 校验负例：expectedMime 不匹配返回 MEDIA_MIME_MISMATCH', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => Buffer.from('jpg-data').buffer,
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/photo.jpg',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_MIME_MISMATCH')
})

test('mediaFetch 校验负例：expectedSha256 摘要不匹配返回 MEDIA_DIGEST_MISMATCH', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () =>
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d,
            0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x10,
            0x00, 0x00, 0x00, 0x10,
            0x08, 0x02, 0x00, 0x00, 0x00,
          ]).buffer,
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/cover.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'f'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_DIGEST_MISMATCH')
})

test('mediaFetch 安全负例：伪造 content-type 但魔数不符被 MEDIA_MIME_MISMATCH 拒绝', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => Buffer.from('not-a-real-png-binary').buffer,
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/fake.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_MIME_MISMATCH')
  assert.match(res.message, /魔数与声明的 MIME 类型/)
})

test('mediaFetch 超限负例：体积超过 maxBytes 返回 MEDIA_TOO_LARGE', async () => {
  const bigBytes = Buffer.alloc(100)
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => bigBytes.buffer,
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/cover.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
    maxBytes: 50, // 上限 50 字节
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_TOO_LARGE')
})

test('mediaFetch 安全负例：重定向目标脱离白名单域名被拦截为 PROTOCOL_INVALID', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        url: 'https://evil-redirect-domain.com/hacked.png', // 模拟重定向到了恶意域名
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/redirect.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'PROTOCOL_INVALID')
  assert.match(res.message, /重定向.*目标 URL 不在允许的主机白名单/)
})

test('mediaFetch 安全负例：流式读取超出 maxBytes 边读边断，连接被主动中断', async () => {
  let readerCancelled = false
  const fakeStream = {
    getReader: () => {
      let readCount = 0
      return {
        read: async () => {
          readCount++
          if (readCount <= 2) {
            return { done: false, value: new Uint8Array(40) } // 每次 40 字节，两次 80 字节 > 50 字节上限
          }
          return { done: true }
        },
        cancel: async () => {
          readerCancelled = true
        },
      }
    },
  }

  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        body: fakeStream,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/stream.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
    maxBytes: 50,
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_TOO_LARGE')
  assert.match(res.message, /流式读取超出/)
  assert.equal(readerCancelled, true, '流式超限必须主动 cancel reader 断开连接')
})

test('mediaFetch 安全负例：重定向循环超过 3 次被 PROTOCOL_INVALID 拦截', async () => {
  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async (url) => {
      return {
        ok: false,
        status: 302,
        headers: { get: (k) => (k.toLowerCase() === 'location' ? url + '-next' : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/loop.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'PROTOCOL_INVALID')
  assert.match(res.message, /重定向次数超过上限/)
})

test('mediaFetch 安全负例：DNS 解析出回环或私网 IP 坚决拦截为 MEDIA_UNREACHABLE', async () => {
  // 127.0.0.1 回环
  const serviceLoopback = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }),
  })
  const res1 = await serviceLoopback.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/image.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res1.ok, false)
  assert.equal(res1.errorCode, 'MEDIA_UNREACHABLE')
  assert.match(res1.message, /禁止访问私有内网或回环 IP/)

  // 192.168.1.1 私网
  const servicePrivate = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    dnsLookup: async () => ({ address: '192.168.1.100', family: 4 }),
  })
  const res2 = await servicePrivate.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/image.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res2.ok, false)
  assert.equal(res2.errorCode, 'MEDIA_UNREACHABLE')
  assert.match(res2.message, /禁止访问私有内网或回环 IP/)
})

test('mediaFetch 安全负例：图片像素尺寸超过 4096px 上限被 MEDIA_MIME_MISMATCH 拒绝', async () => {
  // 伪造 5000 x 100 的 PNG 头 (5000 = 0x00001388)
  const bigPngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x13, 0x88, // width 5000 > 4096
    0x00, 0x00, 0x00, 0x64, // height 100
    0x08, 0x02, 0x00, 0x00, 0x00,
  ])

  const service = makeService({
    allowedMediaHosts: ['raw.githubusercontent.com'],
    mediaFetcher: async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () =>
          bigPngBytes.buffer.slice(bigPngBytes.byteOffset, bigPngBytes.byteOffset + bigPngBytes.byteLength),
      }
    },
  })

  const res = await service.mediaFetch({
    url: 'https://raw.githubusercontent.com/owner/repo/main/bomb.png',
    expectedMime: 'image/png',
    expectedSha256: 'sha256:' + 'a'.repeat(64),
  })
  assert.equal(res.ok, false)
  assert.equal(res.errorCode, 'MEDIA_MIME_MISMATCH')
  assert.match(res.message, /媒体图像尺寸超出上限/)
})
