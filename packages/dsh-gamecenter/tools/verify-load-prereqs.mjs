/**
 * 隔离验证（`MOCK`/`BUILD` 分栏，非 DSH-REAL）：
 * 在**不启动 DSH** 的前提下，模拟 dsh-app-boot + dsh-client-modules 的发现链，
 * 证明两个包的前置条件成立：
 *
 * 1. Host 包的 patch 声明的 Loader 条目 `name` 是精确包名 → locatePkgJson 能找到它；
 * 2. Host 包的 `exports["."]` 能真实 import（Node 侧）；
 * 3. Client 包的 `exports["."]`（Host 半）能真实 import 且**不触碰 window**；
 * 4. Client 包的 `exports["./client"]` 指向的文件存在且是 `window.__ModuleLoader__.load` 形态；
 * 5. 两个 package.json 的 name 与各自 Loader 条目/期望包名一致。
 *
 * 明确不证明：真实 DSH 装载、$mount 成功、SRC 回退、弹层渲染。
 *
 * 用法：node tools/verify-load-prereqs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 目录定位必须基于脚本自身位置，不能依赖 cwd。
 *
 * 修正历史：本脚本曾用 `path.resolve(process.cwd())` 推 repo 根，
 * 从仓库根跑是 12/12，从包目录跑就是 0/12 ENOENT。
 * 测试与发布负责人指出这会让验收方误判为真实缺陷，成立。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const hostDir = path.resolve(here, '..')
const repo = path.resolve(hostDir, '..', '..')
const clientDir = path.join(repo, 'packages', 'dsh-gamecenter-client')

const results = []
function check(name, fn) {
  return fn().then(
    (detail) => results.push({ name, ok: true, detail }),
    (error) => results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }),
  )
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 复刻 dsh-client-modules/lib/index.js:83 exactPackageSpecifier。 */
function exactPackageSpecifier(specifier) {
  if (typeof specifier !== 'string') return undefined
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
}

/** 从 patch YAML 里取出 insert 条目的 name（本文件格式固定，简单解析即可）。 */
function loaderNamesFromPatch(file) {
  const text = fs.readFileSync(file, 'utf8')
  return [...text.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
}

await check('Host: dsh.bundle.patch 已声明且文件存在', async () => {
  const pkg = readJson(path.join(hostDir, 'package.json'))
  const rel = pkg.dsh?.bundle?.patch
  if (typeof rel !== 'string') throw new Error('缺少 dsh.bundle.patch（会被 app-boot 静默跳过）')
  const file = path.join(hostDir, rel)
  if (!fs.existsSync(file)) throw new Error(`patch 文件不存在: ${rel}`)
  return `${rel} (${fs.statSync(file).size} bytes)`
})

await check('Host: patch 的 Loader 条目 name 是精确包名（locatePkgJson 前提）', async () => {
  const pkg = readJson(path.join(hostDir, 'package.json'))
  const names = loaderNamesFromPatch(path.join(hostDir, pkg.dsh.bundle.patch))
  if (names.length === 0) throw new Error('patch 里没有 name 条目')
  for (const name of names) {
    if (exactPackageSpecifier(name) === undefined) {
      throw new Error(`Loader name ${JSON.stringify(name)} 不是精确包名，locatePkgJson 会直接返回 undefined`)
    }
  }
  return names.join(', ')
})

await check('Host: exports["."] 可被 Node 真实 import', async () => {
  const pkg = readJson(path.join(hostDir, 'package.json'))
  const rel = pkg.exports['.'].default
  const mod = await import(pathToFileURL(path.join(hostDir, rel)).href)
  if (typeof mod.apply !== 'function') throw new Error('Host 半未导出 apply')
  if (!Array.isArray(mod.inject) && mod.inject === undefined) throw new Error('Host 半 inject 形态异常')
  return `${rel} exports: ${Object.keys(mod).join(',')}`
})

await check('Host: 产物不含 .ts 相对导入', async () => {
  const pkg = readJson(path.join(hostDir, 'package.json'))
  const rel = pkg.exports['.'].default
  const text = fs.readFileSync(path.join(hostDir, rel), 'utf8')
  if (/from\s+["'][^"']*\.ts["']/.test(text)) throw new Error('仍含 .ts 导入，Node 无法解析')
  return 'clean'
})

await check('Host: exports 每个子路径都指向真实文件', async () => {
  const pkg = readJson(path.join(hostDir, 'package.json'))
  const missing = []
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (sub === './package.json' || sub.includes('*')) continue
    const entries = typeof target === 'string' ? { default: target } : target
    for (const [cond, rel] of Object.entries(entries)) {
      if (typeof rel !== 'string') continue
      if (!fs.existsSync(path.join(hostDir, rel))) missing.push(`${sub}.${cond} -> ${rel}`)
    }
  }
  if (missing.length > 0) throw new Error(`不存在的产物: ${missing.join('; ')}`)
  return 'all exist'
})

