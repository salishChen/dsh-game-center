/**
 * 独立候选构建脚本：将当前源码构建至 `staging/client.js`，绝不污染或覆盖链接正在服务的 `dist/client.js`。
 *
 * 用法：node tools/build-candidate.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// 调用 build-bundle.mjs 传入 'staging' 目录
execFileSync(process.execPath, [path.join(here, 'build-bundle.mjs'), 'staging'], {
  cwd: root,
  stdio: 'inherit',
});

const stagingFile = path.join(root, 'staging', 'client.js');
if (!existsSync(stagingFile)) {
  console.error(`[build-candidate] 错误: 未找到生成的产物 ${stagingFile}`);
  process.exit(1);
}

const content = readFileSync(stagingFile);
const hash = createHash('sha256').update(content).digest('hex').toUpperCase();

console.log('--------------------------------------------------');
console.log(`[build-candidate] 独立 staging 候选产物生成完毕:`);
console.log(`  路径: packages/dsh-gamecenter-client/staging/client.js`);
console.log(`  大小: ${content.length} 字节`);
console.log(`  SHA256: ${hash}`);
console.log('--------------------------------------------------');
