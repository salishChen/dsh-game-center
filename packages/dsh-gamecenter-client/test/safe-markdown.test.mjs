// @ts-check
/**
 * 受限 Markdown 渲染与媒体占位测试（v3）。
 *
 * 安全要点：
 * 1. 形状校验：raw HTML / Markdown 图片 / `javascript:`/`data:` → **整条拒绝展示**，
 *    不是"过滤掉继续显示"（过滤会让作者误以为内容已生效）；
 * 2. 渲染层：只产出 React 文本节点，**从不 innerHTML**；
 * 3. 媒体：本轮禁用，只显示占位，**不发起任何 mediaFetch 请求**。
 *
 * 运行：node --test test/safe-markdown.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
// 协议校验函数直接用 ESM 引入（与运行时同一份实现，避免测试与产物漂移）。
import { findMarkdownHazards, validateDisplayMetadata } from '@dsh-gamecenter/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 加载 SafeMarkdown（依赖 protocol 的 findMarkdownHazards）。 */
function loadSafeMarkdown() {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/SafeMarkdown.js'), 'utf8');
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/g, (_m, names, from) => {
      const mod = from.replace(/^@dsh-gamecenter\/protocol$/, 'protocol').replace(/^\.\//, '').replace(/\.js$/, '');
      const jsNames = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'))
        .join(', ');
      return `const {${jsNames}} = __deps['${mod}'];`;
    })
    .replace(/export function (\w+)/g, (_m, name) => `const ${name} = function ${name}`);
  // 导出为 CommonJS 形式（保持函数体内裸名引用可用）
  const exportNames = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]);
  const cjsWithExports = cjs + `\n;${exportNames.map((n) => `exports.${n} = ${n};`).join('\n')}`;

  const sandbox = {
    __deps: {
      protocol: { findMarkdownHazards, validateDisplayMetadata },
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
  vm.runInNewContext(cjsWithExports, sandbox);
  return sandbox.exports;
}

/** 递归提取文本 */
function texts(node) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node === 'object' && node.props) return texts(node.props.children);
  return [];
}

test('受限 Markdown：标题/列表/段落正确解析', () => {
  const { parseRestrictedMarkdown } = loadSafeMarkdown();
  const blocks = parseRestrictedMarkdown('# 玩法\n\n首击开空区。\n\n- 一条\n- 两条\n\n1. 第一\n2. 第二');
  assert.equal(blocks[0]?.kind, 'heading');
  assert.equal(blocks[0]?.level, 1);
  assert.equal(blocks[0]?.text, '玩法');
  assert.equal(blocks[1]?.kind, 'paragraph');
  assert.equal(blocks[1]?.text, '首击开空区。');
  assert.equal(blocks[2]?.kind, 'list');
  assert.equal(blocks[2]?.ordered, false);
  assert.equal(JSON.stringify(blocks[2]?.items), JSON.stringify(['一条', '两条']));
  assert.equal(blocks[3]?.kind, 'list');
  assert.equal(blocks[3]?.ordered, true);
  assert.equal(JSON.stringify(blocks[3]?.items), JSON.stringify(['第一', '第二']));
});

