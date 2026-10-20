#!/usr/bin/env node
/**
 * 阶段1 唯一候选 manifest 采集器（架构与协议负责人维护）。
 *
 * 目的：给 QA 一份**可复算**的验前/验后对账文件。验前跑一次、验后跑一次，
 * 两次结果逐行比对，任何差异即说明"边验边变"，本轮证据作废。
 *
 * 用法：
 *   node tools/collect-candidate-manifest.mjs            # 打印并写入 docs/phase1-candidate-manifest.txt
 *   node tools/collect-candidate-manifest.mjs --stdout   # 只打印不写文件（QA 验后用这个比对）
 *   node tools/collect-candidate-manifest.mjs --compare <before.txt>
 *
 * 覆盖范围（PM 2026-10-20 要求"含源码/测试/协议产物与 Host/Client 全产物"）：
 *   - packages/protocol/**（含 dist 产物与 src 源码、测试）
 *   - packages/dsh-gamecenter/**（staging 产物、src 源码、test、配置文件）
 *   - packages/dsh-gamecenter-client/**（staging + lib + src + test + tools + 配置）
 *   - packages/dsh-gamecenter-catalog/**（src + test + 配置）
 *   - tests/integration/**、tools/*.mjs、docs/phase1-*.md、根 package.json / pnpm-workspace.yaml
 * 排除：node_modules、staging-rollback、日志与临时文件。
 *
 * 证据分栏：本文件只描述**本地文件状态**，不含任何 DSH-REAL 结论。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const stdoutOnly = args.includes('--stdout')
const compareIndex = args.indexOf('--compare')
const compareWith = compareIndex >= 0 ? args[compareIndex + 1] : undefined

/** 采集根（目录或文件）。顺序即输出顺序。 */
const TARGETS = [
  'packages/protocol/src',
  'packages/protocol/test',
  'packages/protocol/dist',
  'packages/protocol/package.json',
  'packages/protocol/tsconfig.json',
  'packages/protocol/tsconfig.build.json',
  'packages/dsh-gamecenter/src',
  'packages/dsh-gamecenter/test',
  'packages/dsh-gamecenter/staging',
  'packages/dsh-gamecenter/package.json',
  'packages/dsh-gamecenter/tsconfig.json',
  'packages/dsh-gamecenter/tsconfig.build.json',
  'packages/dsh-gamecenter/tsconfig.staging.json',
  'packages/dsh-gamecenter/cordis.patch.yml',
  'packages/dsh-gamecenter-client/src',
  'packages/dsh-gamecenter-client/test',
  'packages/dsh-gamecenter-client/tools',
  'packages/dsh-gamecenter-client/staging',
  'packages/dsh-gamecenter-client/lib',
  'packages/dsh-gamecenter-client/package.json',
  'packages/dsh-gamecenter-client/tsconfig.json',
  'packages/dsh-gamecenter-catalog/src',
  'packages/dsh-gamecenter-catalog/test',
  'packages/dsh-gamecenter-catalog/package.json',
  'tests/integration',
  'tools',
  'package.json',
  'pnpm-workspace.yaml',
  'docs/phase1-production-wiring.md',
]

const EXCLUDE_DIR = new Set(['node_modules', 'staging-rollback', '.git', '.head-tests', 'red-tests-tmp'])
const EXCLUDE_FILE = /\.log$|\.tmp$|~$/

/** @type {{path: string, bytes: number, sha256: string}[]} */
const rows = []

function walk(absolute, relative) {
  const stat = statSync(absolute)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbs = path.join(absolute, entry.name)
      const childRel = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (EXCLUDE_DIR.has(entry.name)) continue
        walk(childAbs, childRel)
      } else if (entry.isFile()) {
        if (EXCLUDE_FILE.test(entry.name)) continue
        add(childAbs, childRel)
      }
    }
    return
  }
  add(absolute, relative)
}

function add(absolute, relative) {
  const bytes = readFileSync(absolute)
  rows.push({
    path: relative.split(path.sep).join('/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  })
}

for (const target of TARGETS) {
  const absolute = path.join(ROOT, target)
  if (!existsSync(absolute)) {
    rows.push({ path: `${target}  (MISSING)`, bytes: -1, sha256: '-' })
    continue
  }
  walk(absolute, target)
}

rows.sort((a, b) => a.path.localeCompare(b.path))

const header = [
  '# 阶段1 唯一候选 manifest（本地，未部署）',
  `# 采集时间: ${new Date().toISOString()}`,
  '# 证据分栏: MOCK/BUILD，非 DSH-REAL',
  '# 格式: SHA256  BYTES  PATH',
  `# 文件数: ${rows.length}`,
  '',
]
const body = rows.map((row) => `${row.sha256}  ${String(row.bytes).padStart(8)}  ${row.path}`)
const text = `${header.join('\n')}\n${body.join('\n')}\n`

if (compareWith !== undefined) {
  const before = readFileSync(path.resolve(ROOT, compareWith), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const after = body
  const beforeSet = new Map(before.map((line) => [line.slice(line.lastIndexOf('  ') + 2), line]))
  const afterSet = new Map(after.map((line) => [line.slice(line.lastIndexOf('  ') + 2), line]))

  const removed = [...beforeSet.keys()].filter((key) => !afterSet.has(key))
  const added = [...afterSet.keys()].filter((key) => !beforeSet.has(key))
  const changed = [...beforeSet.keys()].filter((key) => afterSet.has(key) && beforeSet.get(key) !== afterSet.get(key))

  const identical = removed.length === 0 && added.length === 0 && changed.length === 0
  console.log(`验前/验后比对：${identical ? 'IDENTICAL' : 'DIFFERENT'}`)
  for (const key of removed) console.log(`  已消失: ${key}`)
  for (const key of added) console.log(`  新增:   ${key}`)
  for (const key of changed) console.log(`  已变更: ${key}`)
  process.exit(identical ? 0 : 1)
}

if (stdoutOnly) {
  console.log(text)
} else {
  writeFileSync(path.join(ROOT, 'docs/phase1-candidate-manifest.txt'), text, 'utf8')
  console.log(`已写入 docs/phase1-candidate-manifest.txt（${rows.length} 个文件）`)
}
