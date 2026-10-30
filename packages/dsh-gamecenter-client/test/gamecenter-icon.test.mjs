// @ts-check
/**
 * 游戏中心图标测试（2026-10-20 用户指定手柄 SVG）。
 *
 * 验收点：
 * 1. 4 个 path 的 `d` 与用户原附件**逐字一致**（造型不变）；
 * 2. viewBox 保持 `0 0 1024 1024`；
 * 3. 已去除 XML 声明、外部 DTD、编辑器元数据（`t=`/`class="icon"`/`p-id`/`xmlns:xlink`）；
 * 4. fill 用 `currentColor`（跟随 DSH 主题深浅色），不写死 `#878A94`；
 * 5. 侧栏入口与页面标题都挂上了图标；
 * 6. 可访问性：无标题时 `aria-hidden=true`（侧栏按钮已有文字标签），
 *    有标题时 `role=img` + `<title>`；
 * 7. **边界**：本地受信图标不改变 Issue 媒体规则（仍禁 SVG）。
 *
 * 运行：node --test test/gamecenter-icon.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON_SRC = path.resolve(here, '../src/ui/GameCenterIcon.js');
const ICON_ASSET = path.resolve(here, '../assets/gamecenter-icon.svg');

/** 用户原附件（只读，供逐字比对）。 */
const USER_SVG = 'C:\\Users\\salis\\.dsh\\attachments\\v1\\files\\e3\\e314871135af57c3a786f63efe27dd911f76d128b6cd89d55ee9b58137c7f835\\游戏机手柄.svg';

test('净化资产：无 XML 声明、无外部 DTD、无编辑器元数据', () => {
  const svg = fs.readFileSync(ICON_ASSET, 'utf8');
  assert.ok(!svg.includes('<?xml'), '必须去掉 XML 声明');
  assert.ok(!svg.includes('<!DOCTYPE'), '必须去掉 DOCTYPE（外部 DTD 会被解析器访问，且是 XXE 入口）');
  assert.ok(!/svg11\.dtd/.test(svg), '不得引用外部 DTD');
  assert.ok(!/\bt="/.test(svg), '必须去掉编辑器时间戳元数据');
  assert.ok(!/class="icon"/.test(svg), '必须去掉编辑器 class 元数据');
  assert.ok(!/p-id/.test(svg), '必须去掉编辑器 p-id 元数据');
  assert.ok(!/xmlns:xlink/.test(svg), '无 xlink 引用，必须去掉该命名空间声明');
  assert.ok(!/version="1.1"/.test(svg), '必须去掉 version 元数据');
});

test('净化资产：viewBox 与 4 个 path 数据逐字保留', () => {
  const svg = fs.readFileSync(ICON_ASSET, 'utf8');
  assert.match(svg, /viewBox="0 0 1024 1024"/, 'viewBox 必须逐字保留');

  // 从原附件提取 path d 值
  const original = fs.readFileSync(USER_SVG, 'utf8');
  const originalPaths = [...original.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(originalPaths.length, 4, '原附件应有 4 个 path');

  const cleanPaths = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(cleanPaths.length, 4, '净化版应有 4 个 path');
  for (let i = 0; i < 4; i += 1) {
    assert.equal(cleanPaths[i], originalPaths[i], `第 ${i + 1} 个 path 的 d 必须逐字一致`);
  }
});

test('净化资产：fill 改为 currentColor，不写死灰色', () => {
  const svg = fs.readFileSync(ICON_ASSET, 'utf8');
  assert.ok(!svg.includes('#878A94'), '不得写死原灰色（深浅色下不可读）');
  const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(fills.length, 4, '4 个 path 都应有 fill');
  for (const f of fills) {
    assert.equal(f, 'currentColor', 'fill 必须为 currentColor 以跟随 DSH 主题');
  }
});

test('GameCenterIcon 组件：渲染内联 SVG 且属性正确', () => {
  const src = fs.readFileSync(ICON_SRC, 'utf8');
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_m, names) => {
      const jsNames = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'))
        .join(', ');
      return `const {${jsNames}} = __deps.react;`;
    })
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');

  const sandbox = {
    __deps: {
      react: {
        createElement: (type, props, ...children) => ({
          type,
          props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
        }),
      },
    },
    exports: {},
  };
  sandbox.module = { exports: sandbox.exports };
  vm.runInNewContext(cjs, sandbox);

  const { GameCenterIcon } = sandbox.exports;
  assert.equal(typeof GameCenterIcon, 'function', '必须导出 GameCenterIcon');

  // 默认（无标题）：装饰用，aria-hidden=true
  const plain = GameCenterIcon({});
  assert.equal(plain.type, 'svg');
  assert.equal(plain.props.viewBox, '0 0 1024 1024', 'viewBox 必须正确');
  assert.equal(plain.props['aria-hidden'], 'true', '无标题时必须对辅助技术隐藏');
  assert.equal(plain.props.width, 20, '默认尺寸 20');
  assert.equal(plain.props.height, 20);
  const paths = plain.props.children;
  assert.equal(Array.isArray(paths) ? paths.length : 0, 4, '必须渲染 4 个 path');
  for (const p of paths) {
    assert.equal(p.type, 'path');
    assert.equal(p.props.fill, 'currentColor', 'path fill 必须 currentColor');
    assert.ok(typeof p.props.d === 'string' && p.props.d.length > 50, 'path d 必须非空');
  }

  // 指定尺寸
  const big = GameCenterIcon({ size: 48 });
  assert.equal(big.props.width, 48);
  assert.equal(big.props.height, 48);

  // 有标题：暴露给辅助技术
  const titled = GameCenterIcon({ size: 20, title: '游戏中心' });
  assert.equal(titled.props['aria-hidden'], undefined, '有标题时不得 aria-hidden');
  assert.equal(titled.props.role, 'img', '有标题时必须 role=img');
  const titledChildren = titled.props.children;
  const titleNode = titledChildren.find((/** @type {any} */ c) => c.type === 'title');
  assert.ok(titleNode, '有标题时必须渲染 <title>');
  assert.equal(titleNode.props.children, '游戏中心');
});