test('受限 Markdown：正常内容可渲染，且只产出文本节点', () => {
  const { SafeMarkdown } = loadSafeMarkdown();
  const vdom = SafeMarkdown({ text: '# 标题\n\n正文一段。\n\n- 要点' });
  assert.ok(vdom, '正常内容必须渲染');
  const joined = texts(vdom).join(' ');
  assert.match(joined, /标题/);
  assert.match(joined, /正文一段。/);
  assert.match(joined, /要点/);

  // 渲染层不得使用 innerHTML（检查**代码**，注释里提到这两个词是允许的）
  const src = fs.readFileSync(path.resolve(here, '../src/ui/SafeMarkdown.js'), 'utf8');
  const codeOnly = src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/**'))
    .join('\n');
  assert.ok(!/innerHTML/.test(codeOnly), '渲染层代码绝不允许 innerHTML');
  assert.ok(!/dangerouslySetInnerHTML/.test(codeOnly), '渲染层代码绝不允许 dangerouslySetInnerHTML');
});

test('安全负例：raw HTML / Markdown 图片 / 危险协议 一律整条拒绝展示', () => {
  const { SafeMarkdown } = loadSafeMarkdown();

  const cases = [
    ['<img src=x onerror=alert(1)>', 'raw HTML'],
    ['<script>alert(1)</script>', '危险标签'],
    ['![alt](https://evil.example/x.png)', 'Markdown 图片'],
    ['[click](javascript:alert(1))', 'javascript 协议'],
    ['<a href="data:text/html,x">x</a>', 'data 协议'],
  ];
  for (const [markdown, label] of cases) {
    const vdom = SafeMarkdown({ text: markdown });
    assert.ok(vdom, `${label}：必须渲染出拒绝提示而不是内容`);
    const joined = texts(vdom).join(' ');
    assert.match(joined, /不安全|拒绝展示/, `${label}：必须显示拒绝提示`);
    assert.equal(
      vdom.props['data-markdown-rejected'] !== undefined,
      true,
      `${label}：必须标记为已拒绝（data-markdown-rejected）`,
    );
    // 原文绝不能出现在输出里
    assert.ok(!joined.includes('<'), `${label}：原文尖括号不得出现在输出文本`);
  }
});

test('安全负例：拒绝态不得输出任何 markdown 容器', () => {
  const { SafeMarkdown } = loadSafeMarkdown();
  const vdom = SafeMarkdown({ text: '<b>bold</b>' });
  assert.equal(vdom.props['data-markdown'], undefined, '拒绝态不得渲染 markdown 容器');
});

test('安全负例（扩展向量）：SVG/iframe/vbscript/实体编码链接 一律整条拒绝', () => {
  const { SafeMarkdown } = loadSafeMarkdown();

  const cases = [
    ['<svg onload=alert(1)>', 'SVG 事件'],
    ['<iframe srcdoc="<script>alert(1)</script>">', 'iframe srcdoc'],
    ['[x](vbscript:msgbox(1))', 'vbscript 协议'],
    ['[x](data:text/html;base64,PHNjcmlwdD4=)', 'data 协议链接'],
    ['![x](https://evil.example/a.png)', 'Markdown 图片（扩展）'],
    ['<a href="java&#115;cript:alert(1)">x</a>', '实体编码 javascript'],
    ['<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', 'meta 刷新'],
  ];

  for (const [markdown, label] of cases) {
    const vdom = SafeMarkdown({ text: markdown });
    assert.ok(vdom, `${label}：必须渲染拒绝提示`);
    assert.equal(
      vdom.props['data-markdown-rejected'] !== undefined,
      true,
      `${label}：必须标记为已拒绝`,
    );
    assert.equal(vdom.props['data-markdown'], undefined, `${label}：拒绝态不得输出 markdown 容器`);
    const joined = texts(vdom).join(' ');
    assert.ok(!joined.includes('<'), `${label}：拒绝提示里不得回显原文尖括号`);
  }
});

test('纵深防御：绕过 hazard 检测的混淆向量也只能成为纯文本，不产出可执行节点', () => {
  const { SafeMarkdown } = loadSafeMarkdown();

  // 这些向量刻意不命中 findMarkdownHazards 的规则（协议层看不见），
  // 因此断言点在第二道防线：渲染层只产出文本节点，永不出现 a/img/script/iframe/svg。
  const cases = [
    ['[x](java\tscript:alert(1))', '制表符拆分的 javascript 协议'],
    ['[x](java\nscript:alert(1))', '换行拆分的 javascript 协议'],
    ['[x](//evil.example/path)', '协议相对链接'],
    ['javascript&#58;alert(1)', 'HTML 实体编码冒号'],
  ];

  const FORBIDDEN = new Set(['a', 'img', 'script', 'iframe', 'object', 'embed', 'svg', 'meta', 'link']);
  /** @param {any} node @param {Set<string>} acc */
  function collectTypes(node, acc) {
    if (node === null || node === undefined || typeof node !== 'object') return acc;
    if (Array.isArray(node)) {
      for (const child of node) collectTypes(child, acc);
      return acc;
    }
    if (typeof node.type === 'string') acc.add(node.type);
    if (node.props) collectTypes(node.props.children, acc);
    return acc;
  }

  for (const [markdown, label] of cases) {
    const vdom = SafeMarkdown({ text: markdown });
    assert.ok(vdom, `${label}：应正常渲染为文本`);
    assert.equal(vdom.props['data-markdown'] !== undefined, true, `${label}：应走普通渲染路径`);
    const types = collectTypes(vdom, new Set());
    for (const forbidden of FORBIDDEN) {
      assert.equal(types.has(forbidden), false, `${label}：不得产出 <${forbidden}> 节点`);
    }
    const joined = texts(vdom).join(' ');
    assert.ok(!/<[A-Za-z]/.test(joined), `${label}：输出文本中不得出现可解析的标签起始`);
  }
});

