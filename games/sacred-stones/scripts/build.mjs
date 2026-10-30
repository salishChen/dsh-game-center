/**
 * 构建：把 src/app 打成一个浏览器能跑的 dist/game.js
 *
 * 为什么必须打包而不是直接 <script type="module" src="src/app/main.js">：
 * 页面跑在游戏中心的 iframe 里，只认 dist/ 下那三个白名单文件；
 * 而内核（@gba-kit/gba-emulator）是 node_modules 里的 ESM，浏览器不能自己解析裸模块名。
 * esbuild 负责把内核 + 我们的代码合成单文件，输出格式 ESM（页面用 type="module" 引入）。
 */

import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

const root = new URL('../', import.meta.url);
const src = (name) => fileURLToPath(new URL(`src/${name}`, root));
const dist = (name) => fileURLToPath(new URL(`dist/${name}`, root));

await fs.mkdir(new URL('dist/', root), {recursive: true});

const result = await esbuild.build({
  entryPoints: [src('app/main.js')],
  outfile: dist('game.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

for (const name of ['index.html', 'style.css']) {
  await fs.copyFile(src(name), dist(name));
}

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`圣魔之光石 dist 构建完成：game.js ${(bytes / 1024).toFixed(0)} KB，打包 ${inputs} 个模块`);
console.log('产物：dist/game.js, dist/index.html, dist/style.css（ROM 不在其中）');
