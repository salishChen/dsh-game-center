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

test('A1-11: 正文"游戏地址"与机器块 source.repository 规范化后一致性校验', () => {
  // 正向：规范化后一致
  const validBody = `
- **游戏地址 / Game repository URL**（必填 / required）：\`https://github.com/example/minesweeper.git\`

\`\`\`gamecenter-json
${JSON.stringify(VALID_ENTRY, null, 2)}
\`\`\`
`
  const okRes = parseGitHubIssuePayload({ number: 1, body: validBody }, { owner: 'catalog', repo: 'warehouse' })
  assert.equal(okRes.ok, true)

  // 负向：不一致（仓库被篡改）
  const mismatchBody = `
- **游戏地址 / Game repository URL**（必填 / required）：\`https://github.com/attacker/evil.git\`

\`\`\`gamecenter-json
${JSON.stringify(VALID_ENTRY, null, 2)}
\`\`\`
`
  const mismatchRes = parseGitHubIssuePayload({ number: 1, body: mismatchBody }, { owner: 'catalog', repo: 'warehouse' })
  assert.equal(mismatchRes.ok, false)
  if (!mismatchRes.ok) {
    assert.equal(mismatchRes.code, 'PROTOCOL_INVALID')
    assert.match(mismatchRes.reason, /正文游戏地址与机器块 source.repository 规范化后不一致/)
  }

  // 负向：正文游戏地址带凭据或非法格式
  const badUrlBody = `
- **游戏地址 / Game repository URL**（必填 / required）：\`https://user:pass@github.com/example/minesweeper.git\`

\`\`\`gamecenter-json
${JSON.stringify(VALID_ENTRY, null, 2)}
\`\`\`
`
  const badUrlRes = parseGitHubIssuePayload({ number: 1, body: badUrlBody }, { owner: 'catalog', repo: 'warehouse' })
  assert.equal(badUrlRes.ok, false)
  if (!badUrlRes.ok) {
    assert.equal(badUrlRes.code, 'PROTOCOL_INVALID')
    assert.match(badUrlRes.reason, /正文游戏地址格式不合法/)
  }
})

