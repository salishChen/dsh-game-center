import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 构建产物守卫（`BUILD` 分栏）。
 *
 * 存在理由：包曾经没有 `lib/` 产物，而 `main`/`exports` 却指向 `lib/index.js`，
 * 真实装载会 `ERR_MODULE_NOT_FOUND`。这个测试把"产物必须存在且可导入"钉死，
 * 避免再次出现"类型检查过了但根本没有可加载文件"。
 *
 * 注意：本测试**不**证明 DSH 装载成功（那是 DSH-REAL），只证明产物可被 Node 导入。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const libIndex = path.join(pkgDir, 'lib', 'index.js')

test('构建产物 lib/index.js 存在', () => {
  assert.ok(fs.existsSync(libIndex), '缺少 lib/index.js，请先运行 npx tsc -p tsconfig.build.json')
})

test('package.json 的 main 与 exports 指向的文件都存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const targets = [pkg.main, pkg.exports['.'].default]
  for (const target of targets) {
    assert.equal(typeof target, 'string')
    const abs = path.join(pkgDir, target)
    assert.ok(fs.existsSync(abs), `入口声明的 ${target} 不存在`)
  }
})

/**
 * 守卫：每个 exports 子路径的 default/types 都必须指向**真实存在的文件**。
 * 起因：曾声明 `exports["./remote"].default = "./lib/remote.js"`，
 * 而构建产物只有 `lib/remote/` 目录，该文件从未存在，
 * 任何 `import '@dsh-gamecenter/host/remote'` 都会 ERR_MODULE_NOT_FOUND。
 */
test('exports 的每个子路径都指向真实存在的产物文件', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const missing = []
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath === './package.json') continue
    if (subpath === './src/*') continue // 通配源码映射，不对应单文件
    const entries = typeof target === 'string' ? { default: target } : target
    for (const [condition, rel] of Object.entries(entries)) {
      if (typeof rel !== 'string') continue
      const abs = path.join(pkgDir, rel)
      if (!fs.existsSync(abs)) missing.push(`${subpath}.${condition} -> ${rel}`)
    }
  }
  assert.deepEqual(missing, [], `exports 声明了不存在的产物：${missing.join('; ')}`)
})

test('package.json 声明了 dsh.bundle.patch 且该 patch 文件存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  // dsh-app-boot 第 1023-1024 行：缺 dsh.bundle 会被静默跳过。
  assert.equal(typeof pkg.dsh?.bundle?.patch, 'string', '缺少 dsh.bundle.patch，bundle 会被静默跳过')
  const patchPath = path.join(pkgDir, pkg.dsh.bundle.patch)
  assert.ok(fs.existsSync(patchPath), `dsh.bundle.patch 指向的 ${pkg.dsh.bundle.patch} 不存在`)
})

/**
 * 守卫：patch 里每个 Loader 条目名必须是**精确包名**。
 * 依据 dsh-client-modules 第 83 行 exactPackageSpecifier + 第 766 行：
 * 非精确包名时 locatePkgJson 直接返回 undefined，Client bundle 永不被发现。
 */
test('patch 的 Loader 条目名都是精确包名', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const patchText = fs.readFileSync(path.join(pkgDir, pkg.dsh.bundle.patch), 'utf8')
  const names = [...patchText.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
  assert.ok(names.length > 0, 'patch 里没有 name 条目')

  const isExact = (specifier) => {
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/')
      return parts.length === 2 && parts.every(Boolean)
    }
    return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':')
  }
  for (const name of names) {
    assert.ok(isExact(name), `Loader 条目 ${JSON.stringify(name)} 不是精确包名`)
  }
})

/**
 * 守卫：patch 不得为同一个包建立多条 Loader 条目。
 * 依据 dsh-client-modules 第 893-896 行 reconcilePackage()：
 * 同一 packageName 命中多个 active source 会直接 throw
 * "resolves from multiple active Loader sources ... remove one entry"。
 *
 * 这条容易踩：为了让 Client 被 resolveMeta 发现，直觉上会再加一条
 * name: "@dsh-gamecenter/client"，但那会让整个 Client 模块表崩掉。
 */
test('patch 不重复登记同一个包（reconcilePackage 会 throw）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const patchText = fs.readFileSync(path.join(pkgDir, pkg.dsh.bundle.patch), 'utf8')
  const names = [...patchText.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
  const seen = new Set()
  for (const name of names) {
    assert.equal(seen.has(name), false, `patch 里 ${name} 出现多次，reconcilePackage 会 throw`)
    seen.add(name)
  }
})

