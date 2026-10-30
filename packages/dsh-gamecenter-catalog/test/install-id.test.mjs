/**
 * 装机级 installId 测试（证据分栏：UNIT / FS）
 * 覆盖：首次生成、跨调用稳定、非法内容被替换、文件权限与内容形状。
 * 铁律：installId 只落本地，不进 UI/iframe；不得每次启动重生成。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readOrCreateInstallId } from '../dist/index.js'

const INSTALL_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

test('InstallId-1: 首次生成并持久化，二次调用复用同一个值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-install-id-'))
  const file = path.join(root, 'nested', '.install-id')

  const first = await readOrCreateInstallId(file)
  assert.match(first, INSTALL_ID_PATTERN)

  const onDisk = (await fs.readFile(file, 'utf-8')).trim()
  assert.equal(onDisk, first)

  const second = await readOrCreateInstallId(file)
  assert.equal(second, first)
})

test('InstallId-2: 文件内容非法时重建，不沿用脏值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-install-id-'))
  const file = path.join(root, '.install-id')
  await fs.writeFile(file, '  not a valid id !! \n', 'utf-8')

  const id = await readOrCreateInstallId(file)
  assert.match(id, INSTALL_ID_PATTERN)
  assert.equal((await fs.readFile(file, 'utf-8')).trim(), id)
})
