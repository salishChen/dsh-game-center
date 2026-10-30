import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createInstallId } from './reportClient.js'

/**
 * 装机级 `installId` 的读取/创建（契约 §3 条款 14）。
 *
 * 语义：
 * - 首次启用时生成一次，之后长期复用；**不得**每次启动重生成，否则去重键失效、统计虚高；
 * - 只存在于 Host 本地，用户看不到，也不进 UI/iframe；
 * - 写入用临时文件原子替换；本包的 `node:fs` shim 不支持 mode，文件权限随系统 umask。
 */

const INSTALL_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

export async function readOrCreateInstallId(filePath: string): Promise<string> {
  try {
    const existing = (await fs.readFile(filePath, 'utf-8')).trim()
    if (INSTALL_ID_PATTERN.test(existing)) return existing
  } catch {
    // 文件不存在或不可读：下面重建
  }

  const id = createInstallId()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${Date.now()}`
  // 注意：本包的 `node:fs` 是手写 shim，`writeFile` 第三参只接受编码字符串（无 mode 选项）。
  await fs.writeFile(tmpPath, `${id}\n`, 'utf-8')
  await fs.rename(tmpPath, filePath)
  return id
}