test('接线：侧栏入口与页面标题都使用该图标', () => {
  const indexSrc = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');
  assert.match(indexSrc, /h\(GameCenterIcon, \{ size: 20 \}\)/, '侧栏入口必须使用手柄图标');
  assert.ok(!indexSrc.includes("'🎮'"), '不得再使用 emoji 占位图标');

  const pageSrc = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterPage.js'), 'utf8');
  assert.match(pageSrc, /h\(GameCenterIcon, \{ size: 24 \}\)/, '页面标题必须使用手柄图标');
});

test('边界：本地受信图标不改变 Issue 媒体禁 SVG 规则', () => {
  // 这条是防回归：别因为"平台自己用了 SVG"就放宽目录媒体校验。
  // 用 new URL 相对 import.meta.url 定位，避免数目录层级出错。
  // client/test/x.mjs → ../../protocol/src/catalogMetadata.ts ⇒ packages/protocol/src/...
  const protocolUrl = new URL('../../protocol/src/catalogMetadata.ts', import.meta.url);
  const protocolSrc = fs.readFileSync(protocolUrl, 'utf8');
  // 白名单必须逐字只有这四种，绝不含 image/svg+xml
  const mimeMatch = protocolSrc.match(/MEDIA_ALLOWED_MIME\s*=\s*\[([^\]]+)\]/);
  assert.ok(mimeMatch, '必须能读到 MEDIA_ALLOWED_MIME 定义');
  const mimes = [...mimeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    mimes,
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    '媒体 MIME 白名单必须逐字为这四种',
  );
  assert.ok(!mimes.includes('image/svg+xml'), '媒体白名单不得包含 SVG');
});
