/**
 * Flash 关闭路径测试（证据分栏：UNIT / VM-CJS）
 *
 * 背景：`close` 时若会话声明 `supportsSave:false` 且是 crazy-flasher4，
 * 需要先保存 Flash 进度再关闭。该依赖通过惰性 `await import()` 解析，
 * 解析或保存失败**不得阻断关闭**。
 *
 * 两条用例分别覆盖：注入提供方（正常路径）、依赖解析失败（兜底路径）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 极简伪 DOM：够 session-controller 建 host/iframe 即可。 */
function createMinimalDom() {
  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      this.childNodes = []
      this.style = {}
      this.attributes = {}
      this.contentWindow = {}
      this.parentNode = null
    }
    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    }
    removeChild(child) {
      this.childNodes = this.childNodes.filter((c) => c !== child)
      child.parentNode = null
      return child
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    }
    getAttribute(name) {
      return this.attributes[name]
    }
    removeAttribute(name) {
      delete this.attributes[name]
    }
    querySelectorAll() {
      return []
    }
    addEventListener() {}
    removeEventListener() {}
  }
  const body = new FakeNode('body')
  return { body, FakeNode }
}

/** 把 session-controller 源码转成可在 vm 里执行的 CJS（与主测试文件同一套改写）。 */
function loadSessionController(sandbox) {
  const src = fs.readFileSync(path.resolve(here, '../src/runtime/session-controller.js'), 'utf8')
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/export const (\w+)/g, 'exports.$1')
    .replace(/export function (\w+)/g, 'exports.$1 = function $1')
  vm.runInNewContext(cjs, sandbox)
  Object.assign(sandbox, sandbox.exports)
  return sandbox.exports
}

function makeFlashSession() {
  return {
    gameId: 'example.crazy-flasher4',
    commit: 'c',
    title: 't',
    runtimeInstanceId: 'rt-flash',
    nonce: 'n',
    launchToken: 'l',
    runtimeToken: 'tok',
    lease: {},
    docHtml: '',
    blobUrl: null,
    supportsSave: false,
    supportsResume: false,
    dispatcher: { triggerPause: () => {}, dispose: () => {} },
  }
}

test('Flash 关闭：注入 saveFlashBeforeClose 时先保存再关闭', async () => {
  const { body, FakeNode } = createMinimalDom()
  const sandbox = {
    document: { body, createElement: (tag) => new FakeNode(tag) },
    exports: {},
    console: { warn: () => {} },
    // vm 新上下文不带 timer 全局，而 controller 内部裸用 setTimeout/clearTimeout
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  }
  sandbox.module = { exports: sandbox.exports }

  const controller = loadSessionController(sandbox)
  const saved = []
  const ctrl = controller.createGameSessionController({
    requestPause: async () => ({ kind: 'saved', message: '已保存' }),
    saveFlashBeforeClose: async (session) => {
      saved.push(session.runtimeInstanceId)
      return true
    },
  })

  const session = makeFlashSession()
  ctrl.attach(session, { sandbox: 'allow-scripts', frameMode: 'srcdoc', anchor: null })

  const outcome = await ctrl.finalize('close')
  assert.equal(outcome.kind, 'saved')
  assert.deepEqual(saved, ['rt-flash'], '必须先调用注入的保存函数')
  assert.match(outcome.message, /已保存/)
})

test('Flash 关闭：保存依赖解析失败时不得阻断关闭，提示未确认保存', async () => {
  const { body, FakeNode } = createMinimalDom()
  const warns = []
  const sandbox = {
    document: { body, createElement: (tag) => new FakeNode(tag) },
    exports: {},
    console: { warn: (...args) => warns.push(args) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  }
  sandbox.module = { exports: sandbox.exports }

  const controller = loadSessionController(sandbox)
  // 不注入 saveFlashBeforeClose：走 (await import(...))，vm 环境无动态 import 回调 → 必然失败
  const ctrl = controller.createGameSessionController({
    requestPause: async () => ({ kind: 'saved', message: '已保存' }),
  })

  const session = makeFlashSession()
  ctrl.attach(session, { sandbox: 'allow-scripts', frameMode: 'srcdoc', anchor: null })

  const outcome = await ctrl.finalize('close')
  assert.equal(outcome.kind, 'saved', '依赖失败也必须完成关闭，不能 refused/抛错')
  assert.match(outcome.message, /未能确认|未确认/, '必须如实提示进度未确认保存')
  assert.equal(warns.length, 1, '必须记录一次可见失败日志')
})
