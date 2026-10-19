/**
 * 只读探针：核实 Client 一元调用如何编码参数 / 使用 codec，
 * 以及 installNamespace 如何把 descriptor 变成可调用方法。
 */
import fs from 'node:fs'

const asarPath = process.argv[2] ?? 'D:/Program Files/deepseek harness/resources/app.asar'
const file = process.argv[3]
  ?? 'dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js'
const needles = process.argv.slice(4)

const fd = fs.openSync(asarPath, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const base = 16 + jsonLen
  let cur = header
  for (const part of file.split('/')) {
    cur = cur?.files?.[part]
    if (!cur) throw new Error(`not in asar: ${file}`)
  }
  const buf = Buffer.alloc(cur.size)
  fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset))
  const src = buf.toString('utf8')

  const list = needles.length > 0 ? needles : ['async installNamespace', 'codec.encode', 'parameter.codec']
  for (const needle of list) {
    const at = src.indexOf(needle)
    console.log(`\n### ${needle} @${at}`)
    if (at >= 0) console.log(src.slice(Math.max(0, at - 700), at + 2000))
  }
} finally {
  fs.closeSync(fd)
}