test('媒体：本轮禁用，只显示占位且不发起任何 mediaFetch', () => {
  const placeholderSrc = fs.readFileSync(path.resolve(here, '../src/ui/GameMediaPlaceholder.js'), 'utf8');
  // 占位组件自身不得请求媒体（注释里可以提到名字，但不能有调用）
  assert.ok(!/mediaFetch\s*\(/.test(placeholderSrc), '占位组件不得调用 mediaFetch');
  assert.ok(!/\.src\s*=\s*http/.test(placeholderSrc), '占位组件不得直接外链图片');

  const { GameMediaPlaceholder } = (() => {
    const cjs = placeholderSrc
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
    return sandbox.exports;
  })();

  // 无媒体 → 不渲染占位
  assert.equal(GameMediaPlaceholder({ cover: null, screenshots: [] }), null, '无媒体时不得渲染占位');

  // 有封面 → 渲染占位并明确"暂不可用"
  const withCover = GameMediaPlaceholder({ cover: { alt: '扫雷封面' }, screenshots: [] });
  assert.ok(withCover, '有封面必须渲染占位');
  const joined = texts(withCover).join(' ');
  assert.match(joined, /暂不可用/, '占位必须明确告知暂不可用');
  assert.match(joined, /扫雷封面/, '占位应带 alt 文本');

  // 截图 → 渲染数量占位
  const withShots = GameMediaPlaceholder({ cover: null, screenshots: [{ alt: 'a' }, { alt: 'b' }] });
  assert.match(texts(withShots).join(' '), /截图 2 张暂不可用/, '必须显示截图数量');
});

test('接线：目录卡片渲染简介与媒体占位；UI 层不调用 mediaFetch', () => {
  const overlaySrc = fs.readFileSync(path.resolve(here, '../src/ui/GameLibrary.js'), 'utf8');
  assert.match(overlaySrc, /h\(SafeMarkdown,\s*\{text:selected\.entry\.display\.descriptionMarkdown/, '卡片必须渲染受限 Markdown 简介');
  assert.match(overlaySrc, /h\(GameMediaPlaceholder,\s*\{/, '卡片必须渲染媒体占位');
  // UI 不得直接调用 mediaFetch
  assert.ok(!/mediaFetch\s*\(/.test(overlaySrc), 'UI 层不得调用 mediaFetch（媒体本轮禁用）');
  // 目录未透传 display 时必须如实告知，不得静默留白
  assert.match(overlaySrc, /data-gamecenter-no-display/, '目录未透传 display 时必须显式提示');
  assert.match(overlaySrc, /未提供简介/, '未提供简介必须有可读文案（双语）');
});

test('整条展示元数据不合规时，简介一并拒绝展示', () => {
  const { SafeMarkdown } = loadSafeMarkdown();
  // repository 与机器块 source.repository 不一致 -> validateDisplayMetadata 违规 -> 拒绝
  const vdom = SafeMarkdown({
    text: '# 正常标题\n\n正常正文。',
    display: {
      schemaVersion: 1,
      repository: 'https://github.com/other/repo',
      summary: '一句话',
      descriptionMarkdown: '# 正常标题\n\n正常正文。',
      cover: null,
      screenshots: [],
      compatibility: { gameCenter: '>=1.0.0 <2.0.0', dsh: '>=0.2.1-rc.2 <0.3.0' },
    },
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
  });
  assert.ok(vdom, '必须渲染出拒绝提示');
  assert.equal(vdom.props['data-markdown-rejected'] !== undefined, true, '元数据不合规必须整条拒绝');
  const joined = texts(vdom).join(' ');
  assert.ok(!joined.includes('正常正文'), '拒绝态不得回显简介原文');
});

test('展示元数据合规时简介正常展示', () => {
  const { SafeMarkdown } = loadSafeMarkdown();
  const vdom = SafeMarkdown({
    text: '# 标题\n\n正文。',
    display: {
      schemaVersion: 1,
      repository: 'https://github.com/salishChen/dsh-game-minesweeping',
      summary: '一句话',
      descriptionMarkdown: '# 标题\n\n正文。',
      cover: null,
      screenshots: [],
      compatibility: { gameCenter: '>=1.0.0 <2.0.0', dsh: '>=0.2.1-rc.2 <0.3.0' },
    },
    repository: 'https://github.com/salishChen/dsh-game-minesweeping',
  });
  assert.equal(vdom.props['data-markdown'] !== undefined, true, '合规元数据必须正常展示');
  assert.match(texts(vdom).join(' '), /正文。/);
});
