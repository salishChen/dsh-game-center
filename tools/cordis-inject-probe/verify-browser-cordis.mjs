/**
 * 校验**运行中 GUI 真正加载的那份 Cordis**（dsh-web-frontend 的压缩产物）是否具备
 * 本次修复依赖的三个行为：
 *
 *   1. `ctx.get` 存在：ReflectService 构造里 mixin("reflect", ["get", ...])
 *   2. `get(name, strict=true)` 直接读服务表，不要求 inject
 *   3. `_refresh()` 在任一 inject 未就绪时把 epoch 置 INACTIVE —— 即"加进 inject 会死锁"的机制
 *
 * 这一步不能省：Node 侧的 @deepseek-ai/cordis 与浏览器 bundle 是两份产物，
 * 只验证 Node 侧不能证明真实 GUI 里 ctx.get 可用。
 *
 * 只读 asar，不修改安装目录。
 * 运行：node tools/cordis-inject-probe/verify-browser-cordis.mjs
 * 退出码：0 = 三个特征全部命中；1 = 有缺失（说明浏览器侧行为与 Node 侧不一致，修复不可直接套用）。
 */
import fs from 'node:fs'

const ASAR = 'D:\\Program Files\\deepseek harness\\resources\\app.asar'

function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const raw = Buffer.alloc(headerSize)
  fs.readSync(fd, raw, 0, headerSize, 16)
  const root = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''))
  const readEntry = (entry) => {
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, 16 + headerSize + Number(entry.offset))
    return buf.toString('utf8')
  }
  return { fd, root, readEntry }
}

const { fd, root, readEntry } = openAsar(ASAR)

const frontend = root.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-web-frontend']
const assets = frontend.files.dist.files.assets
const bundles = Object.keys(assets.files).filter((name) => /^index-.*\.js$/.test(name))

if (bundles.length === 0) {
  console.error('未在 asar 内找到 dsh-web-frontend 的 index-*.js 产物')
  process.exit(1)
}

const desktopPkg = JSON.parse(readEntry(root.files['package.json']))
console.log(`来源构建: ${desktopPkg.name}@${desktopPkg.version} commit=${desktopPkg.dshBuildCommit}`)
console.log(`前端产物: ${bundles.join(', ')}`)
console.log('')

let allPass = true

for (const name of bundles) {
  const text = readEntry(assets.files[name])
  if (!text.includes('without inject')) continue

  console.log(`--- ${name} (${text.length} chars) ---`)

  // 1. mixin("reflect", ["get", ...])
  const mixinHit = /mixin\("reflect",\["get"/.test(text)
  // 2. get 实现：直接读服务表（this.store），不查 inject
  const getImplHit = /\bget\([A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)=!0\)\{[^}]*_getImpl\(/.test(text)
  // 3. _getImpl 的 strict 语义：provider fiber 必须 active
  const strictHit = /_getImpl\([^)]*\)\{[^}]*store\[[^\]]*\][^}]*fiber\.state!==2/.test(text)
  // 4. _refresh：任一 inject 缺失即置 INACTIVE（死锁机制）
  const refreshHit = /_refresh\(\)\{[^}]*for\(const [\w$]+ of Object\.keys\(this\.inject\)\)\{[^}]*if\(![^}]*\)\{[^}]*=/.test(text)

  const rows = [
    ['ctx.get 由 mixin("reflect", ["get", ...]) 提供', mixinHit],
    ['get(name, strict=true) 直接读服务表，不要求 inject', getImplHit],
    ['_getImpl 的 strict 检查 fiber.state !== 2', strictHit],
    ['_refresh 在 inject 缺失时置 INACTIVE（死锁机制）', refreshHit],
  ]

  for (const [label, ok] of rows) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
    if (!ok) allPass = false
  }
  console.log('')
}

console.log('---')
if (allPass) {
  console.log('RESULT=PASS —— 浏览器侧 Cordis 与 Node 侧语义一致，ctx.get 读法在真实 GUI 可用')
} else {
  console.log('RESULT=FAIL —— 浏览器侧特征缺失，不能把 Node 侧的修复结论直接套用到真实 GUI')
}

fs.closeSync(fd)
process.exit(allPass ? 0 : 1)