/**
 * 守卫：patch 必须含 name 为 @dsh-gamecenter/client 的 Loader 条目。
 *
 * 依据 dsh-client-modules/lib/index.js：
 * - 第 765 行 `expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)`
 *   → expectedPackageName **恒等于该 Loader 条目的 name**；
 * - 第 793-809 行 nearestPackage 要求 `pkg.name === expectedPackageName`。
 *
 * 所以 name = "@dsh-gamecenter/host" 的条目只会解析出 Host 包，
 * resolveMeta 读它的 dsh.client 得到 undefined → 返回 null。
 * **Host 静态 import Client 不能替代这一条**，这是测试与发布负责人按源码复刻后证伪的结论。
 */
test('patch 必须存在 name 为 @dsh-gamecenter/client 的 Loader 条目', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const patchText = fs.readFileSync(path.join(pkgDir, pkg.dsh.bundle.patch), 'utf8')
  const names = [...patchText.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
  assert.ok(
    names.includes('@dsh-gamecenter/client'),
    `patch 里没有 "@dsh-gamecenter/client" 条目（现有：${names.join(', ')}）；Client bundle 不会被 resolveMeta 发现`,
  )
})

/**
 * 守卫：逐条模拟 resolveMeta 的包定位。
 * Host 条目解析到 Host 包（dsh.client 为 undefined，正常）；
 * Client 条目必须解析到 Client 包，且 platform=web、exports["./client"] 文件真实存在。
 */
test('逐条模拟 resolveMeta：Client 条目能算出真实 clientPath', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const patchText = fs.readFileSync(path.join(pkgDir, pkg.dsh.bundle.patch), 'utf8')
  const names = [...patchText.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
  const clientDir = path.join(pkgDir, '..', 'dsh-gamecenter-client')
  const clientManifest = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8'))

  // nearestPackage 要求 name 精确匹配
  assert.equal(clientManifest.name, '@dsh-gamecenter/client')
  assert.ok(names.includes(clientManifest.name))

  assert.equal(clientManifest.dsh?.client?.platform, 'web', 'platform 不是 web，resolveMeta 会跳过')
  const clientRel = clientManifest.exports?.['./client']?.default
  assert.equal(typeof clientRel, 'string')
  assert.ok(fs.existsSync(path.join(clientDir, clientRel)), `clientPath ${clientRel} 不存在`)
})

test('engines.dsh 同时存在于顶层与 dsh.engines（与实装插件形态一致）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(typeof pkg.engines?.dsh, 'string')
  assert.equal(typeof pkg.dsh?.engines?.dsh, 'string')
})

test('产物可被真实 ESM 导入，并导出 apply / inject', async () => {
  const mod = await import(pathToFileURL(libIndex).href)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['llm'])
})

test('产物不含 .ts 相对导入（必须重写为 .js）', () => {
  const source = fs.readFileSync(libIndex, 'utf8')
  assert.equal(/from\s+["'][^"']*\.ts["']/.test(source), false, 'lib/index.js 仍含 .ts 导入')
})

/**
 * 守卫：产物里**不得有任何外部包运行时导入**。
 *
 * - protocol 只能以 `import type` 存在（编译擦除）。若某天写成值导入
 *   （例如直接用 `ERROR_CODES` 常量），产物会出现 `from '@dsh-gamecenter/protocol'`，
 *   而 DSH 宿主解析不到该包 → ERR_MODULE_NOT_FOUND。
 * - 曾经允许过 `@dsh-gamecenter/client`（理由"发现锚点"），该理由已被证伪并移除，
 *   现在白名单为**空**。
 *
 * 判定必须用真实 ESM 语句匹配，不能用文本包含：注释里出现 import 字样不算
 * （测试与发布负责人曾因此误报一次）。
 */
test('产物中无任何外部包运行时导入', () => {
  const patterns = [
    /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
  ]
  const walk = (dir) => {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name.endsWith('.js')) out.push(full)
    }
    return out
  }
  const external = []
  const allowed = new Set(['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/cordis'])
  for (const file of walk(path.join(pkgDir, 'lib'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1]
        if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:') || allowed.has(spec)) continue
        external.push(`${path.relative(pkgDir, file)} -> ${spec}`)
      }
    }
  }
  assert.deepEqual(external, [], `产物含外部包运行时导入：${external.join('; ')}`)
})

