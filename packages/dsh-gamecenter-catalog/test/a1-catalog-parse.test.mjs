/**
 * 验收项 A1：Issue 机器块解析（证据分栏：UNIT）
 * 覆盖：单块、重复块、超限正文、未知版本、重复 key、字段缺失、非法格式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCatalogIssueBody,
  parseGitHubIssuePayload,
} from '../dist/index.js'
import { CATALOG_MAX_ISSUE_BODY_BYTES } from '@dsh-gamecenter/protocol'

const VALID_ENTRY = {
  schemaVersion: 1,
  gameId: 'example.minesweeper',
  title: '经典扫雷',
  summary: '经典扫雷玩法，AI 生成保证可解对局。',
  version: '1.0.0',
  source: {
    repository: 'https://github.com/example/minesweeper',
    ref: 'v1.0.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    manifestPath: 'gamecenter.json',
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    bundleDigest: 'sha256:' + 'b'.repeat(64),
  },
}

function makeIssueBody(entry = VALID_ENTRY, extraText = '') {
  return `<!-- dsh-gamecenter-entry:v1 -->
# ${entry.title}

${entry.summary}
${extraText}

\`\`\`gamecenter-json
${JSON.stringify(entry, null, 2)}
\`\`\`
`
}

test('A1-1: 正确的单机器块 Issue 正文能够成功解析', () => {
  const body = makeIssueBody()
  const result = parseCatalogIssueBody(body)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.entry.gameId, 'example.minesweeper')
    assert.equal(result.entry.version, '1.0.0')
    assert.equal(result.entry.source.commit, '0123456789abcdef0123456789abcdef01234567')
  }
})

test('A1-2: 缺少机器块时必须拒绝，错误码为 PROTOCOL_INVALID', () => {
  const body = `# 纯文本 Issue\n\n没有包含任何机器块。`
  const result = parseCatalogIssueBody(body)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /未找到 gamecenter-json 机器块/)
  }
})

test('A1-3: 包含重复机器块（>=2个）时必须拒绝，错误码为 PROTOCOL_INVALID', () => {
  const single = makeIssueBody()
  const doubleBody = `${single}\n\n还有另一个块：\n\`\`\`gamecenter-json\n${JSON.stringify(VALID_ENTRY)}\n\`\`\``
  const result = parseCatalogIssueBody(doubleBody)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /只允许一个/)
  }
})

test('A1-4: 正文字节超过上限（64KB）时必须拒绝，错误码为 PROTOCOL_INVALID', () => {
  const padding = 'x'.repeat(CATALOG_MAX_ISSUE_BODY_BYTES + 10)
  const hugeBody = makeIssueBody(VALID_ENTRY, padding)
  const result = parseCatalogIssueBody(hugeBody)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /超过上限/)
  }
})

test('A1-5: 未知主版本（schemaVersion != 1）必须拒绝，错误码为 PROTOCOL_INVALID', () => {
  const badVersionEntry = { ...VALID_ENTRY, schemaVersion: 2 }
  const body = makeIssueBody(badVersionEntry)
  const result = parseCatalogIssueBody(body)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /未知机器块主版本/)
  }
})

test('A1-6: JSON 块中含有重复 key 必须拒绝，错误码为 PROTOCOL_INVALID', () => {
  const rawWithDup = `\`\`\`gamecenter-json
{
  "schemaVersion": 1,
  "gameId": "example.minesweeper",
  "gameId": "example.dup",
  "title": "测试",
  "summary": "测试摘要",
  "version": "1.0.0",
  "source": {
    "repository": "https://github.com/example/minesweeper",
    "ref": "v1.0.0",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "manifestPath": "gamecenter.json",
    "manifestDigest": "sha256:${'a'.repeat(64)}",
    "bundleDigest": "sha256:${'b'.repeat(64)}"
  }
}
\`\`\``
  const result = parseCatalogIssueBody(rawWithDup)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /含重复 key/)
  }
})

test('A1-7: 非法 commit（非 40 位小写十六进制）必须拒绝', () => {
  const badCommitEntry = {
    ...VALID_ENTRY,
    source: { ...VALID_ENTRY.source, commit: 'short-sha' },
  }
  const result = parseCatalogIssueBody(makeIssueBody(badCommitEntry))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /commit 必须是 40 位小写十六进制/)
  }
})

test('A1-8: 非法 digest（大写或非 64 位）必须拒绝', () => {
  const badDigestEntry = {
    ...VALID_ENTRY,
    source: { ...VALID_ENTRY.source, manifestDigest: 'sha256:' + 'A'.repeat(64) },
  }
  const result = parseCatalogIssueBody(makeIssueBody(badDigestEntry))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /manifestDigest 必须形如/)
  }
})

test('A1-9: 非法 repository（非 GitHub HTTPS）必须拒绝', () => {
  const badRepoEntry = {
    ...VALID_ENTRY,
    source: { ...VALID_ENTRY.source, repository: 'http://insecure.com/repo' },
  }
  const result = parseCatalogIssueBody(makeIssueBody(badRepoEntry))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /repository 必须是 https:\/\/github\.com/)
  }
})

test('A1-10: 包含 pull_request 字段的 GitHub 载荷必须排除，不作为 Issue 解析', () => {
  const prPayload = {
    number: 42,
    pull_request: { url: 'https://api.github.com/repos/example/minesweeper/pulls/42' },
    body: makeIssueBody(),
  }
  const result = parseGitHubIssuePayload(prPayload, { owner: 'example', repo: 'minesweeper' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'PROTOCOL_INVALID')
    assert.match(result.reason, /排除 Pull Request 记录/)
  }
})
