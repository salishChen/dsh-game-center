/**
 * 授权执行前自检（只读）：把 §12 授权动作的**全部前置条件**一次性核对。
 *
 * 不修改任何文件、不触碰 profile。输出 humans 可逐条核对的清单。
 * 任何一项 FAIL 都表示「现在还不能执行授权动作」。
 *
 * 用法：node tools/check-authorization-ready.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const hostDir = path.resolve(here, '..')
const repo = path.resolve(hostDir, '..', '..')
const clientDir = path.join(repo, 'packages', 'dsh-gamecenter-client')
const protocolDir = path.join(repo, 'packages', 'protocol')
const profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

/** 绑定 QA 稳定快照的产物摘要（见 docs/phase0-host.md §12.10）。 */
const BOUND_DIGESTS = {
  [path.join(hostDir, 'cordis.patch.yml')]:
    '9033468FBCBEDDE19CAB03E14623A327BA2AE5B21F82E96E7C083883C566A235',
  [path.join(hostDir, 'lib', 'index.js')]:
    '36A01FBBEB4DA75A698AD6A1B6E9D6ABA210DBA4ADA6A90EED3E5D164BC9CEE9',
  [path.join(clientDir, 'dist', 'client.js')]:
    '9CEAC9E0DEF38DBF5882DF48CAA4B734F2DE8F1677879CB0998E4A723AE2A610',
  [path.join(protocolDir, 'dist', 'index.js')]:
    'E4C11E5B20F1740F7BFC7EDC57B6CD5AFBE53E8BD13A2EB3D6193F946540AB1D',
}

const results = []
function record(label, ok, detail) {
  results.push({ label, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ---- 1. 绑定产物摘要一致 ----
console.log('=== 1. 产物摘要（绑定 §12.10）===')
for (const [file, expected] of Object.entries(BOUND_DIGESTS)) {
  if (!fs.existsSync(file)) {
    record(`产物存在: ${path.basename(path.dirname(file))}/${path.basename(file)}`, false, '文件不存在，需先构建')
    continue
  }
  const actual = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
  record(
    `摘要匹配: ${path.relative(repo, file).split(path.sep).join('/')}`,
    actual === expected,
    actual === expected ? 'MATCH' : `expected=${expected.slice(0, 16)}… actual=${actual.slice(0, 16)}…`,
  )
}

// ---- 2. 两个包具备可加载形态 ----
console.log('\n=== 2. 包形态（Loader 装载前提）===')
const hostPkg = readJson(path.join(hostDir, 'package.json'))
record('Host 声明 dsh.bundle.patch', typeof hostPkg.dsh?.bundle?.patch === 'string', hostPkg.dsh?.bundle?.patch)
record(
  'Host patch 文件存在',
  fs.existsSync(path.join(hostDir, hostPkg.dsh.bundle.patch)),
  hostPkg.dsh.bundle.patch,
)
const patchText = fs.readFileSync(path.join(hostDir, hostPkg.dsh.bundle.patch), 'utf8')
const loaderNames = [...patchText.matchAll(/^\s*-\s*id:\s*\S+\s*\n\s*name:\s*"([^"]+)"/gm)].map((m) => m[1])
record('patch 含两条独立 Loader 条目', loaderNames.length === 2, loaderNames.join(', '))
record(
  'patch 含 client 条目（发现必需）',
  loaderNames.includes('@dsh-gamecenter/client'),
  'locatePkgJson 第 765 行：expectedPackageName 恒等于条目名',
)

const clientPkg = readJson(path.join(clientDir, 'package.json'))
record('Client platform=web', clientPkg.dsh?.client?.platform === 'web', String(clientPkg.dsh?.client?.platform))
const clientRel = clientPkg.exports?.['./client']?.default
record('Client exports["./client"] 指向真实文件', typeof clientRel === 'string' && fs.existsSync(path.join(clientDir, clientRel)), clientRel)
const hostHalfRel = clientPkg.exports?.['.']?.default
record('Client Host 半存在（Node 可加载）', typeof hostHalfRel === 'string' && fs.existsSync(path.join(clientDir, hostHalfRel)), hostHalfRel)

// ---- 3. 仓库内 workspace 链接（Host 依赖解析保险）----
console.log('\n=== 3. 仓库内 workspace 链接 ===')
for (const name of ['client', 'protocol']) {
  const link = path.join(hostDir, 'node_modules', '@dsh-gamecenter', name)
  record(`host/node_modules/@dsh-gamecenter/${name} 存在`, fs.existsSync(path.join(link, 'package.json')), link)
}

// ---- 4. profile 侧现状（授权动作要改的目标）----
console.log('\n=== 4. 目标 profile 现状（授权动作将在此处改）===')
record('profile 目录存在', fs.existsSync(profileDir), profileDir)
const profilePkgPath = path.join(profileDir, 'package.json')
const profilePkg = readJson(profilePkgPath)
const bundles = profilePkg.dsh?.profile?.bundles ?? []
record('profile 尚未含 @dsh-gamecenter/host', bundles.includes('@dsh-gamecenter/host') === false, `当前 ${bundles.length} 条 bundle`)
record(
  'profile node_modules 尚无 @dsh-gamecenter（需建两个 junction）',
  fs.existsSync(path.join(profileDir, 'node_modules', '@dsh-gamecenter')) === false,
  '若已存在说明上次未回滚，请先核查',
)
const profilePatch = path.join(profileDir, 'cordis.patch.yml')
record('profile cordis.patch.yml 存在（需备份）', fs.existsSync(profilePatch), `${fs.existsSync(profilePatch) ? fs.statSync(profilePatch).size : 0} bytes`)

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length > 0) {
  console.log('未通过项：')
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` (${f.detail})` : ''}`)
  console.log('\n结论：**尚不能执行授权动作**，请先处理上面未通过项。')
  process.exit(1)
}
console.log('结论：前置条件齐备，授权动作可执行（仍需用户批准；执行方按 §12.3 顺序操作）。')
console.log('提醒：本脚本只读，未修改 profile。')
