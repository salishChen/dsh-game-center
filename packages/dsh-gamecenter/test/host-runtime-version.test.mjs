/**
 * Host 运行版本解析器与门禁测试套件（证据分栏：UNIT / MOCK）
 *
 * 覆盖：
 * 1. 离线受控 fixture：argv[2] 对应目录 desktop-runtime.json 与 package.json 版本一致且为合法 SemVer → 解析成功且 boundToRunningProcess=true；
 * 2. 负例：两文件版本不一致 → null；
 * 3. 负例：非 SemVer 版本 → null；
 * 4. 负例：argv[2] 缺失或目录不存在 → null；
 * 5. Host 自身 package.json 解析平台版本；
 * 6. previewBundle 服务端兼容门禁：声明 compatibility 且版本未决 (null) → COMPAT_UNRESOLVED 拒绝；
 * 7. previewBundle 服务端兼容门禁：声明 compatibility 且版本不满足 → INCOMPATIBLE_RUNTIME 拒绝；
 * 8. previewBundle 服务端兼容门禁：版本匹配 → 放行下发。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

import {
  resolveDshProcessObservation,
  resolveGameCenterPackageObservation,
  resolveHostRuntimeVersions,
} from '../staging/runtime/host-runtime-version.js'
import {
  GameCenterCore,
  defineGameCenterService,
} from '../staging/remote/game-center-service.js'

test('Host 运行版本解析：argv[2] 离线 fixture 版本一致且为 SemVer 时解析为 processBound 成功', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  try {
    const dtr = {
      release: {
        schemaVersion: 1,
        version: '0.2.1-rc.2',
        hostProtocolVersion: 4,
        nodeVersion: '24.21.0',
      },
    }
    const pkg = {
      name: '@deepseek-ai/dsh-desktop-runtime',
      version: '0.2.1-rc.2',
    }
    await fs.promises.writeFile(path.join(tmpDir, 'desktop-runtime.json'), JSON.stringify(dtr))
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))

    const obs = resolveDshProcessObservation(['node', 'entry.js', tmpDir])
    assert.ok(obs)
    assert.equal(obs.platform, 'dsh')
    assert.equal(obs.raw, '0.2.1-rc.2')
    assert.equal(obs.evidence, 'processBound')
    assert.equal(obs.boundToRunningProcess, true)
    assert.equal(obs.source, path.join(tmpDir, 'desktop-runtime.json'))
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
})

test('Host 运行版本解析负例：两文件版本不一致必须 fail-closed 返回 null', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  try {
    const dtr = { release: { version: '0.2.1-rc.2' } }
    const pkg = { version: '0.2.0' }
    await fs.promises.writeFile(path.join(tmpDir, 'desktop-runtime.json'), JSON.stringify(dtr))
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))

    const obs = resolveDshProcessObservation(['node', 'entry.js', tmpDir])
    assert.equal(obs, null)
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
})

test('Host 运行版本解析负例：版本格式非 SemVer 必须 fail-closed 返回 null', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  try {
    const dtr = { release: { version: 'invalid-semver' } }
    const pkg = { version: 'invalid-semver' }
    await fs.promises.writeFile(path.join(tmpDir, 'desktop-runtime.json'), JSON.stringify(dtr))
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))

    const obs = resolveDshProcessObservation(['node', 'entry.js', tmpDir])
    assert.equal(obs, null)
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
})

test('Host 运行版本解析负例：包名非 @deepseek-ai/dsh-desktop-runtime 必须 fail-closed 返回 null', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  try {
    const dtr = { release: { version: '0.2.1-rc.2' } }
    const pkg = { name: '@fake/evil-runtime', version: '0.2.1-rc.2' }
    await fs.promises.writeFile(path.join(tmpDir, 'desktop-runtime.json'), JSON.stringify(dtr))
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))

    const obs = resolveDshProcessObservation(['node', 'entry.js', tmpDir])
    assert.equal(obs, null)
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
})

test('Host 运行版本解析负例：argv[2] 缺失或目录不存在返回 null', () => {
  assert.equal(resolveDshProcessObservation(['node', 'entry.js']), null)
  assert.equal(resolveDshProcessObservation(['node', 'entry.js', 'C:\\non-existent-dir-12345']), null)
})

test('Host 运行版本解析：正确读取 Host package.json 的 1.0.0 平台版本', () => {
  const obs = resolveGameCenterPackageObservation()
  assert.ok(obs)
  assert.equal(obs.platform, 'gamecenter')
  assert.equal(obs.raw, '1.0.0')
  assert.equal(obs.evidence, 'processBound')
  assert.equal(obs.boundToRunningProcess, true)
})

test('Host 运行版本统一解析：两个平台版本均就绪时返回 pair 成功', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  try {
    const dtr = { release: { version: '0.2.1-rc.2' } }
    const pkg = { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.2' }
    await fs.promises.writeFile(path.join(tmpDir, 'desktop-runtime.json'), JSON.stringify(dtr))
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkg))

    const pair = resolveHostRuntimeVersions(['node', 'entry.js', tmpDir])
    assert.ok(pair)
    assert.equal(pair.dsh, '0.2.1-rc.2')
    assert.equal(pair.gameCenter, '1.0.0')
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
})

test('服务端 previewBundle 门禁：声明 compatibility 且版本未决 (null) 时返回 COMPAT_UNRESOLVED 且不下发产物', async () => {
  const tmpPreview = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-preview-test-'))
  try {
    const previewSub = path.join(tmpPreview, 'minesweeping')
    await fs.promises.mkdir(previewSub, { recursive: true })
    const manifest = {
      schemaVersion: 1,
      id: 'example.minesweeping',
      name: '扫雷',
      version: '1.0.0',
      runtime: { kind: 'web', entry: 'dist/index.html' },
      compatibility: {
        gameCenter: '>=1.0.0 <2.0.0',
        dsh: '>=0.2.1-rc.2 <0.3.0',
      },
    }
    await fs.promises.writeFile(path.join(previewSub, 'gamecenter.json'), JSON.stringify(manifest))
    await fs.promises.mkdir(path.join(previewSub, 'dist'))
    await fs.promises.writeFile(path.join(previewSub, 'dist', 'index.html'), '<html></html>')

    const root = new Context()
    let gen = 0
    const core = new GameCenterCore({
      nowMs: () => Date.now(),
      ttlMs: 30000,
      createToken: () => 't',
      digestToken: (t) => t,
      nextGeneration: () => ++gen,
    })
    // runningVersions 未提供（默认 null）
    const service = defineGameCenterService(core, root, {
      playerId: 'test',
      previewDir: tmpPreview,
      runningVersions: null,
    })

    const res = await service.previewBundle({ previewId: 'minesweeping' })
    assert.equal(res.ok, false)
    assert.equal(res.errorCode, 'COMPAT_UNRESOLVED')
    assert.match(res.message, /无法解析当前运行宿主/)
  } finally {
    await fs.promises.rm(tmpPreview, { recursive: true, force: true })
  }
})

test('服务端 previewBundle 门禁：版本不匹配时返回 INCOMPATIBLE_RUNTIME 且不下发产物', async () => {
  const tmpPreview = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-preview-test-'))
  try {
    const previewSub = path.join(tmpPreview, 'minesweeping')
    await fs.promises.mkdir(previewSub, { recursive: true })
    const manifest = {
      schemaVersion: 1,
      id: 'example.minesweeping',
      name: '扫雷',
      version: '1.0.0',
      runtime: { kind: 'web', entry: 'dist/index.html' },
      compatibility: {
        gameCenter: '>=2.0.0 <3.0.0', // 声明要求 2.x
        dsh: '>=0.2.1-rc.2 <0.3.0',
      },
    }
    await fs.promises.writeFile(path.join(previewSub, 'gamecenter.json'), JSON.stringify(manifest))
    await fs.promises.mkdir(path.join(previewSub, 'dist'))
    await fs.promises.writeFile(path.join(previewSub, 'dist', 'index.html'), '<html></html>')

    const root = new Context()
    let gen = 0
    const core = new GameCenterCore({
      nowMs: () => Date.now(),
      ttlMs: 30000,
      createToken: () => 't',
      digestToken: (t) => t,
      nextGeneration: () => ++gen,
    })
    // runningVersions 为 1.0.0
    const service = defineGameCenterService(core, root, {
      playerId: 'test',
      previewDir: tmpPreview,
      runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
    })

    const res = await service.previewBundle({ previewId: 'minesweeping' })
    assert.equal(res.ok, false)
    assert.equal(res.errorCode, 'INCOMPATIBLE_RUNTIME')
    assert.match(res.message, /要求游戏中心/)
  } finally {
    await fs.promises.rm(tmpPreview, { recursive: true, force: true })
  }
})

test('服务端 previewBundle 门禁正例：版本完全匹配时成功下发产物', async () => {
  const tmpPreview = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-preview-test-'))
  try {
    const previewSub = path.join(tmpPreview, 'minesweeping')
    await fs.promises.mkdir(previewSub, { recursive: true })
    const manifest = {
      schemaVersion: 1,
      id: 'example.minesweeping',
      name: '扫雷',
      version: '1.0.0',
      runtime: { kind: 'web', entry: 'dist/index.html' },
      compatibility: {
        gameCenter: '>=1.0.0 <2.0.0',
        dsh: '>=0.2.1-rc.2 <0.3.0',
      },
    }
    await fs.promises.writeFile(path.join(previewSub, 'gamecenter.json'), JSON.stringify(manifest))
    await fs.promises.mkdir(path.join(previewSub, 'dist'))
    await fs.promises.writeFile(path.join(previewSub, 'dist', 'index.html'), '<html>hello</html>')

    const root = new Context()
    let gen = 0
    const core = new GameCenterCore({
      nowMs: () => Date.now(),
      ttlMs: 30000,
      createToken: () => 't',
      digestToken: (t) => t,
      nextGeneration: () => ++gen,
    })
    const service = defineGameCenterService(core, root, {
      playerId: 'test',
      previewDir: tmpPreview,
      runningVersions: { gameCenter: '1.0.0', dsh: '0.2.1-rc.2' },
    })

    const res = await service.previewBundle({ previewId: 'minesweeping' })
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.gameId, 'example.minesweeping')
      assert.ok(res.files.length >= 1)
      const indexFile = res.files.find((f) => f.path === 'dist/index.html')
      assert.ok(indexFile)
      assert.equal(indexFile?.content, '<html>hello</html>')
    }
  } finally {
    await fs.promises.rm(tmpPreview, { recursive: true, force: true })
  }
})
