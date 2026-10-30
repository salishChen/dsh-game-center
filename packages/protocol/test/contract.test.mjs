/**
 * 契约单元测试（证据分栏：UNIT）。
 * 运行：node --test test/contract.test.mjs（需先 tsc 产出 dist/）。
 * 这些测试只验证协议自身的纯函数与结构，不代表任何 DSH 集成行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  sdkRangeAccepts,
  parseSemver,
  isValidGameId,
  isDigest,
  isFullCommit,
  matchApproval,
  satisfies,
  missingCapabilities,
  canTransition,
  checkSaveCompatibility,
  utf8ByteLength,
  protocolError,
  isErrorCode,
  ERROR_CODES,
  DEFAULT_RETRYABLE,
  hasSaveCapability,
  BRIDGE_METHODS,
  BRIDGE_MAX_MESSAGE_BYTES,
  DSH_VERSION_LOCK,
} from '../dist/index.js'

test('sdkRangeAccepts: 支持的四类范围语法', () => {
  assert.equal(sdkRangeAccepts('^1.0.0', '1.4.0'), true)
  assert.equal(sdkRangeAccepts('^1.0.0', '2.0.0'), false)
  assert.equal(sdkRangeAccepts('~1.2.0', '1.2.9'), true)
  assert.equal(sdkRangeAccepts('~1.2.0', '1.3.0'), false)
  assert.equal(sdkRangeAccepts('>=1.0.0 <2.0.0', '1.9.9'), true)
  assert.equal(sdkRangeAccepts('>=1.0.0 <2.0.0', '2.0.0'), false)
  assert.equal(sdkRangeAccepts('1.0.0', '1.0.0'), true)
})

test('sdkRangeAccepts: 未知语法必须拒绝而不是猜测', () => {
  assert.equal(sdkRangeAccepts('latest', '1.0.0'), false)
  assert.equal(sdkRangeAccepts('*', '1.0.0'), false)
  assert.equal(sdkRangeAccepts('1.x', '1.0.0'), false)
  assert.equal(parseSemver('not-a-version'), null)
})

test('gameId 与摘要/提交格式', () => {
  assert.equal(isValidGameId('example.ai-detective'), true)
  assert.equal(isValidGameId('Example.Game'), false)
  assert.equal(isValidGameId('-bad'), false)
  assert.equal(isValidGameId('a'), true)
  assert.equal(isDigest('sha256:' + 'a'.repeat(64)), true)
  assert.equal(isDigest('sha256:' + 'A'.repeat(64)), false)
  assert.equal(isFullCommit('0123456789abcdef0123456789abcdef01234567'), true)
  assert.equal(isFullCommit('0123456'), false)
})

test('matchApproval: 五元组任一字段变化都不得通过', () => {
  const entry = {
    schemaVersion: 1,
    gameId: 'example.game',
    title: 't',
    summary: 's',
    version: '1.0.0',
    source: {
      repository: 'https://github.com/example/game.git',
      ref: 'v1.0.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      manifestPath: 'gamecenter.json',
      manifestDigest: 'sha256:' + 'b'.repeat(64),
      bundleDigest: 'sha256:' + 'c'.repeat(64),
    },
  }
  const approval = {
    gameId: 'example.game',
    repository: entry.source.repository,
    commit: entry.source.commit,
    manifestDigest: entry.source.manifestDigest,
    bundleDigest: entry.source.bundleDigest,
    approvedBy: 'maintainer',
    approvedAt: '2026-10-18T00:00:00Z',
    approvalRecordPath: 'approvals/example.game.json',
  }
  assert.equal(matchApproval(entry, [approval]).ok, true)

  const edited = { ...entry, source: { ...entry.source, manifestDigest: 'sha256:' + 'd'.repeat(64) } }
  assert.equal(matchApproval(edited, [approval]).ok, false)

  // 来源仓库变化必须拒绝：仅改 repository、其余四项与已审批版本一致时也不得通过。
  const redirected = {
    ...entry,
    source: { ...entry.source, repository: 'https://github.com/attacker/game.git' },
  }
  assert.equal(matchApproval(redirected, [approval]).ok, false)

  // 审批记录缺 repository（旧记录）不得匹配任何条目。
  const { repository: _omit, ...legacyApproval } = approval
  assert.equal(matchApproval(entry, [legacyApproval]).ok, false)

  assert.equal(matchApproval(entry, []).ok, false)
})

test('能力匹配: unknown 不得当作支持', () => {
  const entry = {
    providerId: 'p',
    modelId: 'm',
    adapterId: 'a',
    operations: ['chat.generate'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: 'supported',
    structuredOutput: 'unknown',
    limits: {},
    status: 'unknown',
    evidence: 'dsh-catalog',
    verifiedAt: '2026-10-18T00:00:00Z',
    adapterVersion: '0.0.0',
  }
  const query = { operation: 'chat.generate', requires: { input: ['text', 'image'], output: ['text'] } }
  assert.equal(satisfies(entry, query), false)
  assert.equal(satisfies({ ...entry, status: 'supported' }, query), true)
  assert.equal(missingCapabilities(query, [entry]).length, 1)
  const imageOut = { operation: 'image.generate', requires: { input: ['text'], output: ['image'] } }
  assert.equal(satisfies({ ...entry, status: 'supported' }, imageOut), false)
})

test('AI 请求账本状态机只允许前向迁移', () => {
  assert.equal(canTransition('Prepared', 'Submitted'), true)
  assert.equal(canTransition('Submitted', 'Completed'), true)
  assert.equal(canTransition('Completed', 'Applied'), true)
  assert.equal(canTransition('Applied', 'Completed'), false)
  assert.equal(canTransition('Cancelled', 'Applied'), false)
  assert.equal(canTransition('Submitted', 'OutcomeUnknown'), true)
})

test('存档兼容判定给出明确原因', () => {
  const save = {
    saveFormatVersion: 1,
    gameStateSchemaVersion: 2,
    gameId: 'example.game',
    saveId: 'save-001',
    installedCommit: '0123456789abcdef0123456789abcdef01234567',
    revision: 3,
    status: 'paused',
    elapsedGameMs: 1000,
    rngState: 'seed',
    modelBindings: {},
    state: {},
    assetIds: [],
    lastAppliedOperationIds: [],
  }
  const commits = [save.installedCommit]
  assert.deepEqual(
    checkSaveCompatibility({ save, currentSaveFormatVersion: 1, supportedGameStateVersions: [1, 2], installedCommits: commits }),
    { compatible: true },
  )
  const wrongState = checkSaveCompatibility({
    save,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [1],
    installedCommits: commits,
  })
  assert.equal(wrongState.compatible, false)
  assert.equal(wrongState.reason, 'game-state-major-unsupported')

  const wrongCommit = checkSaveCompatibility({
    save,
    currentSaveFormatVersion: 1,
    supportedGameStateVersions: [2],
    installedCommits: [],
  })
  assert.equal(wrongCommit.compatible, false)
  assert.equal(wrongCommit.reason, 'unknown-game-version')
})

test('错误码信封与白名单', () => {
  // 15 = 13 + SAVE_UNSUPPORTED（存档改可选能力后新增，非致命）
  //    + CATALOG_UNREACHABLE（目录后台不可达，与"未审批"区分，可重试）
  assert.equal(ERROR_CODES.length, 15)
  assert.equal(isErrorCode('CATALOG_UNREACHABLE'), true)
  assert.equal(DEFAULT_RETRYABLE.CATALOG_UNREACHABLE, true, '网络类失败允许稍后重试')
  assert.equal(isErrorCode('SAVE_UNSUPPORTED'), true)
  assert.equal(DEFAULT_RETRYABLE.SAVE_UNSUPPORTED, false)
  assert.equal(isErrorCode('PAUSED'), true)
  assert.equal(isErrorCode('PAUSED_BUT_WHATEVER'), false)
  const err = protocolError('RATE_LIMIT', '稍后重试')
  assert.equal(err.retryable, true)
  assert.equal(protocolError('ABORTED', '已取消').retryable, false)
  assert.ok(!BRIDGE_METHODS.includes('ctx.tool'))
})

test('Bridge 消息大小按 UTF-8 字节计算', () => {
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中文'), 6)
  assert.equal(utf8ByteLength('😀'), 4)
  assert.ok(BRIDGE_MAX_MESSAGE_BYTES > 0)
})

test('DSH 版本锁定同时记录基线与实装，且不做跨版本承诺', () => {
  assert.notEqual(DSH_VERSION_LOCK.designBaselineCommit, DSH_VERSION_LOCK.localVerified.buildCommit)
  assert.match(DSH_VERSION_LOCK.localVerified.buildCommit, /^[0-9a-f]{40}$/)
  assert.ok(DSH_VERSION_LOCK.notClaimed.length >= 3)
})

// 存档是可选能力：缺省 save = 无存档，Host/Client 必须据此跳过强制落盘与封存。
test('hasSaveCapability：缺省 save 视为无存档能力', () => {
  const noSave = { id: 'example.minesweeping', schemaVersion: 1 }
  const withSave = {
    id: 'example.minesweeping',
    schemaVersion: 1,
    save: { schemaVersion: 1, supportsResume: true, checkpointPolicy: 'each-action' },
  }
  assert.equal(hasSaveCapability(noSave), false)
  assert.equal(hasSaveCapability(withSave), true)
  // 类型守卫收窄：通过后 save 一定存在
  if (hasSaveCapability(withSave)) assert.equal(withSave.save.supportsResume, true)
  // schema 层：manifest.v1.json 的 required 不得再包含 save
  const schema = JSON.parse(readFileSync(new URL('../schemas/manifest.v1.json', import.meta.url), 'utf8'))
  assert.equal(schema.required.includes('save'), false)
  assert.equal(schema.required.includes('permissions'), true)
})


test('Bridge JSON Schema mirrors the reversible lifecycle acknowledgement whitelist', async () => {
  const fs = await import('node:fs');
  const protocol = await import('../dist/index.js');
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/bridge-envelope.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.method.enum, [...protocol.BRIDGE_METHODS]);
  for (const input of [{gameId:'example.game',saveId:'save-default',commit:'../../escape'}, {gameId:'example.game',saveId:'save-default',previewId:'../escape'}]) {
    assert.ok(protocol.validateSaveLatestRequest(input).length > 0);
  }
});
