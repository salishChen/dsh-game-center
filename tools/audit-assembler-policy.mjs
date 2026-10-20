#!/usr/bin/env node
/**
 * 文档组装策略对账器（架构与协议负责人维护）。
 *
 * 背景：PM 2026-10-20 要求"目录内联须明确支持的 HTML／脚本／样式范围，遇到未处理引用
 * 显式拒绝，不做不完整转换后继续运行"。冻结规则见 docs/phase1-production-wiring.md §3.1：
 *
 *   支持：<script src>、<link rel=stylesheet>、<img src>（本地或 data:）
 *   一律拒绝：http(s)/`//` 外链、清单外文件、CSS `@import`、`url()` 非 data、
 *            module `import`、<iframe>/<object>/<embed>/<base>/<form action>
 *
 * 本脚本直接 import 真实 assembler（无 DOM 依赖），逐条喂样本并检查是否**拒绝**。
 * 它不修改任何文件；发现"静默放过"就 FAIL 并以退出码 1 结束。
 *
 * 用法：node tools/audit-assembler-policy.mjs [--json]
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assembler = await import(
  pathToFileURL(path.join(ROOT, 'packages/dsh-gamecenter-client/src/runtime/assembler.js')).href
)
const { assembleGameDocument } = assembler
const asJson = process.argv.includes('--json')

const OPTIONS = { runtimeInstanceId: 'rt-test', nonce: 'n-test' }

/** @param {Array<{path: string, content: string}>} files */
const baseFiles = (files) =>
  files.some((file) => file.path === 'dist/index.html')
    ? files
    : [{ path: 'dist/index.html', content: '<!doctype html><html><head></head><body></body></html>' }, ...files]

/**
 * 期望"必须拒绝"的样本。`expect: 'reject'` 表示 assemble 必须抛错。
 * @type {{name: string, entry?: string, files: {path: string, content: string}[], expect: 'reject'|'accept'}[]}
 */
