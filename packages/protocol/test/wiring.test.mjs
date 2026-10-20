/**
 * 阶段1 生产接线最小契约测试（证据分栏：UNIT）。
 *
 * 运行：node --test test/wiring.test.mjs（需先 tsc 产出 dist/）。
 * 只验证协议纯函数与安全策略常量；不联网、不落盘、不代表 DSH 集成行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  GAMECENTER_REMOTE_METHODS,
  GAMECENTER_REMOTE_METHOD_ADDITIONS,
  GAME_IFRAME_SANDBOX,
  GAME_DOCUMENT_CSP,
  GAME_BUNDLE_MAX_FILES,
  GAME_BUNDLE_MAX_FILE_BYTES,
  GAME_BUNDLE_MAX_TOTAL_BYTES,
  validateFramePolicy,
  isSafeBundlePath,
  bundleContentBytes,
  validateGameBundleFiles,
  validateCatalogInstallRequest,
  validateSaveLatestRequest,
  validateSaveCheckpointRequest,
  validatePreviewBundleRequest,
  GAME_PREVIEW_LABEL,
  CHECKPOINT_WRITABLE_LEASE_STATES,
  PAUSE_FINALIZATION_ORDER,
  decideCheckpointAdmission,
  isPauseFinalizationOrderValid,
} from '../dist/wiring.js'

import { SAVE_SLOTS, isSaveIdShapeValid } from '../dist/bridge.js'
import {
  LEASE_ACK_WINDOW_MS,
  LEASE_RECLAIM_REASONS,
  isLaunchTokenShapeValid,
  validateAbandonRuntimeRequest,
} from '../dist/bridge.js'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST_DIGEST = 'sha256:' + 'b'.repeat(64)
const BUNDLE_DIGEST = 'sha256:' + 'c'.repeat(64)

test('W-01 方法表：既有 5 条保留，新增恰为 7 条且无重复', () => {
  const legacy = ['handshake', 'pause', 'saveAck', 'leaseStatus', 'modelCatalog']
  for (const method of legacy) {
    assert.ok(GAMECENTER_REMOTE_METHODS.includes(method), `既有方法不得丢失：${method}`)
  }
  const added = GAMECENTER_REMOTE_METHODS.filter((method) => !legacy.includes(method))
  assert.deepEqual([...added], [...GAMECENTER_REMOTE_METHOD_ADDITIONS], '新增方法与常量表必须一致')
  assert.equal(new Set(GAMECENTER_REMOTE_METHODS).size, GAMECENTER_REMOTE_METHODS.length, '方法表不得有重复项')
  // 数量不是仪式性的"12"：2026-10-20 为关闭孤儿 running 租约新增 abandonRuntime，现为 13。
  assert.equal(GAMECENTER_REMOTE_METHODS.length, 13, '阶段1 收尾后应为 13 条（12 + abandonRuntime）')
  assert.ok(GAMECENTER_REMOTE_METHODS.includes('abandonRuntime'), 'abandonRuntime 必须冻结进方法表')
})

test('W-02 iframe 安全策略：只有 allow-scripts，且 CSP 断网', () => {
  assert.equal(GAME_IFRAME_SANDBOX, 'allow-scripts')
  assert.deepEqual(validateFramePolicy(GAME_IFRAME_SANDBOX, GAME_DOCUMENT_CSP), [])
  assert.ok(!GAME_DOCUMENT_CSP.includes('connect-src *'), 'CSP 不得放开 connect-src')
})

test('W-03 iframe 安全策略：带回 allow-same-origin 必须被拒', () => {
  const violations = validateFramePolicy('allow-scripts allow-same-origin', GAME_DOCUMENT_CSP)
  assert.equal(violations.length >= 1, true)
  assert.equal(violations[0].field, 'sandbox')
})

test('W-04 iframe 安全策略：CSP 放开网络必须被拒', () => {
  const relaxed = GAME_DOCUMENT_CSP.replace("connect-src 'none'", 'connect-src https:')
  const violations = validateFramePolicy(GAME_IFRAME_SANDBOX, relaxed)
  assert.equal(violations.length >= 1, true)
  assert.equal(violations.some((violation) => violation.field === 'csp'), true)
})

test('W-05 打包路径：接受普通相对路径', () => {
  for (const path of ['dist/index.html', 'dist/game.js', 'style.css', 'a/b/c.json', 'icon.svg']) {
    assert.equal(isSafeBundlePath(path), true, `应接受：${path}`)
  }
})

test('W-06 打包路径：拒绝穿越、绝对路径、盘符、反斜杠、非文本后缀、目录尾斜杠', () => {
  const rejected = [
    '../escape.js',
    'a/../../b.js',
    '/abs/index.html',
    'C:/windows/x.js',
    'a\\b.js',
    'dist/',
    '',
    'payload.exe',
    'archive.zip',
    'no-extension',
    'x'.repeat(260) + '.js',
  ]
  for (const path of rejected) {
    assert.equal(isSafeBundlePath(path), false, `应拒绝：${JSON.stringify(path)}`)
  }
})

test('W-07 打包清单：合法最小清单通过', () => {
  const files = [
    { path: 'dist/index.html', content: '<!doctype html><p>hi</p>' },
    { path: 'dist/game.js', content: 'console.log(1)' },
  ]
  assert.deepEqual(validateGameBundleFiles(files), [])
  assert.equal(bundleContentBytes('abc'), 3)
  assert.equal(bundleContentBytes('中文'), 6, 'UTF-8 中文每字 3 字节')
})

test('W-08 打包清单：空、重复、非文本、路径逃逸一律拒绝', () => {
  assert.equal(validateGameBundleFiles([]).length >= 1, true, '空清单必须拒绝')
  assert.equal(validateGameBundleFiles(null).length, 1, '非数组必须拒绝')

  const duplicated = [
    { path: 'a.js', content: '1' },
    { path: 'a.js', content: '2' },
  ]
  assert.equal(
    validateGameBundleFiles(duplicated).some((violation) => violation.reason.includes('路径重复')),
    true,
  )

  const escaped = [{ path: '../x.js', content: '1' }]
  assert.equal(validateGameBundleFiles(escaped).length >= 1, true)

  const nonText = [{ path: 'a.js', content: 123 }]
  assert.equal(
    validateGameBundleFiles(nonText).some((violation) => violation.reason.includes('UTF-8 文本')),
    true,
  )
})

test('W-09 打包上限：单文件、文件数、总字节超限都显式拒绝（不截断）', () => {
  const tooMany = Array.from({ length: GAME_BUNDLE_MAX_FILES + 1 }, (_, index) => ({
    path: `f${index}.js`,
    content: '1',
  }))
  assert.equal(
    validateGameBundleFiles(tooMany).some((violation) => violation.reason.includes('超过上限')),
    true,
  )

  const bigFile = [{ path: 'big.js', content: 'x'.repeat(GAME_BUNDLE_MAX_FILE_BYTES + 1) }]
  assert.equal(
    validateGameBundleFiles(bigFile).some((violation) => violation.reason.includes('单文件')),
    true,
  )

  // 单文件不超限、但累计超限：每份 1 MiB，凑到 4 MiB 以上。
  const chunk = 'x'.repeat(GAME_BUNDLE_MAX_FILE_BYTES)
  const totalOver = Array.from({ length: Math.ceil(GAME_BUNDLE_MAX_TOTAL_BYTES / GAME_BUNDLE_MAX_FILE_BYTES) + 1 }, (_, index) => ({
    path: `p${index}.js`,
    content: chunk,
  }))
  assert.equal(
    validateGameBundleFiles(totalOver).some((violation) => violation.reason.includes('总字节')),
    true,
  )
})

test('W-10 打包上限足以容纳扫雷实测产物（31593 + 3740 + 1597 字节）', () => {
  const measured = [31593, 3740, 1597]
  assert.equal(measured.every((bytes) => bytes <= GAME_BUNDLE_MAX_FILE_BYTES), true)
  assert.equal(measured.reduce((sum, bytes) => sum + bytes, 0) <= GAME_BUNDLE_MAX_TOTAL_BYTES, true)
})

test('W-11 catalogInstall 入参：完整 SHA + 规范摘要才通过', () => {
  assert.deepEqual(
    validateCatalogInstallRequest({
      gameId: 'example.minesweeping',
      commit: COMMIT,
      manifestDigest: MANIFEST_DIGEST,
      bundleDigest: BUNDLE_DIGEST,
    }),
    [],
  )
})

test('W-12 catalogInstall 入参：短 SHA、大写摘要、无前缀摘要、坏 gameId 都拒绝', () => {
  const base = {
    gameId: 'example.minesweeping',
    commit: COMMIT,
    manifestDigest: MANIFEST_DIGEST,
    bundleDigest: BUNDLE_DIGEST,
  }

  const shortSha = validateCatalogInstallRequest({ ...base, commit: COMMIT.slice(0, 7) })
  assert.equal(shortSha.some((violation) => violation.field === 'commit'), true, '短 SHA 必须拒绝')

  const upperDigest = validateCatalogInstallRequest({ ...base, manifestDigest: 'sha256:' + 'B'.repeat(64) })
  assert.equal(
    upperDigest.some((violation) => violation.field === 'manifestDigest'),
    true,
    '大写十六进制不得静默归一',
  )

  const bareDigest = validateCatalogInstallRequest({ ...base, bundleDigest: 'c'.repeat(64) })
  assert.equal(bareDigest.some((violation) => violation.field === 'bundleDigest'), true, '缺 sha256: 前缀必须拒绝')

  const badId = validateCatalogInstallRequest({ ...base, gameId: 'Example Minesweeping' })
  assert.equal(badId.some((violation) => violation.field === 'gameId'), true)
})

test('W-13 saveLatest 入参：不含 playerId（身份由 Host 绑定），saveId 有边界', () => {
  assert.deepEqual(validateSaveLatestRequest({ gameId: 'example.minesweeping', saveId: 'slot-1' }), [])
  assert.equal(
    validateSaveLatestRequest({ gameId: 'example.minesweeping', saveId: '' }).some(
      (violation) => violation.field === 'saveId',
    ),
    true,
  )
  assert.equal(
    validateSaveLatestRequest({ gameId: 'example.minesweeping', saveId: 'x'.repeat(129) }).some(
      (violation) => violation.field === 'saveId',
    ),
    true,
  )
  // 调用方即使塞 playerId 也不被协议接受为身份来源：本函数不校验它，Host 必须忽略它。
  assert.deepEqual(
    validateSaveLatestRequest({ gameId: 'example.minesweeping', saveId: 'slot-1', playerId: 'attacker' }),
    [],
    'playerId 不属于本入参；Host 侧必须从宿主绑定身份，不得采信调用方传值',
  )
})

// ---------------------------------------------------------------------------
// 检查点写入出口与本地预览（PM 2026-10-20 指出的两个断点）
// ---------------------------------------------------------------------------

const CHECKPOINT_BASE = {
  runtimeToken: 'rt-token-abcdef0123456789',
  operationId: 'act-abc123-1',
  expectedRevision: 0,
  state: { board: [], flags: [] },
  elapsedGameMs: 1234,
  rngState: 'seed:42:7',
}

test('W-14 saveCheckpoint：合法载荷通过，且不含 playerId', () => {
  assert.deepEqual(validateSaveCheckpointRequest({ ...CHECKPOINT_BASE }), [])
  assert.equal('playerId' in CHECKPOINT_BASE, false, '协议入参本身不得携带 playerId')
})

test('W-15 saveCheckpoint：显式传 playerId 必须被拒（不是忽略）', () => {
  const violations = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, playerId: 'attacker' })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].field, 'playerId')
  assert.equal(violations[0].reason.includes('出现即拒绝'), true, '拒绝理由要说明不是静默忽略')
})

test('W-16 saveCheckpoint：缺凭证、坏 operationId、负 revision、不可序列化 state 都拒', () => {
  const noToken = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, runtimeToken: '' })
  assert.equal(noToken.some((violation) => violation.field === 'runtimeToken'), true)

  const badOp = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, operationId: 'has space/and:ok?' })
  assert.equal(badOp.some((violation) => violation.field === 'operationId'), true)

  const negative = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, expectedRevision: -1 })
  assert.equal(negative.some((violation) => violation.field === 'expectedRevision'), true)

  const fractional = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, expectedRevision: 1.5 })
  assert.equal(fractional.some((violation) => violation.field === 'expectedRevision'), true)

  const circular = { self: null }
  circular.self = circular
  const badState = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, state: circular })
  assert.equal(badState.some((violation) => violation.field === 'state'), true, '循环引用必须拒绝')

  const missingState = validateSaveCheckpointRequest({ ...CHECKPOINT_BASE, state: undefined })
  assert.equal(missingState.some((violation) => violation.field === 'state'), true, 'state 缺失必须拒绝')
})

test('W-17 saveCheckpoint：方法与既有 5 条并存，不靠 saveAck 兼任', () => {
  assert.equal(GAMECENTER_REMOTE_METHODS.includes('saveCheckpoint'), true)
  assert.equal(GAMECENTER_REMOTE_METHODS.includes('saveAck'), true, 'saveAck 仍是暂停确认，不能被替换')
  assert.notEqual('saveCheckpoint', 'saveAck')
  assert.equal(GAMECENTER_REMOTE_METHOD_ADDITIONS.includes('saveCheckpoint'), true)
})

test('W-18 本地预览：previewId 只接受单段安全目录名', () => {
  assert.deepEqual(validatePreviewBundleRequest({ previewId: 'minesweeping-local' }), [])

  for (const bad of ['../x', 'a/b', 'C:', '', '..', '.']) {
    const violations = validatePreviewBundleRequest({ previewId: bad })
    assert.equal(violations.length, 1, `应拒绝 previewId=${JSON.stringify(bad)}`)
  }
})

test('W-19 本地预览：标签固定声明未上架，且与安装路径分离', () => {
  assert.equal(GAME_PREVIEW_LABEL, '本地预览（未上架）')
  assert.equal(GAME_PREVIEW_LABEL.includes('未上架'), true, '标签必须明示未上架')
  assert.equal(GAMECENTER_REMOTE_METHODS.includes('previewList'), true)
  assert.equal(GAMECENTER_REMOTE_METHODS.includes('previewBundle'), true)
  // 预览与安装是两条独立方法：预览不得走 catalogInstall。
  assert.equal(GAMECENTER_REMOTE_METHODS.includes('catalogInstall'), true)
})
// ---------------------------------------------------------------------------
// 暂停收尾：最终检查点先落盘再封存（PM 2026-10-20 明确要求）
// ---------------------------------------------------------------------------

const LEASE_BASE = { state: 'running', sealed: false, generation: 3, expiresAtMs: 10_000 }

test('W-20 准入：running 与 pausing 都允许写，其它状态一律拒绝', () => {
  assert.deepEqual(decideCheckpointAdmission({ ...LEASE_BASE, state: 'running' }, { nowMs: 0 }), { ok: true })
  assert.deepEqual(
    decideCheckpointAdmission({ ...LEASE_BASE, state: 'pausing' }, { nowMs: 0 }),
    { ok: true },
    'pausing 必须允许"最终检查点"，否则关闭时只能先确认后写盘',
  )

  for (const state of ['paused', 'recovery-available', 'stopped']) {
    const result = decideCheckpointAdmission({ ...LEASE_BASE, state }, { nowMs: 0 })
    assert.equal(result.ok, false, `状态 ${state} 必须拒绝`)
    assert.equal(result.errorCode, 'STALE_RUNTIME')
  }

  const pending = decideCheckpointAdmission({ ...LEASE_BASE, state: 'pending' }, { nowMs: 0 })
  assert.equal(pending.ok, false)
  assert.equal(pending.errorCode, 'PROTOCOL_INVALID', '未握手必须是 PROTOCOL_INVALID，不是 STALE_RUNTIME')
})

test('W-21 准入：已封存即使 state=running 也拒绝，旧代次拒绝，过期拒绝', () => {
  const sealed = decideCheckpointAdmission({ ...LEASE_BASE, sealed: true }, { nowMs: 0 })
  assert.equal(sealed.ok, false)
  assert.equal(sealed.errorCode, 'STALE_RUNTIME', '封存优先于状态判断')

  const stale = decideCheckpointAdmission({ ...LEASE_BASE }, { generation: 2, nowMs: 0 })
  assert.equal(stale.ok, false)
  assert.equal(stale.errorCode, 'STALE_RUNTIME')
  assert.equal(stale.message.includes('代次'), true)

  const sameGen = decideCheckpointAdmission({ ...LEASE_BASE }, { generation: 3, nowMs: 0 })
  assert.deepEqual(sameGen, { ok: true }, '同代次必须放行')

  const expired = decideCheckpointAdmission({ ...LEASE_BASE, expiresAtMs: 500 }, { nowMs: 501 })
  assert.equal(expired.ok, false)
  assert.equal(expired.errorCode, 'PAUSED')
})

test('W-22 准入：pausing 拒 AI 不等于拒检查点，两者是不同判定', () => {
  assert.deepEqual([...CHECKPOINT_WRITABLE_LEASE_STATES], ['running', 'pausing'])
  assert.equal(CHECKPOINT_WRITABLE_LEASE_STATES.includes('paused'), false)
  assert.equal(CHECKPOINT_WRITABLE_LEASE_STATES.includes('pending'), false)
})

test('W-23 暂停收尾顺序：先落盘、再封存、再确认、最后销毁', () => {
  assert.deepEqual([...PAUSE_FINALIZATION_ORDER], [
    'persist-final-checkpoint',
    'seal-lease',
    'pause-ack',
    'destroy-runtime',
  ])
  const order = [...PAUSE_FINALIZATION_ORDER]
  assert.equal(order.indexOf('persist-final-checkpoint') < order.indexOf('seal-lease'), true, '必须先落盘后封存')
  assert.equal(order.indexOf('seal-lease') < order.indexOf('pause-ack'), true, '封存必须先于对外确认')
  assert.equal(order.indexOf('pause-ack') < order.indexOf('destroy-runtime'), true, '确认后才销毁实例')
  assert.equal(isPauseFinalizationOrderValid(order), true)
})

test('W-24 暂停收尾顺序：先确认后写盘等反例必须判无效', () => {
  assert.equal(
    isPauseFinalizationOrderValid(['pause-ack', 'persist-final-checkpoint', 'seal-lease', 'destroy-runtime']),
    false,
    '先确认后写盘是假保存，必须判无效',
  )
  assert.equal(isPauseFinalizationOrderValid(['persist-final-checkpoint', 'pause-ack', 'destroy-runtime']), false)
  assert.equal(isPauseFinalizationOrderValid([]), false)
})

// —— W-25..W-28：存档槽位冻结（阶段1 收尾，2026-10-20）——
// 背景：Host 曾回退 `saveId = runtimeInstanceId`，Client 续玩用固定槽位，
// 导致"关闭保存→重开恢复"结构上不成立。以下四条把槽位契约固定在协议层。

test('W-25 存档槽位：正式与预览两个冻结值，互不相同且稳定', () => {  assert.equal(SAVE_SLOTS.default, 'save-default')
  assert.equal(SAVE_SLOTS.preview, 'save-preview')
  assert.notEqual(SAVE_SLOTS.default, SAVE_SLOTS.preview, '预览槽位不得与正式槽位合并')
  assert.equal(Object.isFrozen(SAVE_SLOTS), true, '槽位常量必须冻结，禁止运行时改写')
  for (const slot of Object.values(SAVE_SLOTS)) {
    assert.equal(isSaveIdShapeValid(slot), true, `冻结槽位必须通过形状校验：${slot}`)
  }
})

test('W-26 存档槽位形状：空串、超长、路径分隔符一律非法', () => {
  assert.equal(isSaveIdShapeValid(''), false)
  assert.equal(isSaveIdShapeValid(undefined), false)
  assert.equal(isSaveIdShapeValid(42), false)
  assert.equal(isSaveIdShapeValid('a'.repeat(129)), false)
  assert.equal(isSaveIdShapeValid('save/../other'), false)
  assert.equal(isSaveIdShapeValid('save\\other'), false)
  assert.equal(isSaveIdShapeValid('a'.repeat(128)), true)
})

test('W-27 运行身份不得冒充存档身份（历史缺陷回归）', () => {
  // runtimeInstanceId 形如 `rt-xxxxxxxx`：用它当槽位本身就不可续玩，
  // 且与 SAVE_SLOTS 无关。两者必须在类型与取值上都可区分。
  assert.equal(SAVE_SLOTS.default === 'rt-1a2b3c4d', false)
  assert.equal(isSaveIdShapeValid('rt-1a2b3c4d'), true, '形状合法 ≠ 槽位语义合法：Host 必须显式要求调用方给槽位')
})

test('W-28 握手请求类型要求 saveId 必填（编译期约束的存在性检查）', () => {
  // 这里不做运行时校验（接口在编译期消失），只防止有人把 saveId 改回可选：
  // 若改回 `saveId?: string`，下面这行 still 编译通过，因此用源码文本断言兜底。
  const source = readFileSync(fileURLToPath(new URL('../src/bridge.ts', import.meta.url)), 'utf8')
  const handshakeBlock = source.slice(source.indexOf('export interface HandshakeRequest'))
  const body = handshakeBlock.slice(0, handshakeBlock.indexOf('\n}'))
  assert.match(body, /^\s*saveId: string\s*$/m, 'HandshakeRequest.saveId 必须是必填 string，不得改回可选')
  assert.doesNotMatch(body, /saveId\?:/, 'HandshakeRequest.saveId 不得是可选字段')
})

// —— W-29..W-32：生命周期取消与未确认回收（2026-10-20，PM 冻结契约）——

test('W-29 未确认窗口 T_ack 冻结为 3000ms，且只有这一个窗口常量', () => {
  assert.equal(LEASE_ACK_WINDOW_MS, 3000, 'T_ack 必须与 pause timeoutMs 同量级且冻结')
  const source = readFileSync(fileURLToPath(new URL('../src/bridge.ts', import.meta.url)), 'utf8')
  const windows = [...source.matchAll(/export const \w*(?:ACK|TIMEOUT|RECLAIM)\w*_MS\s*=\s*(\d+)/g)]
  assert.deepEqual(windows.map((m) => Number(m[1])), [3000], '不得出现第二个未确认窗口常量（避免实现各自放宽）')
})

test('W-30 launchToken 形状：短令牌、空白、控制字符、超长一律非法', () => {
  assert.equal(isLaunchTokenShapeValid('a'.repeat(31)), false, '不足 32 字符不够熵')
  assert.equal(isLaunchTokenShapeValid('a'.repeat(32)), true)
  assert.equal(isLaunchTokenShapeValid('a'.repeat(256)), true)
  assert.equal(isLaunchTokenShapeValid('a'.repeat(257)), false)
  assert.equal(isLaunchTokenShapeValid('a'.repeat(20) + ' b'), false, '禁止空白（防日志注入）')
  assert.equal(isLaunchTokenShapeValid('a'.repeat(20) + '\n'), false, '禁止控制字符')
  assert.equal(isLaunchTokenShapeValid('中文令牌'.repeat(10)), false, '只接受可见 ASCII')
  assert.equal(isLaunchTokenShapeValid(undefined), false)
})

test('W-31 abandonRuntime 入参：必须同时出示 launchToken 与 runtimeInstanceId', () => {
  const token = 't'.repeat(43)
  assert.deepEqual(validateAbandonRuntimeRequest({ launchToken: token, runtimeInstanceId: 'rt-1' }), [])

  const onlySlot = validateAbandonRuntimeRequest({ gameId: 'g', saveId: 'save-default' })
  assert.ok(
    onlySlot.some((v) => v.field === 'launchToken') && onlySlot.some((v) => v.field === 'runtimeInstanceId'),
    '仅凭 gameId/saveId 无法发起撤销（字段不足必须被拒）',
  )
  assert.ok(validateAbandonRuntimeRequest(null).length > 0)
  assert.ok(
    validateAbandonRuntimeRequest({ launchToken: 'short', runtimeInstanceId: 'rt-1' }).some(
      (v) => v.field === 'launchToken',
    ),
    '弱令牌必须被拒',
  )
})

test('W-32 回收原因词表固定，且不多出未冻结原因', () => {
  assert.deepEqual([...LEASE_RECLAIM_REASONS], ['abandoned', 'unconfirmed-timeout', 'closed'])
  assert.equal(new Set(LEASE_RECLAIM_REASONS).size, LEASE_RECLAIM_REASONS.length)
})

test('W-33 Host 不得用"玩家静止"当回收依据（源码回归守卫）', () => {
  // 语义守卫：Host 若把 T_ack 用在已确认（running）租约上，或在回收路径里读取
  // "最后活动时间"来决定是否回收，就是 PM 明确禁止的"3 秒无操作即回收"。
  const leaseSource = readFileSync(
    fileURLToPath(new URL('../../dsh-gamecenter/src/runtime/lease.ts', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(
    leaseSource,
    /lastActivityMs|lastActiveAt|idleSince/,
    'Host 不得引入"最后活动时间"驱动的回收（会把正常静置的玩家误杀）',
  )
})