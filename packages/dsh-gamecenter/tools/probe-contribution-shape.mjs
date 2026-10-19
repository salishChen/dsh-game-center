/**
 * 只读探针：提取 dsh-api-gateway Client 侧 `validateContribution` / `requireStrictInputs` /
 * `scopedProjection` / `installNamespace` 的真实实现，用于逐字段核实外部 contribution 形状。
 *
 * 用法：node tools/probe-contribution-shape.mjs [asarPath] [needle...]
 */
import fs from 'node:fs'

const asarPath = process.argv[2] ?? 'D:/Program Files/deepseek harness/resources/app.asar'
const extra = process.argv.slice(3)

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

  // Client 侧实现可能在 client.js / client.browser.js / types/client/index.js 三处之一。
  const candidates = [
    'dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js',
    'dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js',
    'dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/index.js',
  ]

  const needles = extra.length > 0
    ? extra
    : ['requireStrictInputs', 'scopedProjection', 'validateContribution', 'installNamespace']

  for (const file of candidates) {
    let src
    try {
      src = read(file)
    } catch {
      console.log(`--- SKIP ${file} (not found)`)
      continue
    }
    console.log(`\n############ ${file}  (len=${src.length}) ############`)
    for (const needle of needles) {
      const at = src.indexOf(needle)
      if (at === -1) {
        console.log(`\n=== ${needle}: NOT FOUND`)
        continue
      }
      console.log(`\n=== ${needle} @${at}`)
      console.log(src.slice(Math.max(0, at - 300), at + 1600))
    }
  }
} finally {
  fs.closeSync(fd)
}