test('A1-12: 展示元数据校验与 Markdown 危险构造拦截', () => {
  const baseEntryWithDisplay = (displayOverrides = {}) => ({
    ...VALID_ENTRY,
    display: {
      schemaVersion: 1,
      summary: '有效纯文本简介',
      descriptionMarkdown: '## 玩法\n- 正常 markdown 文本',
      cover: {
        url: 'https://user-images.githubusercontent.com/1/cover.png',
        sha256: 'sha256:' + 'a'.repeat(64),
        mime: 'image/png',
        width: 1280,
        height: 720,
        alt: '封面图',
      },
      screenshots: [],
      compatibility: {
        gameCenter: '>=1.0.0 <2.0.0',
        dsh: '>=0.2.1-rc.2 <0.3.0',
      },
      ...displayOverrides,
    },
  })

  // 正向：合法展示元数据
  const okPayload = {
    number: 1,
    body: `\`\`\`gamecenter-json\n${JSON.stringify(baseEntryWithDisplay(), null, 2)}\n\`\`\``,
  }
  const okRes = parseGitHubIssuePayload(okPayload, { owner: 'catalog', repo: 'warehouse' })
  assert.equal(okRes.ok, true)

  // 负向：Markdown 包含 raw HTML (如 <img> 或 <b>)
  const htmlEntry = baseEntryWithDisplay({
    descriptionMarkdown: '## 介绍\n<img src="https://evil.com/x.png">',
  })
  const htmlRes = parseGitHubIssuePayload(
    { number: 1, body: `\`\`\`gamecenter-json\n${JSON.stringify(htmlEntry, null, 2)}\n\`\`\`` },
    { owner: 'catalog', repo: 'warehouse' },
  )
  assert.equal(htmlRes.ok, false)
  if (!htmlRes.ok) {
    assert.equal(htmlRes.code, 'PROTOCOL_INVALID')
    assert.match(htmlRes.reason, /简介含禁用构造：raw-html/)
  }

  // 负向：Markdown 包含 Markdown 图片语法
  const mdImgEntry = baseEntryWithDisplay({
    descriptionMarkdown: '## 介绍\n![图片](https://user-images.githubusercontent.com/1/a.png)',
  })
  const mdImgRes = parseGitHubIssuePayload(
    { number: 1, body: `\`\`\`gamecenter-json\n${JSON.stringify(mdImgEntry, null, 2)}\n\`\`\`` },
    { owner: 'catalog', repo: 'warehouse' },
  )
  assert.equal(mdImgRes.ok, false)
  if (!mdImgRes.ok) {
    assert.equal(mdImgRes.code, 'PROTOCOL_INVALID')
    assert.match(mdImgRes.reason, /简介含禁用构造：markdown-image/)
  }

  // 负向：Markdown 包含危险协议
  const jsEntry = baseEntryWithDisplay({
    descriptionMarkdown: '## 介绍\n[恶意链接](javascript:alert(1))',
  })
  const jsRes = parseGitHubIssuePayload(
    { number: 1, body: `\`\`\`gamecenter-json\n${JSON.stringify(jsEntry, null, 2)}\n\`\`\`` },
    { owner: 'catalog', repo: 'warehouse' },
  )
  assert.equal(jsRes.ok, false)
  if (!jsRes.ok) {
    assert.equal(jsRes.code, 'PROTOCOL_INVALID')
    assert.match(jsRes.reason, /简介含禁用构造：unsafe-scheme/)
  }

  // 负向：SVG 格式被拒
  const svgEntry = baseEntryWithDisplay({
    cover: {
      url: 'https://user-images.githubusercontent.com/1/cover.png',
      sha256: 'sha256:' + 'a'.repeat(64),
      mime: 'image/svg+xml',
      width: 1280,
      height: 720,
      alt: 'SVG 封面',
    },
  })
  const svgRes = parseGitHubIssuePayload(
    { number: 1, body: `\`\`\`gamecenter-json\n${JSON.stringify(svgEntry, null, 2)}\n\`\`\`` },
    { owner: 'catalog', repo: 'warehouse' },
  )
  assert.equal(svgRes.ok, false)
  if (!svgRes.ok) {
    assert.equal(svgRes.code, 'PROTOCOL_INVALID')
    assert.match(svgRes.reason, /只允许 png\/jpeg\/webp\/gif（禁止 SVG）/)
  }
})

test('A1-13: 目录仓真实模板与草稿负向测试（TO_BE_GENERATED 占位必须被拒绝）', async () => {
  const fs = await import('node:fs/promises')

  const templatePath = 'C:/Users/salis/Desktop/warehouse/dsh-game-center-warehouse/.github/ISSUE_TEMPLATE/dsh-gamecenter-listing.md'
  const draftPath = 'C:/Users/salis/Desktop/warehouse/dsh-game-center-warehouse/game-issues/drafts/2026-10-20-minesweeping-listing-draft.md'

  const templateContent = await fs.readFile(templatePath, 'utf-8')
  const templateResult = parseGitHubIssuePayload(
    { number: 100, body: templateContent },
    { owner: 'salishChen', repo: 'dsh-game-center-warehouse' },
  )
  assert.equal(templateResult.ok, false, '上架模板因包含占位标记必须被拒绝')
  if (!templateResult.ok) {
    assert.equal(templateResult.code, 'PROTOCOL_INVALID')
    assert.match(templateResult.reason, /(?:repository 必须是|commit 必须是 40 位小写十六进制)/)
  }

  const draftContent = await fs.readFile(draftPath, 'utf-8')
  const draftResult = parseGitHubIssuePayload(
    { number: 101, body: draftContent },
    { owner: 'salishChen', repo: 'dsh-game-center-warehouse' },
  )
  assert.equal(draftResult.ok, false, '扫雷草稿因包含 TO_BE_GENERATED 占位必须被拒绝')
  if (!draftResult.ok) {
    assert.equal(draftResult.code, 'PROTOCOL_INVALID')
    assert.match(draftResult.reason, /commit 必须是 40 位小写十六进制/)
  }
})
