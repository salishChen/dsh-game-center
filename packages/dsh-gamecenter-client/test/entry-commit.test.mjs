// @ts-check
/**
 * 「操作哪个提交」判定测试。
 *
 * 【缺陷背景 · 2026-10-27】用户反馈：卸载后界面回到卸载前的样子、按钮还是「开始游戏」、
 * 没有安装入口，且无法重新安装。根因是客户端拿 `entry.commit`（目录里的最新发布版）
 * 去卸载/启动，而磁盘上真正装的是 `installedCommit`：
 *  - 卸载删的是不存在的路径，`fs.rm({force:true})` 照样返回成功 → 假成功；
 *  - 启动/握手按错提交取产物 → 必然报「未找到已安装版本」。
 *
 * 运行：node --test test/entry-commit.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 加载 entry-commit 纯函数模块（与 catalog-visibility.test.mjs 同款 VM 沙箱）。 */
function loadModule() {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/entry-commit.js'), 'utf8');
  const cjs = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/@type\s*\{[^}]*\}/g, '')
    .replace(/@param\s*\{[^}]*\}/g, '')
    .replace(/@returns?\s*\{[^}]*\}/g, '')
    .replace(/@typedef[\s\S]*?\n\s*\*\//g, '')
    .replace(/export function (\w+)/g, (_m, name) => `const ${name} = function ${name}`);
  const names = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]);
  const sandbox = { exports: {} };
  sandbox.module = { exports: sandbox.exports };
  vm.runInNewContext(cjs + `\n;${names.map((n) => `exports.${n} = ${n};`).join('\n')}`, sandbox);
  return sandbox.exports;
}

const OLD_COMMIT = 'a'.repeat(40);
const NEW_COMMIT = 'b'.repeat(40);

test('已安装且 installedCommit 可用：一律以磁盘上那份为准（卸载/启动都打它）', () => {
  const { resolveEntryCommit } = loadModule();
  const entry = { commit: NEW_COMMIT, installed: true, installedCommit: OLD_COMMIT };
  assert.equal(resolveEntryCommit(entry), OLD_COMMIT, '已装旧版时必须操作旧版提交，不能操作目录最新版');
});

test('未安装：回落到目录 commit（安装要用最新发布版）', () => {
  const { resolveEntryCommit } = loadModule();
  assert.equal(resolveEntryCommit({ commit: NEW_COMMIT, installed: false, installedCommit: null }), NEW_COMMIT);
});

test('已安装但 installedCommit 缺失/空串：回落到目录 commit，绝不落空字符串', () => {
  const { resolveEntryCommit } = loadModule();
  assert.equal(resolveEntryCommit({ commit: NEW_COMMIT, installed: true, installedCommit: null }), NEW_COMMIT);
  assert.equal(resolveEntryCommit({ commit: NEW_COMMIT, installed: true, installedCommit: '' }), NEW_COMMIT);
  assert.equal(resolveEntryCommit({ commit: NEW_COMMIT, installed: true }), NEW_COMMIT);
});

test('未安装时即使带着 installedCommit 也不采信（磁盘无该安装，不能拿它去启动）', () => {
  const { resolveEntryCommit } = loadModule();
  const entry = { commit: NEW_COMMIT, installed: false, installedCommit: OLD_COMMIT };
  assert.equal(resolveEntryCommit(entry), NEW_COMMIT);
});

test('条目缺失/畸形：返回空串，由调用方报错，不抛异常', () => {
  const { resolveEntryCommit } = loadModule();
  assert.equal(resolveEntryCommit(null), '');
  assert.equal(resolveEntryCommit(undefined), '');
  assert.equal(resolveEntryCommit({}), '');
});
