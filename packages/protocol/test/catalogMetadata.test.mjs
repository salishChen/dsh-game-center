/**
 * 目录展示元数据与兼容性门禁的单元测试（UNIT）。
 *
 * 中文：验证 Markdown 危险构造、受控图片 URL、元数据校验与兼容性门禁；
 * 全部为纯函数，不联网、不读 GitHub、不代表 DSH-REAL。
 * English: unit tests for the display-metadata extension and the compatibility gate.
 * Pure functions only; no network, no GitHub, not a DSH-REAL result.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  METADATA_APPROVAL_ENABLED,
  COVER_MAX_COUNT,
  SCREENSHOT_MAX_COUNT,
  findMarkdownHazards,
  isAllowedMediaUrl,
  validateDisplayMetadata,
  evaluateCompatibility,
  describeMetadataDigestInput,
} from '../dist/catalogMetadata.js'
import { sdkRangeAccepts } from '../dist/version.js'

const HOSTS = ['user-images.githubusercontent.com', 'raw.githubusercontent.com']
const DIGEST = 'sha256:' + 'a'.repeat(64)

const media = () => ({
  url: 'https://user-images.githubusercontent.com/1/cover.png',
  sha256: DIGEST,
  mime: 'image/png',
  width: 640,
  height: 360,
  alt: '扫雷界面 / Minesweeper screen',
})

const validMeta = () => ({
  schemaVersion: 1,
  summary: '确定性扫雷，AI 只生成对局 / Deterministic Minesweeper',
  descriptionMarkdown: '## 扫雷\n- 无猜生成\n\n**Deterministic** board generation.',
  cover: media(),
  screenshots: [media()],
  compatibility: { gameCenter: '^1.0.0', dsh: '>=0.2.1-rc.2 <0.3.0' },
})

test('M-01 Markdown：raw HTML 一律拒绝，不设 <img> 例外', () => {
  assert.deepEqual(findMarkdownHazards('<img src=x onerror=alert(1)>'), ['raw-html'])
  assert.deepEqual(findMarkdownHazards('<b>粗体</b>'), ['raw-html'])
  assert.deepEqual(findMarkdownHazards('<script>alert(1)</script>'), ['raw-html', 'active-tag'])
})

test('M-02 Markdown：图片只能走受控 media，Markdown 图片语法被拒', () => {
  assert.ok(findMarkdownHazards('![封面](https://x/y.png)').includes('markdown-image'))
  assert.deepEqual(findMarkdownHazards('普通 **markdown** 文本 / plain markdown'), [])
})

test('M-03 Markdown：危险协议被拒', () => {
  assert.ok(findMarkdownHazards('[点我](javascript:alert(1))').includes('unsafe-scheme'))
  assert.ok(findMarkdownHazards('data:text/html;base64,xx').includes('unsafe-scheme'))
})

test('M-04 图片 URL：只允许 https + 精确白名单 host，无 userinfo/端口/IP/内网', () => {
  assert.equal(isAllowedMediaUrl('https://user-images.githubusercontent.com/1/a.png', HOSTS), true)
  assert.equal(isAllowedMediaUrl('http://user-images.githubusercontent.com/1/a.png', HOSTS), false)
  assert.equal(isAllowedMediaUrl('https://u:p@user-images.githubusercontent.com/a.png', HOSTS), false)
  assert.equal(isAllowedMediaUrl('https://user-images.githubusercontent.com:8443/a.png', HOSTS), false)
  assert.equal(isAllowedMediaUrl('https://192.168.3.222/a.png', HOSTS), false)
  assert.equal(isAllowedMediaUrl('https://localhost/a.png', HOSTS), false)
  assert.equal(isAllowedMediaUrl('https://evil.com/a.png', HOSTS), false)
  // 后缀伪装：必须是精确 host 匹配
  assert.equal(isAllowedMediaUrl('https://user-images.githubusercontent.com.evil.com/a.png', HOSTS), false)
})

test('M-05 元数据：合法样例通过', () => {
  assert.deepEqual(validateDisplayMetadata(validMeta(), { allowedImageHosts: HOSTS }), [])
})

test('M-06 元数据：SVG 被拒（SVG 可携带主动内容）', () => {
  const meta = validMeta()
  meta.cover.mime = 'image/svg+xml'
  const out = validateDisplayMetadata(meta, { allowedImageHosts: HOSTS })
  assert.ok(out.some((v) => v.field === 'cover.mime'))
})

test('M-07 元数据：截图数量与尺寸上限，alt 必填', () => {
  const meta = validMeta()
  meta.screenshots = Array.from({ length: SCREENSHOT_MAX_COUNT + 1 }, () => media())
  assert.ok(validateDisplayMetadata(meta, { allowedImageHosts: HOSTS }).some((v) => v.field === 'screenshots'))

  const tooBig = validMeta()
  tooBig.cover.width = 99999
  assert.ok(validateDisplayMetadata(tooBig, { allowedImageHosts: HOSTS }).some((v) => v.field === 'cover.width'))

  const noAlt = validMeta()
  noAlt.cover.alt = '   '
  assert.ok(validateDisplayMetadata(noAlt, { allowedImageHosts: HOSTS }).some((v) => v.field === 'cover.alt'))
  assert.equal(COVER_MAX_COUNT, 1)
})

test('M-08 元数据：compatibility 必须两个范围且 fail closed', () => {
  const missing = validMeta()
  delete missing.compatibility
  assert.ok(validateDisplayMetadata(missing, { allowedImageHosts: HOSTS }).some((v) => v.field === 'compatibility'))

  const bad = validMeta()
  bad.compatibility = { gameCenter: 'not a range;;', dsh: '>=0.2.1-rc.2 <0.3.0' }
  assert.ok(
    validateDisplayMetadata(bad, { allowedImageHosts: HOSTS }).some((v) => v.field === 'compatibility.gameCenter'),
  )

  const unknown = validMeta()
  unknown.compatibility = { gameCenter: '^1.0.0', dsh: 'latest' }
  assert.ok(
    validateDisplayMetadata(unknown, { allowedImageHosts: HOSTS }).some((v) => v.field === 'compatibility.dsh'),
    '未知范围必须拒绝 / unknown range must fail closed',
  )
})

test('M-09 兼容性门禁：真实判定，不满足即拒绝', () => {
  const compat = { gameCenter: '^1.0.0', dsh: '>=0.2.1-rc.2 <0.3.0' }
  assert.deepEqual(
    evaluateCompatibility(compat, { gameCenter: '1.2.0', dsh: '0.2.1-rc.2' }, sdkRangeAccepts),
    { ok: true },
  )
  const oldDsh = evaluateCompatibility(compat, { gameCenter: '1.2.0', dsh: '0.3.0' }, sdkRangeAccepts)
  assert.equal(oldDsh.ok, false)
  assert.equal(oldDsh.field, 'dsh')
  const oldGc = evaluateCompatibility(compat, { gameCenter: '2.0.0', dsh: '0.2.1-rc.2' }, sdkRangeAccepts)
  assert.equal(oldGc.ok, false)
  assert.equal(oldGc.field, 'gameCenter')
})

test('M-10 元数据审批未启用：不宣称编辑即失效，也不宣称元数据已审批', () => {
  assert.equal(METADATA_APPROVAL_ENABLED, false)
  const info = describeMetadataDigestInput()
  assert.equal(info.enabled, false)
  assert.match(info.algorithm, /sha256/)
})
