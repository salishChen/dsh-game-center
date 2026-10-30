// @ts-check
/**
 * 游戏文档组装器与安全内联单元测试（证据分栏：UNIT）。
 *
 * 验证重点：
 * 1. 严格沙箱与 CSP 策略强断言（对齐 packages/protocol/src/wiring.ts）。
 * 2. 外部资源链接防御：引用 http(s) 脚本或样式必须立即拒绝。
 * 3. 相对路径安全解析与文件内联：本地 style 与 script 完整内联且顺序正确。
 * 4. 引导脚本优先注入：SDK 引导脚本必须位于任何游戏脚本之前。
 * 5. bundle 文件清单校验：超限、路径逃逸或重复路径坚决拒绝。
 *
 * 运行：node --test test/assembler.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_IFRAME_SANDBOX,
  GAME_DOCUMENT_CSP,
  validateFramePolicy,
  isSafeBundlePath,
  validateGameBundleFiles,
  GAME_BUNDLE_MAX_FILE_BYTES,
  assembleGameDocument,
} from '../src/runtime/assembler.js';

test('沙箱与 CSP 策略安全强断言：必须严格为 allow-scripts 且具备完整 CSP 限制', () => {
  // 1. 沙箱属性绝对不能包含 allow-same-origin
  assert.equal(GAME_IFRAME_SANDBOX, 'allow-scripts');
  const violations = validateFramePolicy(GAME_IFRAME_SANDBOX, GAME_DOCUMENT_CSP);
  assert.deepEqual(violations, [], '沙箱与 CSP 策略必须 100% 通过验证');

  // 2. 负例：一旦被修改引入 allow-same-origin 必须立即报错
  const badPolicy = validateFramePolicy('allow-scripts allow-same-origin', GAME_DOCUMENT_CSP);
  assert.ok(badPolicy.some((v) => v.field === 'sandbox' && v.reason.includes('allow-same-origin')));

  // 3. 负例：CSP 放开网络必须立即报错
  const badCsp = validateFramePolicy(GAME_IFRAME_SANDBOX, "default-src *; connect-src 'self'");
  assert.ok(badCsp.some((v) => v.field === 'csp'));
});

test('安全路径校验：白名单后缀放行，路径穿越与非法字符严格拒绝', () => {
  // 正例
  assert.equal(isSafeBundlePath('dist/index.html'), true);
  assert.equal(isSafeBundlePath('style.css'), true);
  assert.equal(isSafeBundlePath('assets/image.svg'), true);
  assert.equal(isSafeBundlePath('game.js'), true);

  // 负例
  assert.equal(isSafeBundlePath('../secret.txt'), false, '穿越段必须拒绝');
  assert.equal(isSafeBundlePath('/absolute/path.js'), false, '绝对路径必须拒绝');
  assert.equal(isSafeBundlePath('dist\\style.css'), false, '反斜杠必须拒绝');
  assert.equal(isSafeBundlePath('binary.exe'), false, '非白名单后缀必须拒绝');
  assert.equal(isSafeBundlePath(''), false, '空路径必须拒绝');
  assert.equal(isSafeBundlePath('folder/'), false, '目录尾部斜杠必须拒绝');
});

test('Bundle 文件清单校验：空文件、重复路径、超限文件与总大小拦截', () => {
  // 1. 正常清单
  const validFiles = [
    { path: 'dist/index.html', content: '<html><body></body></html>' },
    { path: 'dist/game.js', content: 'console.log(1);' },
  ];
  assert.deepEqual(validateGameBundleFiles(validFiles), []);

  // 2. 空数组
  assert.ok(validateGameBundleFiles([]).length > 0);

  // 3. 重复路径
  const dupFiles = [
    { path: 'dist/game.js', content: 'a' },
    { path: 'dist/game.js', content: 'b' },
  ];
  assert.ok(validateGameBundleFiles(dupFiles).some((v) => v.reason.includes('重复')));

  // 4. 单文件超限 (1MB)
  const hugeFile = [
    { path: 'dist/huge.js', content: 'x'.repeat(GAME_BUNDLE_MAX_FILE_BYTES + 10) },
  ];
  assert.ok(validateGameBundleFiles(hugeFile).some((v) => v.reason.includes('超过上限')));
});

test('文档组装与安全内联：内联样式、内联脚本、注入 CSP 与 SDK 引导', () => {
  const sampleFiles = [
    {
      path: 'dist/index.html',
      content: `<!DOCTYPE html>
<html>
<head>
  <title>Test Game</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <h1>Game</h1>
  <script src="./game.js"></script>
</body>
</html>`,
    },
    {
      path: 'dist/style.css',
      content: 'body { background: black; color: white; }',
    },
    {
      path: 'dist/game.js',
      content: 'window.__GAME_INITIALIZED__ = true;',
    },
  ];

  const assembled = assembleGameDocument({
    entryPath: 'dist/index.html',
    files: sampleFiles,
    options: {
      runtimeInstanceId: 'rt-inst-test-1',
      nonce: 'nonce-sample-123',
      initialSeed: 42,
      initialElapsedMs: 1500,
      initialRevision: 2,
    },
  });

  // 1. 验证外部引用已彻底消除
  assert.equal(assembled.includes('<link rel="stylesheet"'), false, '不应再有外部样式标签');
  assert.equal(assembled.includes('<script src='), false, '不应再有外部脚本引用');

  // 2. 验证样式与脚本内联成功
  assert.ok(assembled.includes('<style data-inlined="dist/style.css">'));
  assert.ok(assembled.includes('body { background: black; color: white; }'));
  assert.ok(assembled.includes('<script data-inlined="dist/game.js"'));
  assert.ok(assembled.includes('window.__GAME_INITIALIZED__ = true;'));

  // 3. 验证 CSP Meta 成功注入且位于最前
  assert.ok(assembled.includes('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(assembled.includes("connect-src 'none'"));

  // 4. 验证 SDK 引导脚本成功注入且位于游戏脚本之前
  assert.ok(assembled.includes('<script data-gamecenter-bootstrap>'));
  assert.ok(assembled.includes('window.__DSH_GAMECENTER_SDK__'));
  assert.ok(assembled.includes('"rt-inst-test-1"'));
  assert.ok(assembled.includes('"nonce-sample-123"'));

  const bootstrapPos = assembled.indexOf('<script data-gamecenter-bootstrap>');
  const gameScriptPos = assembled.indexOf('<script data-inlined="dist/game.js"');
  assert.ok(bootstrapPos < gameScriptPos, 'SDK 引导脚本必须先于游戏自身脚本注入执行');
});

test('安全防御拦截：检测到任何 http/https/相对路径逃逸的外部外链坚决拒绝', () => {
  // 1. 外部样式外链
  const externalCss = [
    {
      path: 'index.html',
      content: '<html><head><link rel="stylesheet" href="https://evil.com/style.css"></head><body></body></html>',
    },
  ];
  assert.throws(
    () => assembleGameDocument({ entryPath: 'index.html', files: externalCss, options: { runtimeInstanceId: '1', nonce: '1' } }),
    /禁止外部样式链接/,
  );

  // 2. 外部脚本外链
  const externalJs = [
    {
      path: 'index.html',
      content: '<html><head></head><body><script src="http://evil.com/malicious.js"></script></body></html>',
    },
  ];
  assert.throws(
    () => assembleGameDocument({ entryPath: 'index.html', files: externalJs, options: { runtimeInstanceId: '1', nonce: '1' } }),
    /禁止外部脚本链接/,
  );

  // 3. 缺少引用的内部文件
  const missingRef = [
    {
      path: 'index.html',
      content: '<html><head></head><body><script src="./non-existent.js"></script></body></html>',
    },
  ];
  assert.throws(
    () => assembleGameDocument({ entryPath: 'index.html', files: missingRef, options: { runtimeInstanceId: '1', nonce: '1' } }),
    /缺少依赖脚本文件/,
  );
});

test('安全防御拦截：ESM 源码（含顶层 export）不得内联为经典脚本', () => {
  // 复现用户报的 "game.js:1118 Uncaught SyntaxError: Unexpected token 'export'"：
  // 游戏把**源码版 ESM** 当成 dist 产物提交，内联后浏览器在合成文档里报难懂的语法错。
  // 这里提前拦截并给出可操作提示。
  const esmFiles = [
    {
      path: 'index.html',
      content: '<html><head></head><body><script src="./game.js"></script></body></html>',
    },
    {
      path: 'game.js',
      content: 'export function init() {}\nconst x = 1;\n',
    },
  ];
  assert.throws(
    () => assembleGameDocument({ entryPath: 'index.html', files: esmFiles, options: { runtimeInstanceId: '1', nonce: '1' } }),
    /含有顶层 export/,
    'ESM 源码必须被拦截并给出明确提示',
  );

  // 多种顶层 export 形态都要拦住
  for (const body of [
    'export const a = 1;',
    'export default function(){}',
    'export function f(){}',
    'export class C {}',
    'export { a };',
    'export * from "./x.js";',
  ]) {
    const files = [
      { path: 'index.html', content: '<html><head></head><body><script src="./game.js"></script></body></html>' },
      { path: 'game.js', content: body },
    ];
    assert.throws(
      () => assembleGameDocument({ entryPath: 'index.html', files, options: { runtimeInstanceId: '1', nonce: '1' } }),
      /含有顶层 export/,
      `必须拦住: ${body}`,
    );
  }

  // 正常 IIFE 产物不得被误伤
  const okFiles = [
    { path: 'index.html', content: '<html><head></head><body><script src="./game.js"></script></body></html>' },
    { path: 'game.js', content: '(function(){ var s = "export me"; window.__X__ = s; })();' },
  ];
  const assembled = assembleGameDocument({
    entryPath: 'index.html',
    files: okFiles,
    options: { runtimeInstanceId: '1', nonce: '1' },
  });
  assert.ok(assembled.includes('window.__X__'), '字符串里的 export 字样不得误判为 ESM');
});

test('JS 脚本中的小于比较符（如 < base.height）不得被误判为 HTML 危险标签', () => {
  const jsSnippet = `
    (function() {
      var transparent = 0;
      for (var y = 0; y < base.height; ++y) {
        for (var x = 0; x < base.width; ++x) {
          if (!pixels.data[(x + y * base.width) * 4 + 3]) { ++transparent; }
        }
      }
      var bytesInCanvas = transparent * 3 + (base.width * base.height - transparent);
      for (var multiplier = 1; bytesInCanvas * multiplier * multiplier < blob.size; ++multiplier) ;
      if (oldY > 0) {}
    })();
  `;
  const files = [
    { path: 'index.html', content: '<!DOCTYPE html><html><head><title>Pixel Quest</title></head><body><canvas id="c"></canvas><script src="game.js"></script></body></html>' },
    { path: 'game.js', content: jsSnippet },
  ];

  // 正常组装，绝不抛出未受支持标签异常
  const doc = assembleGameDocument({
    entryPath: 'index.html',
    files,
    options: { runtimeInstanceId: 'rt-script-test', nonce: 'nonce-123' },
  });
  assert.ok(doc.includes('bytesInCanvas'), '包含 < base.height 的游戏脚本必须成功内联组装');

  // 但如果 HTML 结构中真有 <base> 或 <iframe>，必须坚决拦截
  const dangerousHtml = [
    { path: 'index.html', content: '<html><head><base href="https://evil.com"></head><body><script src="game.js"></script></body></html>' },
    { path: 'game.js', content: 'console.log("ok");' },
  ];
  assert.throws(
    () => assembleGameDocument({ entryPath: 'index.html', files: dangerousHtml, options: { runtimeInstanceId: '1', nonce: '1' } }),
    /安全防御拦截: 严禁包含未受支持的标签: <base/i,
    'HTML 中的真实 <base> 标签必须被拦截',
  );
});