await check('Client: exports["."]（Host 半）可被 Node import 且不依赖 window', async () => {
  const pkg = readJson(path.join(clientDir, 'package.json'))
  const rel = pkg.exports['.'].default
  const mod = await import(pathToFileURL(path.join(clientDir, rel)).href)
  if (typeof window !== 'undefined') throw new Error('测试环境意外存在 window，无法证明无依赖')
  return `${rel} exports: ${Object.keys(mod).join(',')}`
})

await check('Client: exports["./client"] 指向浏览器 bundle 且为 __ModuleLoader__.load 形态', async () => {
  const pkg = readJson(path.join(clientDir, 'package.json'))
  const rel = pkg.exports['./client'].default
  const file = path.join(clientDir, rel)
  if (!fs.existsSync(file)) throw new Error(`bundle 不存在: ${rel}`)
  const head = fs.readFileSync(file, 'utf8').slice(0, 400)
  if (!/__ModuleLoader__\s*\.\s*load\s*\(/.test(head)) throw new Error('不是 __ModuleLoader__.load 形态')
  if (/^\s*import\s/m.test(head)) throw new Error('含顶层 import，不是生产 bundle')
  return `${rel} (${fs.statSync(file).size} bytes)`
})

await check('Client: dsh.client.platform === "web" 且 exports["./client"] 存在', async () => {
  const pkg = readJson(path.join(clientDir, 'package.json'))
  if (pkg.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform 不是 web，resolveMeta 会跳过')
  if (typeof pkg.exports?.['./client']?.default !== 'string') {
    throw new Error('声明了 dsh.client 但缺 exports["./client"]（resolveMeta:738 会 throw）')
  }
  return `platform=${pkg.dsh.client.platform}, inject=${JSON.stringify(pkg.dsh.client.inject)}`
})

await check('Client: 包名可作为精确 Loader 条目名被解析前提成立', async () => {
  const pkg = readJson(path.join(clientDir, 'package.json'))
  if (exactPackageSpecifier(pkg.name) === undefined) throw new Error(`${pkg.name} 不是精确包名`)
  return `${pkg.name} 可作为 Loader 条目 name`
})

/**
 * 复刻 dsh-client-modules 第 893-896 行 reconcilePackage()：
 * 同一 packageName 命中多个 active source 会 throw。
 * 这条决定了"不能为了发现 Client 而额外加一条 Loader 条目"。
 */
await check('patch 未重复登记同一个包（reconcilePackage 会 throw）', async () => {
  const pkg = readJson(path.join(hostDir, 'package.json'))
  const names = loaderNamesFromPatch(path.join(hostDir, pkg.dsh.bundle.patch))
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) throw new Error(`${name} 在 patch 里出现多次，reconcilePackage 会 throw`)
    seen.add(name)
  }
  return `${names.length} 条，无重复`
})

/**
 * Client 的发现路径：必须在**某个** Loader 条目的解析结果里被 nearestPackage 找到。
 * 当前结论：Client 包是 Host 包的 workspace 兄弟包，不保证落在 Host 的解析树内。
 * 因此这一项**不做 PASS 断言**，只报告当前事实，避免用假设冒充验证。
 */
