/**
 * 用**真实 Cordis 实现**复现 `cannot get property "remote.gameCenter" without inject`，
 * 并对照验证官方放行读法与自等候死锁。
 *
 * 前置：先运行 `node tools/cordis-inject-probe/extract-cordis.mjs`。
 * 运行：node tools/cordis-inject-probe/repro-inject-guard.mjs
 * 退出码：0 = 三组全部符合预期；1 = 有偏差（说明 DSH 行为与本文档不符，需重新核实）。
 *
 * 本脚本只加载从 asar 释放的真实 Cordis，不用手写 mock 代替注入规则。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(os.tmpdir(), 'cordis-real')
const entry = path.join(ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')

if (!fs.existsSync(entry)) {
  console.error(`未找到已释放的 Cordis：${entry}`)
  console.error('请先运行：node tools/cordis-inject-probe/extract-cordis.mjs')
  process.exit(2)
}

const { Context, Service } = await import(pathToFileURL(entry).href)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 复刻 dsh-api-gateway：remoteServiceKey(namespace) = `remote.${namespace}`。 */
const remoteServiceKey = (namespace) => `remote.${namespace}`

class FakeRemote extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }
  async $mount(namespace) {
    const fiber = this.ctx.plugin({
      name: remoteServiceKey(namespace),
      apply: (ctx) => {
        new NamespaceService(ctx, namespace)
      },
    })
    await fiber
    return async () => {
      await fiber.dispose()
    }
  }
}

class NamespaceService extends Service {
  constructor(ctx, namespace) {
    super(ctx, remoteServiceKey(namespace))
    this.namespace = namespace
    this.calls = 0
    // 复刻真实 RemoteNamespaceService.install()：方法以实例自有 getter 定义。
    Object.defineProperty(this, 'handshake', {
      configurable: true,
      enumerable: true,
      get: () => (...args) => {
        this.calls += 1
        return { ok: true, namespace: this.namespace, args, calls: this.calls }
      },
    })
  }
}

const results = {}

// A：inject 缺 'remote.gameCenter' —— 复现实机报错
{
  const root = new Context()
  root.plugin(FakeRemote)
  root.plugin({
    name: 'probe-A',
    inject: ['remote'],
    apply: async (ctx) => {
      await ctx.remote.$mount('gameCenter')
      try {
        ctx.remote.gameCenter
        results.A = { ok: true }
      } catch (error) {
        results.A = { ok: false, message: error.message }
      }
    },
  })
  await sleep(80)
}

// B：inject 只有 'remote'，用 ctx.get / ctx.reflect.get 读命名空间
{
  const root = new Context()
  root.plugin(FakeRemote)
  root.plugin({
    name: 'probe-B',
    inject: ['remote'],
    apply: async (ctx) => {
      await ctx.remote.$mount('gameCenter')
      const viaGet = ctx.get('remote.gameCenter')
      const viaReflect = ctx.reflect.get('remote.gameCenter')
      results.B = {
        viaGet: viaGet ? viaGet.handshake() : null,
        viaReflect: viaReflect ? viaReflect.handshake() : null,
        // ctx.get 返回值经 getTraceable 包装，两次读数不是同一引用，只能断言功能等价。
        traceableWrapped: viaGet !== viaReflect,
        viaDottedOK: (() => {
          try {
            return Boolean(ctx.remote.gameCenter)
          } catch {
            return false
          }
        })(),
      }
    },
  })
  await sleep(80)
}

// C：inject 里写上 'remote.gameCenter' —— 自等候死锁
{
  const root = new Context()
  root.plugin(FakeRemote)
  let applied = false
  root.plugin({
    name: 'probe-C',
    inject: ['remote', 'remote.gameCenter'],
    apply: async (ctx) => {
      applied = true
      await ctx.remote.$mount('gameCenter')
    },
  })
  await sleep(160)
  results.C = { applyRan: applied }
}

console.log('=== 真实 Cordis 注入守卫复现 ===')
console.log('A ctx.remote.gameCenter（inject 只有 remote）: ' + JSON.stringify(results.A))
console.log('B ctx.get("remote.gameCenter"): ' + JSON.stringify(results.B))
console.log('C inject 含 remote.gameCenter 时 apply 是否执行: ' + JSON.stringify(results.C))

const passA =
  results.A?.ok === false &&
  results.A.message === 'cannot get property "remote.gameCenter" without inject'
const passB =
  results.B?.viaGet?.ok === true && results.B?.viaReflect?.ok === true && results.B?.viaDottedOK === false
const passC = results.C?.applyRan === false

console.log('---')
console.log('A 复现实机报错   : ' + (passA ? 'PASS' : 'FAIL'))
console.log('B ctx.get 放行    : ' + (passB ? 'PASS' : 'FAIL'))
console.log('C 自等候死锁      : ' + (passC ? 'PASS' : 'FAIL'))

process.exit(passA && passB && passC ? 0 : 1)
