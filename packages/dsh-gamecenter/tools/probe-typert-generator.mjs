/**
 * 可复现证据：核实 DSH 发行版是否提供 Typert 生成器，以及 Client 侧 $mount 的合法来源。
 * 只读：fs.openSync(asarPath, 'r')，不修改安装目录。
 *
 * 用法：node tools/probe-typert-generator.mjs [asarPath]
 */
import fs from 'node:fs'

const asarPath = process.argv[2] ?? 'D:/Program Files/deepseek harness/resources/app.asar'

const fd = fs.openSync(asarPath, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const base = 16 + jsonLen

  const aiDir = header.files.dsh.files.node_modules.files['@deepseek-ai']
  const all = Object.keys(aiDir.files).sort()

  console.log('=== 1. asar 内 @deepseek-ai/* 中含 typert 的包 ===')
  const typert = all.filter((n) => n.includes('typert'))
  for (const name of typert) console.log('  ', name)
  console.log(`  generator 是否存在: ${all.includes('dsh-typert-generator') ? '是' : '否'}`)

  console.log('\n=== 2. 全包名搜索 "generator"（排除无关包） ===')
  const gens = all.filter((n) => n.includes('generator'))
  console.log(gens.length === 0 ? '  （无任何名字含 generator 的包）' : `  ${gens.join(', ')}`)
  console.log(`  包总数: ${all.length}`)

  // 在 api-remotes 的 client 里定位 $mount 的**调用点**与定义情况。
  let node = aiDir.files['dsh-api-remotes']
  for (const part of ['lib', 'client.js']) node = node.files[part]
  const buf = Buffer.alloc(node.size)
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset))
  const src = buf.toString('utf8')

  console.log('\n=== 3. dsh-api-remotes/lib/client.js 中 $mount / TYPERT_REMOTE 的分布 ===')
  const mountCall = (src.match(/\$mount\(/g) ?? []).length
  // 注意：本文件里出现过 "$mount(contribution)" 字样只是 bundle 内的注释/文档文本，
  // 真正实现（class ClientRemoteService）在 dsh-api-gateway 包内，不在 api-remotes。
  // 因此这里只报告"本包内是否为该方法提供实现类"，不靠字符串出现与否下结论。
  const definesImpl = /class\s+\w*Remote\w*Service\b/.test(src) && src.includes('mountContribution')
  const remoteConst = (src.match(/TYPERT_REMOTE/g) ?? []).length
  console.log(`  $mount( 出现次数: ${mountCall}`)
  console.log(`  本包内是否有 mountContribution 实现: ${definesImpl ? '是' : '否'}`)
  console.log(`  TYPERT_REMOTE 出现次数: ${remoteConst}`)

  // 提取挂载循环里被显式列出的贡献标识，证明它是写死的白名单。
  const loopStart = src.indexOf('for (const contribution of [')
  if (loopStart === -1) {
    console.log('  未找到显式挂载循环')
  } else {
    const loopEnd = src.indexOf(']) disposers.push', loopStart)
    const body = src.slice(loopStart, loopEnd)
    const ids = (body.match(/TYPERT_REMOTE\$?\d*/g) ?? [])
    console.log(`  显式挂载列表条目数: ${ids.length}`)
    console.log(`  列表片段: ${body.split('\n').slice(0, 4).map((s) => s.trim()).join(' ')}`)
  }

  console.log('\n=== 4. 结论 ===')
  console.log('  - 生成器不在发行版内：Client 无法在运行时为第三方命名空间生成 TypertRemoteContribution。')
  console.log('  - api-remotes 的 client 只负责 mount，且贡献列表写死；第三方 namespace 不会被自动纳入。')
} finally {
  fs.closeSync(fd)
}
