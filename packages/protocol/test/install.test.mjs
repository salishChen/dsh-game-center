/**
 * 目录机器块解析与安装计划的契约测试（证据分栏：UNIT）。
 *
 * 运行：node --test test/install.test.mjs（需先 tsc 产出 dist/）。
 * 只验证协议纯函数，不联网、不落盘、不代表 DSH 集成行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCatalogIssueBody,
  authorizeInstall,
  buildInstallPlan,
  isSafePathSegment,
  isSafeRelativePath,
  digestMatches,
} from '../dist/install.js'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST_DIGEST = 'sha256:' + 'b'.repeat(64)
const BUNDLE_DIGEST = 'sha256:' + 'c'.repeat(64)

function makeEntry(overrides = {}) {
  return {
    schemaVersion: 1,
    gameId: 'example.minesweeping',
    title: '扫雷',
    summary: '确定性规则引擎，AI 仅生成对局',
    version: '1.0.0',
    source: {
      repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
      ref: 'v1.0.0',
      commit: COMMIT,
      manifestPath: 'gamecenter.json',
      manifestDigest: MANIFEST_DIGEST,
      bundleDigest: BUNDLE_DIGEST,
    },
    ...overrides,
  }
}

function makeApproval(overrides = {}) {
  return {
    gameId: 'example.minesweeping',
    repository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
    commit: COMMIT,
    manifestDigest: MANIFEST_DIGEST,
    bundleDigest: BUNDLE_DIGEST,
    approvedBy: 'maintainer',
    approvedAt: '2026-10-19T00:00:00Z',
    approvalRecordPath: 'approvals/example.minesweeping/1.0.0.json',
    ...overrides,
  }
}

function issueBody(entry) {
  return [
    '<!-- dsh-gamecenter-entry:v1 -->',
    '# 扫雷',
    '',
    '说明文字只作展示。',
    '',
    '```gamecenter-json',
    JSON.stringify(entry, null, 2),
    '```',
    '',
  ].join('\n')
}

test('A1 解析：合法机器块可解析', () => {
  const result = parseCatalogIssueBody(issueBody(makeEntry()))
  assert.equal(result.ok, true)
  assert.equal(result.entry.gameId, 'example.minesweeping')
  assert.equal(result.entry.source.commit, COMMIT)
})

test('A1 解析：缺少机器块必须拒绝', () => {
  const result = parseCatalogIssueBody('# 扫雷\n\n只有说明，没有机器块')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROTOCOL_INVALID')
})

test('A1 解析：多个机器块必须拒绝', () => {
  const one = JSON.stringify(makeEntry())
  const body = ['```gamecenter-json', one, '```', '', '```gamecenter-json', one, '```'].join('\n')
  const result = parseCatalogIssueBody(body)
  assert.equal(result.ok, false)
  assert.match(result.reason, /2 个机器块/)
})

test('A1 解析：未闭合围栏必须拒绝', () => {
  const body = ['```gamecenter-json', JSON.stringify(makeEntry())].join('\n')
  const result = parseCatalogIssueBody(body)
  assert.equal(result.ok, false)
})

test('A1 解析：重复 key 必须拒绝', () => {
  const raw = '{"schemaVersion":1,"gameId":"a.b","gameId":"c.d"}'
  const body = ['```gamecenter-json', raw, '```'].join('\n')
  const result = parseCatalogIssueBody(body)
  assert.equal(result.ok, false)
  assert.match(result.reason, /重复 key/)
})

test('A1 解析：未知主版本必须拒绝', () => {
  const result = parseCatalogIssueBody(issueBody(makeEntry({ schemaVersion: 2 })))
  assert.equal(result.ok, false)
  assert.match(result.reason, /主版本/)
})

test('A1 解析：未知字段与缺字段必须拒绝', () => {
  const withExtra = parseCatalogIssueBody(issueBody(makeEntry({ extra: true })))
  assert.equal(withExtra.ok, false)

  const missing = makeEntry()
  delete missing.title
  const missingResult = parseCatalogIssueBody(issueBody(missing))
  assert.equal(missingResult.ok, false)
})

test('A1 解析：短 SHA / 非 GitHub 仓库 / 非 sha256 摘要必须拒绝', () => {
  const shortSha = makeEntry()
  shortSha.source.commit = '0123456'
  assert.equal(parseCatalogIssueBody(issueBody(shortSha)).ok, false)

  const gitee = makeEntry()
  gitee.source.repository = 'https://gitee.com/x/y.git'
  assert.equal(parseCatalogIssueBody(issueBody(gitee)).ok, false)

  const badDigest = makeEntry()
  badDigest.source.bundleDigest = 'sha256:ABC'
  assert.equal(parseCatalogIssueBody(issueBody(badDigest)).ok, false)
})

test('A1 解析：超限正文必须拒绝', () => {
  const padding = 'x'.repeat(64 * 1024 + 1)
  const result = parseCatalogIssueBody(padding + issueBody(makeEntry()))
  assert.equal(result.ok, false)
  assert.match(result.reason, /超过上限/)
})

test('A2 审批：五元组一致才可通过', () => {
  const entry = makeEntry()
  const authorized = authorizeInstall(entry, [makeApproval()])
  assert.equal(authorized.ok, true)
  assert.equal(authorized.approval.approvalRecordPath, 'approvals/example.minesweeping/1.0.0.json')
})

test('A2 审批：任一字段变化都必须拒绝', () => {
  const entry = makeEntry()
  const cases = [
    makeApproval({ gameId: 'other.game' }),
    makeApproval({ repository: 'https://github.com/attacker/game.git' }),
    makeApproval({ commit: 'f'.repeat(40) }),
    makeApproval({ manifestDigest: 'sha256:' + 'd'.repeat(64) }),
    makeApproval({ bundleDigest: 'sha256:' + 'e'.repeat(64) }),
  ]
  for (const approval of cases) {
    const result = authorizeInstall(entry, [approval])
    assert.equal(result.ok, false, `应拒绝: ${JSON.stringify(approval)}`)
  }
})

test('A2 审批：没有审批记录必须拒绝', () => {
  assert.equal(authorizeInstall(makeEntry(), []).ok, false)
})

test('A3 安装计划：布局为 gameId/commit 且不覆盖旧版本', () => {
  const first = buildInstallPlan(makeEntry(), [makeApproval()])
  assert.equal(first.ok, true)
  assert.equal(first.plan.installDir, `example.minesweeping/${COMMIT}`)
  assert.equal(first.plan.approvalRecordPath, 'approvals/example.minesweeping/1.0.0.json')

  const otherCommit = 'f'.repeat(40)
  const secondEntry = makeEntry()
  secondEntry.source.commit = otherCommit
  const second = buildInstallPlan(secondEntry, [makeApproval({ commit: otherCommit })])
  assert.equal(second.ok, true)
  assert.equal(second.plan.installDir, `example.minesweeping/${otherCommit}`)
  assert.notEqual(first.plan.installDir, second.plan.installDir)
})

test('A3 安装计划：未审批不得生成计划', () => {
  const result = buildInstallPlan(makeEntry(), [])
  assert.equal(result.ok, false)
})

test('A3 路径安全：拒绝逃逸段与绝对路径', () => {
  assert.equal(isSafePathSegment('example.minesweeping'), true)
  assert.equal(isSafePathSegment('..'), false)
  assert.equal(isSafePathSegment('.'), false)
  assert.equal(isSafePathSegment('a/b'), false)
  assert.equal(isSafePathSegment('C:'), false)
  assert.equal(isSafePathSegment('a\u0000b'), false)
  assert.equal(isSafePathSegment(''), false)

  assert.equal(isSafeRelativePath('gamecenter.json'), true)
  assert.equal(isSafeRelativePath('dist/index.html'), true)
  assert.equal(isSafeRelativePath('../etc/passwd'), false)
  assert.equal(isSafeRelativePath('/etc/passwd'), false)
  assert.equal(isSafeRelativePath('C:\\Windows\\system32'), false)
  assert.equal(isSafeRelativePath('dist//a.js'), false)
})

test('A3 摘要比对：仅接受规范同值 sha256', () => {
  assert.equal(digestMatches(MANIFEST_DIGEST, MANIFEST_DIGEST), true)
  // 大写十六进制不是规范形式，直接拒绝，不做大小写归一
  assert.equal(digestMatches(MANIFEST_DIGEST, MANIFEST_DIGEST.toUpperCase()), false)
  assert.equal(digestMatches(MANIFEST_DIGEST, BUNDLE_DIGEST), false)
  assert.equal(digestMatches('sha256:ABC', MANIFEST_DIGEST), false)
})
