/**
 * 验收项 A2：审批五元组比对（证据分栏：UNIT）
 * 覆盖：逐字段相等可安装，改动 repository/commit/manifestDigest/bundleDigest/gameId 均拒绝。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateInstallability } from '../dist/index.js'

const BASE_ENTRY = {
  schemaVersion: 1,
  gameId: 'example.minesweeper',
  title: '经典扫雷',
  summary: '经典扫雷玩法',
  version: '1.0.0',
  source: {
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
    ref: 'v1.0.0',
    commit: '1111222233334444555566667777888899990000',
    manifestPath: 'gamecenter.json',
    manifestDigest: 'sha256:' + '1'.repeat(64),
    bundleDigest: 'sha256:' + '2'.repeat(64),
  },
}

const VALID_APPROVAL = {
  gameId: 'example.minesweeper',
  repository: 'https://github.com/salishChen/dsh-game-minesweeping',
  commit: '1111222233334444555566667777888899990000',
  manifestDigest: 'sha256:' + '1'.repeat(64),
  bundleDigest: 'sha256:' + '2'.repeat(64),
  approvedBy: 'salishchen',
  approvedAt: '2026-10-19T12:00:00Z',
  approvalRecordPath: 'approvals/example.minesweeper/v1.0.0.json',
}

test('A2-1: 五元组完全一致时判定为可安装并产出安全计划', () => {
  const result = evaluateInstallability(BASE_ENTRY, [VALID_APPROVAL])
  assert.equal(result.installable, true)
  if (result.installable) {
    assert.equal(result.plan.gameId, 'example.minesweeper')
    assert.equal(result.plan.commit, '1111222233334444555566667777888899990000')
    assert.equal(result.plan.installDir, 'example.minesweeper/1111222233334444555566667777888899990000')
    assert.equal(result.approval.approvedBy, 'salishchen')
  }
})

test('A2-2: repository 篡改（挂载到他人或非审批仓库）必须拒绝', () => {
  const tamperedEntry = {
    ...BASE_ENTRY,
    source: {
      ...BASE_ENTRY.source,
      repository: 'https://github.com/attacker/evil-repo',
    },
  }
  const result = evaluateInstallability(tamperedEntry, [VALID_APPROVAL])
  assert.equal(result.installable, false)
  if (!result.installable) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /与任何审批记录都不一致/)
  }
})

test('A2-3: commit 篡改（指向未审批的提交代码）必须拒绝', () => {
  const tamperedEntry = {
    ...BASE_ENTRY,
    source: {
      ...BASE_ENTRY.source,
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  }
  const result = evaluateInstallability(tamperedEntry, [VALID_APPROVAL])
  assert.equal(result.installable, false)
  if (!result.installable) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /与任何审批记录都不一致/)
  }
})

test('A2-4: manifestDigest 篡改（配置或模型声明变更）必须拒绝', () => {
  const tamperedEntry = {
    ...BASE_ENTRY,
    source: {
      ...BASE_ENTRY.source,
      manifestDigest: 'sha256:' + '9'.repeat(64),
    },
  }
  const result = evaluateInstallability(tamperedEntry, [VALID_APPROVAL])
  assert.equal(result.installable, false)
  if (!result.installable) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /与任何审批记录都不一致/)
  }
})

test('A2-5: bundleDigest 篡改（产物内容被修改）必须拒绝', () => {
  const tamperedEntry = {
    ...BASE_ENTRY,
    source: {
      ...BASE_ENTRY.source,
      bundleDigest: 'sha256:' + '8'.repeat(64),
    },
  }
  const result = evaluateInstallability(tamperedEntry, [VALID_APPROVAL])
  assert.equal(result.installable, false)
  if (!result.installable) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /与任何审批记录都不一致/)
  }
})

test('A2-6: gameId 篡改（试图盗用他人审批通过的代码）必须拒绝', () => {
  const tamperedEntry = {
    ...BASE_ENTRY,
    gameId: 'attacker.fake-game',
  }
  const result = evaluateInstallability(tamperedEntry, [VALID_APPROVAL])
  assert.equal(result.installable, false)
  if (!result.installable) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /与任何审批记录都不一致/)
  }
})

test('A2-7: 审批列表为空时一律拒绝安装', () => {
  const result = evaluateInstallability(BASE_ENTRY, [])
  assert.equal(result.installable, false)
  if (!result.installable) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
  }
})
