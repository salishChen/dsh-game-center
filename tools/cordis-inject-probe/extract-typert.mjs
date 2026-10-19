/**
 * 从 asar 释放 **真实** `@deepseek-ai/dsh-typert-protocol`（及其依赖）到临时目录，
 * 供「Host 服务是否真的被 Gateway 认领」的装配复现使用。
 *
 * 只读 asar，不修改安装目录。
 * 运行：node tools/cordis-inject-probe/extract-typert.mjs
 * 前置：已运行 extract-cordis.mjs（复用同一个临时根目录）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ASAR = 'D:\\Program Files\\deepseek harness\\resources\\app.asar'
const OUT = path.join(os.tmpdir(), 'cordis-real')

function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const raw = Buffer.alloc(headerSize)
  fs.readSync(fd, raw, 0, headerSize, 16)
  const root = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''))
  const readEntry = (entry) => {
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, 16 + headerSize + Number(entry.offset))
    return buf.toString('utf8')
  }
  return { fd, root, readEntry }
}

const walk = (entry, prefix) => {
  const out = []
  if (!entry.files) return out
  for (const [name, child] of Object.entries(entry.files)) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) out.push(...walk(child, p))
    else out.push([p, child])
  }
  return out
}

const { fd, root, readEntry } = openAsar(ASAR)
const scope = root.files.dsh.files.node_modules.files['@deepseek-ai'].files

fs.mkdirSync(OUT, { recursive: true })

function emit(label, entry, dest) {
  const files = walk(entry, '')
  for (const [rel, child] of files) {
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readEntry(child))
  }
  console.log(`${label} -> ${files.length} files`)
}

emit(
  '@deepseek-ai/dsh-typert-protocol',
  scope['dsh-typert-protocol'],
  path.join(OUT, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol'),
)

// 协议包的 dependencies 之一；缺它会在 import 阶段失败。
const brand = scope['dsh-brand']
if (brand) emit('@deepseek-ai/dsh-brand', brand, path.join(OUT, 'node_modules', '@deepseek-ai', 'dsh-brand'))
else console.log('警告：@deepseek-ai/dsh-brand 不在 asar 内')

const desktopPkg = JSON.parse(readEntry(root.files['package.json']))
console.log(`extracted to ${OUT}`)
console.log(`source: ${desktopPkg.name}@${desktopPkg.version} commit=${desktopPkg.dshBuildCommit}`)
fs.closeSync(fd)
