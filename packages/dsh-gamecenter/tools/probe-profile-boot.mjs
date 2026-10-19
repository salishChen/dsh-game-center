/**
 * 只读探针：核实 profile 装配流程（dsh-app-boot）。
 * 目标回答：本地包如何被 Loader 装载、Client bundle 如何被解析、engines.dsh 如何校验。
 *
 * 用法：node tools/probe-profile-boot.mjs [asarPath] [needle...]
 */
import fs from 'node:fs'

const asarPath = process.argv[2] ?? 'D:/Program Files/deepseek harness/resources/app.asar'
const funde = process.argv.slice(3)

const fd = fs.openSync(asarPath, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const base = 16 + jsonLen

  const read = (innerPath) => {
    let cur = header
    for (const part of innerPath.split('/')) {
      cur = cur?.files?.[part]
      if (!cur) throw new Error(`not in asar: ${innerPath}`)
    }
    const buf = Buffer.alloc(cur.size)
    fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset))
    return buf.toString('utf8')
  }

  const boot = read('dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
  console.log(`dsh-app-boot/lib/index.js len=${boot.length}`)

  const needles = funde.length > 0
    ? funde
    : ['loadProfileDirectory', 'resolveBundleDir', 'unmetRequirements', 'profile.bundles', 'cordis.patch']

  for (const needle of needles) {
    const at = boot.indexOf(needle)
    console.log(`\n##### ${needle} @${at}`)
    if (at >= 0) console.log(boot.slice(Math.max(0, at - 500), at + 1800))
  }
} finally {
  fs.closeSync(fd)
}
