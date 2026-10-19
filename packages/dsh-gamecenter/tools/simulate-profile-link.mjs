/**
 * 隔离模拟：不修改真实 profile，在临时目录里搭一个"像 profile 一样的"结构，
 * 用 junction 把我们的包链进去，验证两件事：
 *
 * 1. `import('@dsh-gamecenter/host')` 能否从该结构解析到我们的 Host 包；
 * 2. Host 包内部的 `import '@dsh-gamecenter/client'`（workspace:* 依赖）
 *    在**穿过 junction/符号链接**之后是否仍能解析。
 *
 * 第 2 点是真实风险：Node 默认解析 realpath，因此依赖会从仓库真实路径去找；
 * 但若 DSH 用了 preserveSymlinks 或解析根不同，就会 ERR_MODULE_NOT_FOUND。
 *
 * 用法：node tools/simulate-profile-link.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const hostDir = path.resolve(here, '..')
const repo = path.resolve(hostDir, '..', '..')
const clientDir = path.join(repo, 'packages', 'dsh-gamecenter-client')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-sim-'))
const fakeProfileModules = path.join(sandbox, 'node_modules')

function cleanup() {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

try {
  console.log(`沙盒: ${sandbox}`)
  fs.mkdirSync(path.join(fakeProfileModules, '@dsh-gamecenter'), { recursive: true })

  // 用 junction（Windows 下不需要管理员权限）
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const hostLink = path.join(fakeProfileModules, '@dsh-gamecenter', 'host')
  const clientLink = path.join(fakeProfileModules, '@dsh-gamecenter', 'client')
  fs.symlinkSync(hostDir, hostLink, linkType)
  fs.symlinkSync(clientDir, clientLink, linkType)
  console.log(`已建 junction: host -> ${hostDir}`)
  console.log(`已建 junction: client -> ${clientDir}`)

  // 检查 1：从沙盒能否解析裸包名
  const probe = path.join(sandbox, 'probe.mjs')
  fs.writeFileSync(probe, `
import { createRequire } from 'node:module'
const require_ = createRequire(${JSON.stringify(probe)})
const out = {}
for (const name of ['@dsh-gamecenter/host', '@dsh-gamecenter/client']) {
  try { out[name] = require_.resolve(name) } catch (e) { out[name] = 'FAIL:' + e.code }
}
console.log('RESOLVE ' + JSON.stringify(out))
try {
  const m = await import('@dsh-gamecenter/host')
  console.log('IMPORT-HOST OK exports=' + Object.keys(m).join(','))
} catch (e) {
  console.log('IMPORT-HOST FAIL ' + e.code + ' ' + e.message.split('\\n')[0])
}
`, 'utf8')

  const run = (cwd) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['--input-type=module', '-e', fs.readFileSync(probe, 'utf8')], { cwd, encoding: 'utf8', stdio: 'pipe' }) }
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  }

  console.log('\n=== 从沙盒（模拟 profile 解析根）执行 ===')
  const result = run(sandbox)
  console.log(result.out.trim())
  console.log(`exit=${result.code}`)

  console.log('\n=== 结论 ===')
  const resolveOk = /"@dsh-gamecenter\/host":"[^"]*dsh-gamecenter[^"]*index\.js"/.test(result.out)
  const importOk = result.out.includes('IMPORT-HOST OK')
  console.log(`裸包名可从"profile 解析根"解析: ${resolveOk}`)
  console.log(`Host 包可被 import（含依赖穿过 junction 解析）: ${importOk}`)
  if (resolveOk && importOk) {
    console.log('→ junction/符号链接方案在 Node 语义下成立（依赖按 realpath 从仓库解析）。')
    console.log('  前提：仓库内 packages/dsh-gamecenter/node_modules/@dsh-gamecenter/{client,protocol} 链接存在。')
  } else {
    console.log('→ 该方案在 Node 语义下不成立，需要改用 profile 依赖安装方式。')
  }
} finally {
  cleanup()
  console.log(`\n沙盒已清理: ${!fs.existsSync(sandbox)}`)
}
