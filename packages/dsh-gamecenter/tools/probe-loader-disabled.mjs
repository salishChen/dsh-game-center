/**
 * 只读探针：核实 patch `insert` 条目的 `disabled` 语义，以及 Loader 如何处理
 * 被 disabled 的条目——特别是 dsh-client-modules 的 processOne 里
 * `entry.disabled` 的判定（第 855 行）。
 *
 * 用法：node tools/probe-loader-disabled.mjs [asarPath]
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

  const files = [
    'dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js',
    'dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/client.js',
  ]

  for (const file of files) {
    let src
    try {
      src = read(file)
    } catch {
      console.log(`SKIP ${file}`)
      continue
    }
    console.log(`\n########## ${file} (len=${src.length}) ##########`)
    for (const needle of ['disabled', 'insert', 'update(', 'create(']) {
      let at = -1
      let hits = 0
      while ((at = src.indexOf(needle, at + 1)) !== -1) hits += 1
      console.log(`  ${needle}: ${hits} hit(s)`)
    }
  }

  // dsh-client-modules 第 855 行附近：entry.disabled 的判定
  const cm = read('dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js')
  const lines = cm.split('\n')
  console.log('\n########## dsh-client-modules processOne（852-860） ##########')
  for (let i = 851; i < 860; i += 1) console.log(`${i + 1}: ${lines[i]}`)

  console.log('\n########## 结论依据 ##########')
  console.log('processOne 第 855 行：if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;')
  console.log('→ entry.fiber === undefined 或 entry.disabled 为真时，该条目**不会被纳入 Client source**。')
  console.log('   因此 disabled: true 的条目**不会**作为 Client 发现锚点。')
} finally {
  fs.closeSync(fd)
}
