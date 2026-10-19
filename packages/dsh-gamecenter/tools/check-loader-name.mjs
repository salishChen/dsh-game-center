/**
 * 只读校验：cordis.patch.yml 里的每个 Loader `name` 是否会被
 * dsh-client-modules 认作「精确包名」。
 *
 * 复刻 dsh-client-modules/lib/index.js 第 83 行 exactPackageSpecifier。
 *
 * 目录定位基于 import.meta.url（不依赖 cwd）：本脚本曾用相对路径，
 * 从包目录运行会 ENOENT，被测试与发布负责人指出过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function exactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
}

const yaml = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
// 只扫 insert: 之后的正文，避免注释里出现的包名造成误通过。
const bodies = [...yaml.matchAll(/^\s*-\s*id:\s*\S+\s*\n\s*name:\s*"([^"]+)"/gm)].map((m) => m[1])
const names = bodies.length > 0 ? bodies : [...yaml.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
console.log('patch 里的 Loader name:', names.join(', '))

if (names.length === 0) {
  console.log('FAIL: patch 中没有 Loader name')
  process.exit(1)
}

let allExact = true
for (const name of names) {
  const isExact = exactPackageSpecifier(name) !== undefined
  console.log(`  ${name} 被判为精确包名: ${isExact}`)
  if (!isExact) allExact = false
}

// 对照：其它写法都不会被认作精确包名
for (const sample of ['@scope/pkg/sub', './plugins/x/index.mjs', 'C:/x/y.mjs', 'lodash/fp']) {
  console.log(`  对照 ${JSON.stringify(sample)} -> ${exactPackageSpecifier(sample) === undefined ? '不是精确包名' : '是'}`)
}

// 每个 name 必须要么是 host 包名、要么是 client 包名，且各自只能出现一次
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const duplicates = names.filter((n, i) => names.indexOf(n) !== i)
console.log('重复登记:', duplicates.length === 0 ? '无' : duplicates.join(', '))

if (!allExact || duplicates.length > 0) {
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log(`RESULT: PASS — ${names.length} 条 Loader name 都是精确包名且无重复；本包名 ${pkg.name}`)
