/**
 * 把浏览器半打成 **DSH 同形单文件 bundle**。
 *
 * 目标形态来自实装产物（如 `@deepseek-ai/dsh-client-ui-schedule/lib/client.js`）：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       ...
 *       let react = require("react");
 *       ...
 *       exports.apply = apply;
 *       exports.inject = inject;
 *       return module.exports;
 *     }
 *   });
 *
 * 两条硬约束：
 * 1. **外部依赖必须留在 `require()` 里**，由 DSH 静态外部表提供；一旦被打进去，
 *    会和宿主 React / Cordis 各持一份实例，hooks 直接崩。
 * 2. 单文件 IIFE，不能有顶层 import/export（模块系统按 factory 取 exports）。
 *
 * 用法：node tools/build-bundle.mjs
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** DSH 浏览器静态外部表里的名字（web-frontend index 包 `SZ()` 实读结果）。 */
export const STATIC_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

const targetDir = process.argv[2] || 'dist';
const outdir = path.isAbsolute(targetDir) ? targetDir : path.join(root, targetDir);
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'src/index.js')],
  bundle: true,
  format: 'iife',
  globalName: '__dshGameCenterClient__',
  platform: 'browser',
  target: ['chrome120'],
  external: STATIC_EXTERNALS,
  write: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  // 浏览器半用的是 JSDoc 类型，esbuild 不做类型检查（由 tsc 负责）。
  loader: { '.js': 'js', '.webp': 'dataurl' },
});

const body = result.outputFiles[0].text;

/**
 * 把 IIFE 产物包成模块系统的 factory 壳。
 * `require` 在 factory 内部才是合法名字，所以 IIFE 里的 `require("react")`
 * 会解析到模块系统传入的那个函数。
 * @param {string} id
 * @param {string} code
 * @returns {string}
 */
function wrapFactory(id, code) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\t${code.trim().split('\n').join('\n\t\t')}
\t\texports.apply = __dshGameCenterClient__.apply;
\t\texports.inject = __dshGameCenterClient__.inject;
\t\treturn module.exports;
\t}
});
`;
}

const out = wrapFactory(pkg.name, body);
const outFile = path.join(outdir, 'client.js');
writeFileSync(outFile, out, 'utf8');

console.log(`built ${path.relative(root, outFile)} (${out.length} chars)`);
