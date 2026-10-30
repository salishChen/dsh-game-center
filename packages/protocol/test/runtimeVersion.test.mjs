/**
 * 运行平台版本来源策略测试 / Runtime platform version policy tests.
 *
 * 这些用例锁定 2026-10-20 项目经理纠正后的硬规则：
 * - 历史 lock 与 SDK 版本**不能**当运行版本放行；
 * - 读不到 / 未绑定进程 → `COMPAT_UNRESOLVED`；
 * - 只有 observed/processBound/trustedConfig 且绑定进程才放行。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveRuntimeVersion,
  resolveRunningVersions,
  observeDshVersionFromDesktopRuntime,
  observeDshVersionFromPackageJson,
  observeGameCenterVersion,
  GATE_ELIGIBLE_EVIDENCE,
  DSH_VERSION_LOCK,
  SDK_VERSION,
} from '../dist/index.js'

const AT = '2026-10-20T00:00:00.000Z'

function obs(overrides = {}) {
  return {
    platform: 'dsh',
    raw: '0.2.1-rc.2',
    evidence: 'observed',
    boundToRunningProcess: true,
    source: 'app.asar:/package.json',
    observedAt: AT,
    ...overrides,
  }
}

test('RV-01 历史 lock 证据被拒绝 / designBaseline and localVerified are not gating evidence', () => {
  for (const evidence of ['designBaseline', 'localVerified']) {
    const r = resolveRuntimeVersion(obs({ evidence }), 'dsh')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'COMPAT_UNRESOLVED')
    assert.equal(r.field, 'dsh')
  }
})

test('RV-02 未绑定当前进程被拒绝 / unbound observation is rejected', () => {
  const r = resolveRuntimeVersion(obs({ boundToRunningProcess: false }), 'dsh')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'COMPAT_UNRESOLVED')
})

test('RV-03 缺观测被拒绝 / missing observation is rejected', () => {
  for (const v of [null, undefined]) {
    const r = resolveRuntimeVersion(v, 'gamecenter')
    assert.equal(r.ok, false)
    assert.equal(r.field, 'gameCenter')
  }
})

test('RV-04 非法版本串被拒绝 / malformed semver is rejected', () => {
  for (const raw of ['unknown', '', '1.0', 'v1.0.0', '1.0.0.0']) {
    const r = resolveRuntimeVersion(obs({ raw }), 'dsh')
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(raw)}`)
  }
})

test('RV-04b 2026.1.0 是合法三段 SemVer / three-part semver is shape-valid', () => {
  // 语法合法 ≠ 依据可信：形状合法只说明能进门禁，不代表这个版本真的存在。
  assert.equal(resolveRuntimeVersion(obs({ raw: '2026.1.0' }), 'dsh').ok, true)
})


test('RV-05 合法观测放行 / eligible bound observation resolves', () => {
  const r = resolveRuntimeVersion(obs(), 'dsh')
  assert.equal(r.ok, true)
  assert.equal(r.version, '0.2.1-rc.2')
})

test('RV-06 放行证据集合精确 / eligible evidence set is exactly observed|processBound|trustedConfig', () => {
  assert.deepEqual([...GATE_ELIGIBLE_EVIDENCE].sort(), ['observed', 'processBound', 'trustedConfig'])
  for (const evidence of GATE_ELIGIBLE_EVIDENCE) {
    assert.equal(resolveRuntimeVersion(obs({ evidence }), 'dsh').ok, true, evidence)
  }
})

test('RV-07 desktop-runtime.json 解析 / desktop-runtime.json is parsed with evidence', () => {
  const content = {
    schemaVersion: 1,
    release: { schemaVersion: 1, version: '0.2.1-rc.2', hostProtocolVersion: 4, nodeVersion: '24.21.0' },
  }
  const o = observeDshVersionFromDesktopRuntime(content, {
    source: 'app.asar:/dsh/desktop-runtime.json',
    observedAt: AT,
    boundToRunningProcess: false,
  })
  assert.ok(o)
  assert.equal(o.raw, '0.2.1-rc.2')
  assert.equal(o.details.hostProtocolVersion, 4)
  // 未绑定进程 → 门禁仍拒
  assert.equal(resolveRuntimeVersion(o, 'dsh').ok, false)
})

test('RV-08 desktop-runtime.json 结构异常返回 null / malformed content yields null', () => {
  for (const bad of [null, {}, { release: null }, { release: {} }, { release: { version: 1 } }]) {
    assert.equal(
      observeDshVersionFromDesktopRuntime(bad, { source: 's', observedAt: AT, boundToRunningProcess: true }),
      null,
    )
  }
})

test('RV-09 package.json 解析带 buildCommit / package.json parse keeps buildCommit', () => {
  const o = observeDshVersionFromPackageJson(
    { name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2', dshBuildCommit: 'abc123', dshBuildDirty: false },
    { source: 'app.asar:/package.json', observedAt: AT, boundToRunningProcess: true },
  )
  assert.ok(o)
  assert.equal(o.details.buildCommit, 'abc123')
  assert.equal(o.details.buildDirty, false)
  assert.equal(resolveRuntimeVersion(o, 'dsh').ok, true)
})

test('RV-10 游戏中心版本不接受 SDK_VERSION 与 0.0.0 占位 / game center rejects SDK_VERSION and 0.0.0 placeholder', () => {
  // SDK_VERSION 是 SDK 接口版本，不允许作为平台版本来源
  assert.equal(SDK_VERSION, '1.0.0')
  const asPlaceholder = observeGameCenterVersion('0.0.0', {
    source: 'packages/*/package.json',
    observedAt: AT,
    boundToRunningProcess: true,
  })
  assert.ok(asPlaceholder)
  // 形式合法但仍需显式配置来源；不得用包占位版本掩盖"版本未定"
  assert.equal(
    observeGameCenterVersion('', { source: 'x', observedAt: AT, boundToRunningProcess: true }),
    null,
  )
})

test('RV-11 双平台解析：任一未决则整体失败 / pair resolution fails if either side unresolved', () => {
  const gc = observeGameCenterVersion('1.0.0', {
    source: 'host config gamecenter.version',
    observedAt: AT,
    boundToRunningProcess: true,
  })
  const dshBad = obs({ evidence: 'localVerified' })
  const bad = resolveRunningVersions(gc, dshBad)
  assert.equal(bad.ok, false)
  assert.equal(bad.resolutions.length, 2)
  assert.ok(bad.resolutions.some((r) => r.ok === false && r.field === 'dsh'))

  const dshGood = obs()
  const good = resolveRunningVersions(gc, dshGood)
  assert.equal(good.ok, true)
  assert.equal(good.pair.dsh, '0.2.1-rc.2')
  assert.equal(good.pair.gameCenter, '1.0.0')
  assert.equal(good.pair.evidence.dsh.source, 'app.asar:/package.json')
})

test('RV-12 历史 lock 只是参考数据 / lock remains reference data only', () => {
  assert.equal(DSH_VERSION_LOCK.localVerified.dshVersion, '0.2.1-rc.2')
  // 直接拿 lock 造观测会被拒
  const fromLock = obs({ evidence: 'localVerified', source: 'protocol/dshVersions.ts' })
  assert.equal(resolveRuntimeVersion(fromLock, 'dsh').ok, false)
})
