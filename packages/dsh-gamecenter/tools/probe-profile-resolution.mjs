/**
 * 只读推演：目标 profile 会从哪些目录解析裸包名。
 *
 * 复刻 dsh-app-boot/lib/index.js packageDirFromAnchor：
 *   for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
 *     const candidate = join(searchPath, packageName)
 *     if (existsSync(join(candidate, "package.json"))) return candidate
 *   }
 *
 * 不写任何文件，只打印搜索路径与命中情况。
 *
 * 用法：node tools/probe-profile-resolution.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const anchor = path.join(profileDir, 'package.json')

const packages = ['@dsh-gamecenter/host', '@dsh-gamecenter/client', '@dsh-gamecenter/protocol']

console.log(`profile: ${profileDir}`)
console.log(`anchor : ${anchor}`)
console.log(`profile 目录存在: ${fs.existsSync(profileDir)}`)

for (const name of packages) {
  console.log(`\n=== ${name} ===`)
  let paths
  try {
    paths = createRequire(anchor).resolve.paths(name) ?? []
  } catch (error) {
    console.log(`  createRequire().resolve.paths 抛错: ${error.message}`)
    continue
  }
  console.log(`  搜索路径（按顺序，共 ${paths.length}）:`)
  let hit
  for (const searchPath of paths) {
    const candidate = path.join(searchPath, name)
    const ok = fs.existsSync(path.join(candidate, 'package.json'))
    if (ok) hit = candidate
    console.log(`    ${ok ? 'HIT ' : '    '}${candidate}`)
  }
  console.log(`  解析结果: ${hit ?? '未解析到（resolveBundleDir 会 throw / Loader 会 ERR_MODULE_NOT_FOUND）'}`)
}

console.log('\n=== 结论要点 ===')
console.log('1. profile 的解析根是 `<profile>/node_modules` 等 search paths，')
console.log('   **不是本仓库的 workspace node_modules**。两者互不相通。')
console.log('2. 因此仅在本仓库写好 package.json/dsh.bundle 不够，')
console.log('   目标 profile 侧必须能解析到这两个包（链接或安装）。')
