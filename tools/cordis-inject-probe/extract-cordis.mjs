/**
 * 从本机已安装 DSH 的 asar 中释放**真实** Cordis 运行时到临时目录，供离线复现使用。
 *
 * 只读 asar，不修改安装目录、不改运行中 GUI。
 * 运行：node tools/cordis-inject-probe/extract-cordis.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ASAR = 'D:\\Program Files\\deepseek harness\\resources\\app.asar'
const OUT = path.join(os.tmpdir(), 'cordis-real')

/** 读取 asar 头部目录表。 */
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
const dshNodeModules = root.files.dsh.files.node_modules.files
const scope = dshNodeModules['@deepseek-ai'].files

fs.rmSync(OUT, { recursive: true, force: true })

/** 释放一个包到 node_modules 布局。 */
function emit(label, entry, dest) {
  const files = walk(entry, '')
  for (const [rel, child] of files) {
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readEntry(child))
  }
  console.log(`${label} -> ${files.length} files`)
}

emit('@deepseek-ai/cordis', scope.cordis, path.join(OUT, 'node_modules', '@deepseek-ai', 'cordis'))
emit('@deepseek-ai/cosmokit', scope.cosmokit, path.join(OUT, 'node_modules', '@deepseek-ai', 'cosmokit'))

const standard = dshNodeModules['@standard-schema']?.files?.spec
if (standard) emit('@standard-schema/spec', standard, path.join(OUT, 'node_modules', '@standard-schema', 'spec'))
else console.log('警告：@standard-schema/spec 不在 asar 内，可能影响 cordis 加载')

fs.writeFileSync(
  path.join(OUT, 'package.json'),
  JSON.stringify({ name: 'cordis-real', type: 'module', private: true }, null, 2),
)

// 记录来源构建版本，便于证据溯源。
const desktopPkg = JSON.parse(readEntry(root.files['package.json']))
fs.writeFileSync(
  path.join(OUT, 'SOURCE.json'),
  JSON.stringify(
    {
      asar: ASAR,
      productName: desktopPkg.name,
      productVersion: desktopPkg.version,
      dshBuildCommit: desktopPkg.dshBuildCommit,
      dshBuildDirty: desktopPkg.dshBuildDirty,
    },
    null,
    2,
  ),
)
console.log(`extracted to ${OUT}`)
console.log(`source: ${desktopPkg.name}@${desktopPkg.version} commit=${desktopPkg.dshBuildCommit}`)
fs.closeSync(fd)
