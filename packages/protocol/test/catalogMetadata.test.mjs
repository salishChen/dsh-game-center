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
  isTrustedMediaOriginUrl,
  validateDisplayMetadata,
  evaluateCompatibility,
  describeMetadataDigestInput,
  normalizeGameRepositoryUrl,
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
  repository: 'https://github.com/salishChen/dsh-game-minesweeping',
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

test('M-11 游戏仓库地址：只接受 GitHub 仓库 URL，规范化后与 source.repository 比对', () => {
  // 合法与规范化 / valid and normalized
  assert.equal(
    normalizeGameRepositoryUrl('https://github.com/salishChen/dsh-game-minesweeping.git'),
    'https://github.com/salishChen/dsh-game-minesweeping',
  )
  assert.equal(
    normalizeGameRepositoryUrl('https://github.com/salishChen/dsh-game-minesweeping/'),
    'https://github.com/salishChen/dsh-game-minesweeping',
  )
  // 非法：非 GitHub、凭据、query、fragment、子路径、非仓库站
  for (const bad of [
    'https://gitlab.com/a/b',
    'https://u:p@github.com/a/b',
    'https://github.com/a/b?token=1',
    'https://github.com/a/b#readme',
    'https://github.com/a/b/tree/main',
    'https://github.com/a/b/issues',
    'http://github.com/a/b',
    'https://github.com/a',
    'not-a-url',
  ]) {
    assert.equal(normalizeGameRepositoryUrl(bad), null, `应当拒绝：${bad}`)
  }
})

test('M-12 repository 必填且必须与 source.repository 一致（不一致拒绝）', () => {
  const meta = validMeta()
  const consistent = validateDisplayMetadata(meta, {
    allowedImageHosts: HOSTS,
    sourceRepository: 'https://github.com/salishChen/dsh-game-minesweeping.git',
  })
  assert.deepEqual(consistent, [])

  const mismatch = validateDisplayMetadata(meta, {
    allowedImageHosts: HOSTS,
    sourceRepository: 'https://github.com/salishChen/dsh-game-warehouse',
  })
  assert.ok(mismatch.some((v) => v.field === 'repository'), '仓库地址与 source.repository 不一致必须拒绝')

  const missing = validMeta()
  delete missing.repository
  assert.ok(
    validateDisplayMetadata(missing, { allowedImageHosts: HOSTS }).some((v) => v.field === 'repository'),
    'repository 必填',
  )
})

/**
 * 证据分栏：UNIT。受信目录后台 origin（运维在 Host 配置里给出的后台地址）。
 * 这是**按配置授予的信任**，不是放开任意 http —— 下面的反例逐条钉住边界。
 */
const TRUSTED_ORIGIN = 'http://192.168.3.222:18080'

test('M-13 受信后台 origin：只认精确 origin，不放宽公网 http', () => {
  assert.equal(
    isTrustedMediaOriginUrl(`${TRUSTED_ORIGIN}/v1/covers/x`, [TRUSTED_ORIGIN]),
    true,
    '同源 http 后台地址应放行',
  )
  assert.equal(
    isTrustedMediaOriginUrl('http://192.168.3.222:18081/v1/covers/x', [TRUSTED_ORIGIN]),
    false,
    '同 host 不同端口不是同一个 origin',
  )
  assert.equal(isTrustedMediaOriginUrl('https://evil.com/v1/covers/x', [TRUSTED_ORIGIN]), false, '未受信主机必须拒绝')
  assert.equal(
    isTrustedMediaOriginUrl('http://user@192.168.3.222:18080/v1/covers/x', [TRUSTED_ORIGIN]),
    false,
    'authority 含 @（userinfo）必须拒绝',
  )
  assert.equal(
    isTrustedMediaOriginUrl(`${TRUSTED_ORIGIN}/v1/../../etc/passwd`, [TRUSTED_ORIGIN]),
    false,
    'path 含 .. 必须拒绝',
  )
  assert.equal(isTrustedMediaOriginUrl(`${TRUSTED_ORIGIN}/v1/covers/x`, []), false, 'trustedOrigins 为空即没有任何受信来源')
  assert.equal(isTrustedMediaOriginUrl(`${TRUSTED_ORIGIN}/v1/covers/x`, undefined), false)
  // 写法容错：受信 origin 的尾斜杠与大小写不影响比较；子域不算同源。
  assert.equal(isTrustedMediaOriginUrl(`${TRUSTED_ORIGIN}/v1/covers/x`, [`  ${TRUSTED_ORIGIN}/  `]), true)
  assert.equal(isTrustedMediaOriginUrl('http://sub.192.168.3.222:18080/v1/covers/x', [TRUSTED_ORIGIN]), false)
})

test('M-14 受信 origin 放行后台封面；缺省时同一输入仍然 fail closed', () => {
  const backendMedia = () => ({ ...media(), url: `${TRUSTED_ORIGIN}/v1/covers/example.sample` })

  const trusted = validMeta()
  trusted.cover = backendMedia()
  trusted.screenshots = [backendMedia()]
  assert.deepEqual(
    validateDisplayMetadata(trusted, { allowedImageHosts: HOSTS, trustedMediaOrigins: [TRUSTED_ORIGIN] }),
    [],
    '声明受信 origin 后，后台同源封面应通过',
  )

  const untrusted = validMeta()
  untrusted.cover = backendMedia()
  assert.ok(
    validateDisplayMetadata(untrusted, { allowedImageHosts: HOSTS }).some((v) => v.field === 'cover.url'),
    '未声明受信 origin 时，http/自定义端口的后台地址必须仍然违规（默认 fail closed）',
  )
})
