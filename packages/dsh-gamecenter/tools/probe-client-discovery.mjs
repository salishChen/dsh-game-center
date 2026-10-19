/**
 * 只读探针：核实 dsh-client-modules 如何发现并下发 Client bundle，
 * 特别是 Loader 条目（loaderName）与 Client 包之间的绑定关系。
 *
 * 关键问题：Client 包的 Host 半必须作为 Loader 条目被装载，Client 半才会被发现。
 * 需要确认 locatePkgJson / sourceKey / compose 的具体判据。
 *
 * 用法：node tools/probe-client-discovery.mjs [asarPath]
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

  const src = read('dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js')
  const lines = src.split('\n')
  console.log(`dsh-client-modules/lib/index.js len=${src.length} lines=${lines.length}`)

  const show = (label, from, to) => {
    console.log(`\n########## ${label} (${from}..${to}) ##########`)
    for (let i = from - 1; i < Math.min(to, lines.length); i += 1) {
      console.log(`${i + 1}: ${lines[i]}`)
    }
  }

  show('locatePkgJson', 761, 830)
  show('sourceKey', 690, 720)
  show('compose / bootInjections', 860, 960)
} finally {
  fs.closeSync(fd)
}