const cases = [
  {
    name: '外部样式链接 https',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><head><link rel="stylesheet" href="https://evil.example/x.css"></head></html>' }]),
    expect: 'reject',
  },
  {
    name: '协议相对外链 //',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><head><script src="//evil.example/x.js"></script></head></html>' }]),
    expect: 'reject',
  },
  {
    name: '清单外脚本文件',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><head><script src="./missing.js"></script></head></html>' }]),
    expect: 'reject',
  },
  {
    name: '外部 iframe',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><iframe src="https://evil.example/f"></iframe></body></html>' }]),
    expect: 'reject',
  },
  {
    name: 'base 基址劫持',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><head><base href="https://evil.example/"></head></html>' }]),
    expect: 'reject',
  },
  {
    name: 'form 外发表单',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><form action="https://evil.example/post"></form></body></html>' }]),
    expect: 'reject',
  },
  {
    name: 'object 嵌入',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><object data="./x.swf"></object></body></html>' }]),
    expect: 'reject',
  },
  {
    name: '内联样式里的 @import',
    files: baseFiles([
      {
        path: 'dist/index.html',
        content: '<html><head><style>@import url("https://evil.example/a.css");</style></head></html>',
      },
    ]),
    expect: 'reject',
  },
  {
    name: '被内联 CSS 文件里的外部 url()',
    files: [
      { path: 'dist/index.html', content: '<html><head><link rel="stylesheet" href="./s.css"></head><body></body></html>' },
      { path: 'dist/s.css', content: 'body { background: url("https://evil.example/bg.png"); }' },
    ],
    expect: 'reject',
  },
  {
    name: 'module 脚本里的远程 import',
    files: baseFiles([
      {
        path: 'dist/index.html',
        content: '<html><body><script type="module">import x from "https://evil.example/m.js";</script></body></html>',
      },
    ]),
    expect: 'reject',
  },
  {
    name: '本地 img 需转 data: 或拒绝（不得原样外链）',
    files: [
      { path: 'dist/index.html', content: '<html><body><img src="./icon.svg"></body></html>' },
      { path: 'dist/icon.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    ],
    expect: 'reject',
  },
  // —— 2026-10-20 追加：绕过样本（PM 要求"不能只靠几个样本凑绿"）——
  {
    name: '内联 style 属性里的外部 url()',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><div style="background:url(https://evil.example/b.png)">x</div></body></html>' }]),
    expect: 'reject',
  },
  {
    name: 'svg image 的远程 href',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><svg><image href="https://evil.example/x.png"/></svg></body></html>' }]),
    expect: 'reject',
  },
  {
    name: 'meta refresh 跳转出口',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><head><meta http-equiv=refresh content="0;url=https://evil.example/"></head><body></body></html>' }]),
    expect: 'reject',
  },
  {
    name: 'formaction 外发表单',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><button formaction="https://evil.example/p">x</button></body></html>' }]),
    expect: 'reject',
  },
  {
    name: 'script 属性换行仍须内联或拒绝',
    files: baseFiles([
      { path: 'dist/index.html', content: '<html><body><script\nsrc="./g.js"></script></body></html>' },
      { path: 'dist/g.js', content: 'console.log(1)' },
    ]),
    expect: 'accept_inlined',
  },
  {
    name: '外部 srcset 候选图',
    files: baseFiles([{ path: 'dist/index.html', content: '<html><body><img src="data:image/png;base64,AA" srcset="https://evil.example/x2.png 2x"></body></html>' }]),
    expect: 'reject',
  },
  {
    name: '正常三件套（应接受并内联 + 注入 CSP）',
    files: [
      { path: 'dist/index.html', content: '<html><head><link rel="stylesheet" href="./s.css"></head><body><script src="./g.js"></script></body></html>' },
      { path: 'dist/s.css', content: 'body{color:#111}' },
      { path: 'dist/g.js', content: 'console.log("game")' },
    ],
    expect: 'accept',
  },
]

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = []

for (const testCase of cases) {
  let threw = null
  let doc = null
  try {
    doc = assembleGameDocument({
      entryPath: 'dist/index.html',
      files: testCase.files,
      options: OPTIONS,
    })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }

  if (testCase.expect === 'reject') {
    if (threw !== null) {
      results.push({ name: testCase.name, ok: true, detail: `已拒绝：${threw.slice(0, 90)}` })
      continue
    }
    // 未抛错 → 检查是否至少被改写成了安全形式（img 允许 data: 化）
    const sanitized =
      doc !== null && !/https?:\/\/(?!www\.w3\.org)/i.test(doc.replace(/<meta[^>]*>/gi, '')) ? false : false
    results.push({
      name: testCase.name,
      ok: sanitized,
      detail: '静默放过：没有抛错，文档仍被组装出来（违反"未处理引用必须显式拒绝"）',
    })
    continue
  }

  // accept_inlined：必须接受，且指定文件必须被内联
  if (testCase.expect === 'accept_inlined') {
    if (threw !== null) {
      results.push({ name: testCase.name, ok: false, detail: `不应拒绝却抛错：${threw.slice(0, 120)}` })
      continue
    }
    const inlined = /data-inlined="dist\/g\.js"/.test(doc)
    results.push({
      name: testCase.name,
      ok: inlined,
      detail: inlined ? '已内联 g.js' : '未内联 g.js：脚本被静默丢弃，游戏会静默失效',
    })
    continue
  }

  // accept 分支
  if (threw !== null) {
    results.push({ name: testCase.name, ok: false, detail: `不应拒绝却抛错：${threw.slice(0, 120)}` })
    continue
  }
  const hasCsp = /Content-Security-Policy/.test(doc) && /connect-src 'none'/.test(doc)
  const inlinedStyle = /<style[^>]*data-inlined/.test(doc)
  const inlinedScript = /<script[^>]*data-inlined/.test(doc)
  const noLocalRefs = !/href="\.\/s\.css"|src="\.\/g\.js"/.test(doc)
  const ok = hasCsp && inlinedStyle && inlinedScript && noLocalRefs
  results.push({
    name: testCase.name,
    ok,
    detail: `CSP=${hasCsp} style内联=${inlinedStyle} script内联=${inlinedScript} 无残留引用=${noLocalRefs}`,
  })
}

const failed = results.filter((result) => !result.ok)

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
} else {
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`)
    console.log(`        ${result.detail}`)
  }
  console.log('')
  console.log(`合计 ${results.length} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    console.log('结论：assembler 未达到 §3.1 冻结规则（未覆盖的引用必须先拒绝，不能静默组装）')
  }
}

process.exit(failed.length === 0 ? 0 : 1)
