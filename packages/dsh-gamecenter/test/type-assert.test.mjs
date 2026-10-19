import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 守卫：证明编译期一致性断言**真的会失败**，而不是形同虚设。
 *
 * 背景：我最初写的 `type X = A extends B ? true : never` 被项目经理与架构与协议负责人
 * 同时指出不成立——`never` 是底类型，把 `true` 断言成 `never` 不会报错。
 * 本测试用一份**故意漏字段**的负例编译，要求 tsc 必须报 TS2344。
 * 若有一天断言被改回假形式，本测试会失败。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const negativeFile = path.join(pkgDir, 'tools', 'assert-negative-check.ts')

test('负例文件存在', () => {
  assert.ok(fs.existsSync(negativeFile))
})

test('Assert<T extends true> 对不满足协议的类型必须报 TS2344', () => {
  const tscBin = path.join(pkgDir, 'node_modules', '.bin', 'tsc')
  const tscCandidates = [
    tscBin,
    path.join(pkgDir, '..', '..', 'node_modules', '.bin', 'tsc'),
  ]
  const tsc = tscCandidates.find((candidate) => fs.existsSync(candidate))
  assert.ok(tsc !== undefined, '找不到 tsc 可执行文件')

  let stdout = ''
  let exitCode = 0
  try {
    // Windows 上 .bin/tsc 是 .cmd，必须经 shell 调用。
    stdout = execFileSync(tsc, [
      '--strict',
      '--noEmit',
      '--target', 'ES2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      negativeFile,
    ], { encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32' })
  } catch (error) {
    const failure = /** @type {{stdout?: string, stderr?: string, status?: number}} */ (error)
    stdout = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    exitCode = failure.status ?? 1
  }

  assert.notEqual(exitCode, 0, '负例竟然编译通过，说明断言没有真正生效')
  const ts2344Count = (stdout.match(/TS2344/g) ?? []).length
  assert.equal(ts2344Count, 2, `期望两条 TS2344（漏字段 + 字段类型放宽），实际 ${ts2344Count} 条：\n${stdout}`)
})
