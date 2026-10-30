/**
 * 安装记录版本号回归（2026-10-28 真机缺陷）：
 *
 * 三个游戏的 `<gameId>/<commit>/.dsh-installed.json` 里 `version` 全是 `1.0.0`，
 * 而包内 `gamecenter.json` 分别是 0.3.2 / 0.2.0 / 1.0.0。原因是 Host 侧构造安装计划时
 * 写了一个常量占位符，安装器又原样抄进记录里 —— 凡是从这个文件读版本的审计与展示都会报错。
 *
 * 现在的契约：安装记录里的 version **必须**等于**已通过 digest 校验的包内清单**里的 version，
 * 即使调用方给的 plan.version 是错的占位符。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  installGamePackage,
  calculateManifestDigest,
  calculateBundleDigest,
} from '../dist/index.js'

function makeManifest(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'example.versioned',
    name: '带真实版本号的游戏',
    version: '0.3.2',
    sdk: '^1.0.0',
    runtime: { kind: 'web', entry: 'dist/index.html' },
    permissions: { storage: 'game-scoped', directNetwork: false },
    ...overrides,
  })
}

async function installOnce({ planVersion, manifestContent }) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-meta-'))
  const packagesDir = path.join(tmpRoot, 'packages')
  const stagingDir = path.join(tmpRoot, 'staging')
  const commit = 'a'.repeat(40)
  const files = [
    { path: 'dist/index.html', content: Buffer.from('<html>versioned</html>') },
  ]

  const res = await installGamePackage({
    plan: {
      gameId: 'example.versioned',
      version: planVersion,
      repository: 'https://github.com/salishChen/dsh-game-versioned',
      commit,
      manifestPath: 'gamecenter.json',
      manifestDigest: calculateManifestDigest(manifestContent),
      bundleDigest: calculateBundleDigest(files).bundleDigest,
      installDir: `example.versioned/${commit}`,
      approvalRecordPath: 'approvals/v1.json',
    },
    manifestContent,
    files,
    packagesDir,
    stagingDir,
  })

  return { res, tmpRoot, commit }
}

test('安装记录的 version 取自包内清单，而不是调用方传入的占位符', async () => {
  const manifestContent = makeManifest({ version: '0.3.2' })
  // plan.version 故意给成旧缺陷里的常量：安装记录仍必须是 0.3.2。
  const { res, tmpRoot, commit } = await installOnce({ planVersion: '1.0.0', manifestContent })

  assert.equal(res.ok, true, res.ok ? '' : `${res.code}: ${res.reason}`)

  const metaPath = path.join(tmpRoot, 'packages', 'example.versioned', commit, '.dsh-installed.json')
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))

  assert.equal(meta.version, '0.3.2')
  assert.notEqual(meta.version, '1.0.0')
  // 其余字段未受影响
  assert.equal(meta.gameId, 'example.versioned')
  assert.equal(meta.commit, commit)
})

test('包内清单版本与调用方一致时按原值写入（不引入额外改写）', async () => {
  const manifestContent = makeManifest({ version: '0.2.0' })
  const { res, tmpRoot, commit } = await installOnce({ planVersion: '0.2.0', manifestContent })

  assert.equal(res.ok, true, res.ok ? '' : `${res.code}: ${res.reason}`)

  const metaPath = path.join(tmpRoot, 'packages', 'example.versioned', commit, '.dsh-installed.json')
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
  assert.equal(meta.version, '0.2.0')
})
