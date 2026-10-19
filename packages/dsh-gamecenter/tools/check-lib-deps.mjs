/**
 * 只读检查：Host 构建产物 lib/**.js 的外部包运行时导入是否**在白名单内**。
 *
 * 为什么要有白名单：Host 包要在 DSH 宿主里被 ESM import。宿主能解析的是
 * "被 Loader 装载过的包"，不是任意 npm 包。所以：
 *
 * - `@dsh-gamecenter/protocol` **禁止**：它只是类型契约，必须以 `import type`
 *   形式出现（编译期擦除）。一旦写成值导入，宿主里没有它的 Loader 条目，
 *   就会 ERR_MODULE_NOT_FOUND。
 * - 白名单当前为**空**：曾经允许过 `@dsh-gamecenter/client`（当时的理由是"发现锚点"），
 *   但该理由已被证伪（Loader 条目名本身才是发现依据），故已移除该导入，
 *   白名单也随之清空。现在产物**不得有任何外部运行时导入**。
 *
 * 注意：必须识别**真实 ESM import 语句**，不能靠文本包含——
 * 注释里出现 import 字样不算（测试与发布负责人曾因此误报一次）。
 *
 * 用法：node tools/check-lib-deps.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const libDir = path.join(pkgDir, 'lib')

/**
 * 允许出现在产物里的外部运行时导入（连同允许原因）。当前为空。
 * 如需重新加入，必须同时说明"宿主为何能解析它"，并补对应测试。
 */
const ALLOWED_EXTERNAL = new Map()

/** 真实 ESM 静态 import / export-from 语句的说明符。 */
const SPECIFIER_PATTERNS = [
  /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
]

function specifiersOf(source) {
  const found = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

if (!fs.existsSync(libDir)) {
  console.error('lib/ 不存在，请先运行 npx tsc -p tsconfig.build.json')
  process.exit(2)
}

const files = walk(libDir)
const disallowed = []
const allowedSeen = new Set()
for (const file of files) {
  const relative = path.relative(libDir, file).split(path.sep).join('/')
  for (const spec of specifiersOf(fs.readFileSync(file, 'utf8'))) {
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:')) continue
    if (ALLOWED_EXTERNAL.has(spec)) {
      allowedSeen.add(spec)
      continue
    }
    disallowed.push(`${relative} -> ${spec}`)
  }
}

console.log(`扫描 ${files.length} 个产物文件`)
for (const spec of allowedSeen) {
  console.log(`  允许的外部导入：${spec}（${ALLOWED_EXTERNAL.get(spec)}）`)
}

if (disallowed.length === 0) {
  console.log('RESULT: PASS — 无白名单外的外部包运行时导入')
  process.exit(0)
}
console.log('RESULT: FAIL — 发现白名单外的外部包运行时导入：')
for (const line of disallowed) console.log(`  ${line}`)
process.exit(1)