/**
 * Client 发现路径：**必须是真断言**，不再接受 "Host 依赖 Client" 作为替代。
 *
 * 修正历史：本项曾写成 `if (dependsOnClient || hasClientEntry) return ...`，
 * 于是只要 Host 声明了 client 依赖就判 PASS，而实际输出里明明写着
 * `patch 含 Client 条目=false`。测试与发布负责人指出这是自证 PASS，成立。
 *
 * 依据（dsh-client-modules/lib/index.js）：
 * - 第 765 行：`expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)`
 *   → expectedPackageName **恒等于该 Loader 条目的 name**；
 * - 第 793-809 行 nearestPackage 要求 `pkg.name === expectedPackageName`。
 * 因此 name = "@dsh-gamecenter/host" 的条目只会解析出 Host 包，
 * resolveMeta 读它的 dsh.client 得到 undefined → null。
 * **Client 必须有自己名字的 Loader 条目**，静态 import 无法替代。
 */
await check('patch 中存在 name 为 @dsh-gamecenter/client 的 Loader 条目', async () => {
  const hostPkg = readJson(path.join(hostDir, 'package.json'))
  const names = loaderNamesFromPatch(path.join(hostDir, hostPkg.dsh.bundle.patch))
  if (!names.includes('@dsh-gamecenter/client')) {
    throw new Error(
      `patch 里没有 name 为 "@dsh-gamecenter/client" 的 Loader 条目（现有：${names.join(', ')}）；` +
        'expectedPackageName 恒等于条目名，Host 条目只会解析出 Host 包，Client 不会被发现',
    )
  }
  return names.join(', ')
})

/**
 * 模拟 resolveMeta 的包定位：对**每个** Loader 条目名，按
 * locatePkgJson → nearestPackage（要求 name 精确匹配）求出它会命中哪个包，
 * 并检查命中包的 dsh.client 与 exports["./client"]。
 */
await check('逐条模拟 resolveMeta：每个 Loader 条目都解析到自己那个包且 Client 可被发现', async () => {
  const hostPkg = readJson(path.join(hostDir, 'package.json'))
  const names = loaderNamesFromPatch(path.join(hostDir, hostPkg.dsh.bundle.patch))
  const pkgRoots = {
    '@dsh-gamecenter/host': hostDir,
    '@dsh-gamecenter/client': clientDir,
  }
  const lines = []
  let clientDiscovered = false
  for (const name of names) {
    const root = pkgRoots[name]
    if (root === undefined) {
      lines.push(`${name}: 本地没有可对照的包目录，跳过判定`)
      continue
    }
    const manifest = readJson(path.join(root, 'package.json'))
    // nearestPackage 要求 pkg.name === expectedPackageName
    if (manifest.name !== name) {
      throw new Error(`${name}: 命中的 package.json name 是 ${manifest.name}，与条目名不符，resolveMeta 会返回 null`)
    }
    const platform = manifest.dsh?.client?.platform
    const clientRel = manifest.exports?.['./client']?.default
    if (platform === 'web' && typeof clientRel === 'string' && fs.existsSync(path.join(root, clientRel))) {
      clientDiscovered = true
      lines.push(`${name}: dsh.client.platform=web, clientPath=${clientRel}`)
    } else {
      lines.push(`${name}: platform=${platform ?? 'undefined'}, exports["./client"]=${clientRel ?? 'undefined'} → resolveMeta 返回 null`)
    }
  }
  if (!clientDiscovered) throw new Error('没有任何 Loader 条目能让 Client bundle 被发现')
  return lines.join(' | ')
})

// ---- 汇总 ----
let failed = 0
for (const result of results) {
  const tag = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  process.stdout.write(`[${tag}] ${result.name}${result.detail ? ` — ${result.detail}` : ''}\n`)
}
process.stdout.write(`\n=== ${results.length - failed}/${results.length} PASS ===\n`)
process.stdout.write(
  '边界：本脚本只证明「前置条件在 Node 侧成立」，不是 DSH-REAL。\n' +
    '真实装载、$mount、SRC 回退、弹层渲染均未验证。\n',
)
process.exit(failed === 0 ? 0 : 1)