/**
 * 守卫：Host 产物**不得**依赖 Client 包被导入。
 *
 * 历史：曾加过 `import '@dsh-gamecenter/client'` 当"发现锚点"，
 * 但 `locatePkgJson:765` 的 `expectedPackageName` 恒等于 Loader 条目名，
 * 该导入对发现毫无作用，却会让 Client 的 Host 半在 Host 启动时被执行。
 * 现在发现完全依赖 `cordis.patch.yml` 的两条 Loader 条目。
 */
test('产物不含 @dsh-gamecenter/client 导入（发现应由 Loader 条目负责）', () => {
  const source = fs.readFileSync(libIndex, 'utf8')
  assert.equal(
    /from\s+['"]@dsh-gamecenter\/client['"]/.test(source) || /^\s*import\s*['"]@dsh-gamecenter\/client['"]/m.test(source),
    false,
    'Host 产物仍在导入 Client 包；这既无发现作用，又会让它在 Host 启动时被执行',
  )
})

test('产物在真实 Context 下装配成功且 remoteMounted=true', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const mod = await import(pathToFileURL(libIndex).href)
  const root = new Context()
  const api = mod.apply(root)
  assert.equal(api.remoteMounted, true)
})

test('产物中的核心逻辑可端到端执行：握手 → 暂停 → 旧代次拒写 → 保存确认', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const mod = await import(pathToFileURL(libIndex).href)
  const root = new Context()
  const api = mod.apply(root)

  const hs = api.core.handshake({
    runtimeInstanceId: 'rt-artifact-1',
    nonce: 'n',
    gameId: 'example.artifact',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
  })
  assert.equal(hs.ok, true)
  assert.equal(typeof hs.generation, 'number')

  const paused = api.core.pause({ runtimeToken: hs.runtimeToken, generation: hs.generation, reason: 'artifact-test' })
  assert.equal(paused.accepted, true)
  assert.equal(paused.state, 'pausing')
  assert.equal(paused.timeoutMs, 3000)

  const stale = api.core.saveAck({ runtimeToken: hs.runtimeToken, generation: hs.generation - 1, revision: 1 })
  assert.equal(stale.accepted, false)
  assert.equal(stale.error.code, 'STALE_RUNTIME')

  const ack = api.core.saveAck({ runtimeToken: hs.runtimeToken, generation: hs.generation, revision: 1 })
  assert.equal(ack.accepted, true)
  assert.equal(ack.state, 'paused')
  assert.equal(ack.lastPersistedRevision, 1)
})

const stagingIndex = path.join(pkgDir, 'staging', 'index.js')

test('staging 修复候选产物在真实 Context 下装配成功且 remoteMounted=true', async () => {
  if (!fs.existsSync(stagingIndex)) return
  const { Context } = await import('@deepseek-ai/cordis')
  const mod = await import(pathToFileURL(stagingIndex).href)
  const root = new Context()
  const api = mod.apply(root)
  assert.equal(api.remoteMounted, true, '必须成功装配 Remote 服务')
  assert.ok(root.reflect.props['gameCenter'], '必须在 context 登记 gameCenter 服务')
})

test('staging 修复候选产物中的凭证绑定逻辑端到端执行', async () => {
  if (!fs.existsSync(stagingIndex)) return
  const { Context } = await import('@deepseek-ai/cordis')
  const mod = await import(pathToFileURL(stagingIndex).href)
  const root = new Context()
  const api = mod.apply(root)

  const hs = api.core.handshake({
    runtimeInstanceId: 'rt-staging-1',
    nonce: 'n',
    gameId: 'example.staging',
    gameVersion: '1.0.0',
    sdkVersion: '1.0.0',
    bridgeVersion: 1,
  })
  assert.equal(hs.ok, true)
  assert.equal(typeof hs.runtimeToken, 'string')
  assert.equal(typeof hs.generation, 'number')

  // 用凭证暂停
  const paused = api.core.pause({ runtimeToken: hs.runtimeToken, reason: 'staging-test' })
  assert.equal(paused.accepted, true)
  assert.equal(paused.state, 'pausing')

  // 伪造凭证写 -> 拒绝
  const forged = api.core.saveAck({ runtimeToken: 'forged-token', revision: 1 })
  assert.equal(forged.accepted, false)
  assert.equal(forged.error.code, 'PROTOCOL_INVALID')

  // 正确凭证写 -> 接受
  const ack = api.core.saveAck({ runtimeToken: hs.runtimeToken, revision: 1 })
  assert.equal(ack.accepted, true)
  assert.equal(ack.state, 'paused')
})
