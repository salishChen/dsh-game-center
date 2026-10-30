// @ts-check
/**
 * 目录可见性规则测试（用户要求：列表中不显示审核中游戏）。
 *
 * 运行：node --test test/catalog-visibility.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 加载 catalog-visibility 纯函数模块。 */
function loadModule() {
  const src = fs.readFileSync(path.resolve(here, '../src/ui/catalog-visibility.js'), 'utf8');
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

/** 构造四种审批状态的条目 */
function makeEntries() {
  return [
    { gameId: 'a', approvalState: 'approved' },
    { gameId: 'b', approvalState: 'pending' },
    { gameId: 'c', approvalState: 'rejected' },
    { gameId: 'd', approvalState: 'unknown' },
  ];
}

test('真实来源：只显示已审批游戏（审核中/已拒绝/无记录一律不显示）', () => {
  const { selectVisibleEntries } = loadModule();
  const visible = selectVisibleEntries(makeEntries(), false);
  assert.equal(visible.length, 1, '只应显示 1 个已审批游戏');
  assert.equal(visible[0]?.gameId, 'a', '显示的必须是 approved 条目');
  for (const entry of visible) {
    assert.equal(entry.approvalState, 'approved', '可见条目的审批状态必须都是 approved');
  }
});

test('本地 fixture 模式：全部显示（本地开发/预览数据，不是真实上架）', () => {
  const { selectVisibleEntries } = loadModule();
  const visible = selectVisibleEntries(makeEntries(), true);
  assert.equal(visible.length, 4, 'fixture 模式必须全部可见');
});

test('隐藏数量如实统计，不静默隐藏', () => {
  const { countHiddenEntries } = loadModule();
  assert.equal(countHiddenEntries(makeEntries(), false), 3, '真实来源应隐藏 3 个未审批条目');
  assert.equal(countHiddenEntries(makeEntries(), true), 0, 'fixture 模式不隐藏');
  assert.equal(countHiddenEntries([], false), 0, '空列表隐藏数为 0');
});

test('异常输入不得抛错', () => {
  const { selectVisibleEntries, countHiddenEntries } = loadModule();
  // 跨 vm 上下文的数组原型不同，用 JSON 比较而不是 deepEqual
  assert.equal(JSON.stringify(selectVisibleEntries(/** @type {any} */ (null), false)), '[]', 'null 输入返回空');
  assert.equal(JSON.stringify(selectVisibleEntries(/** @type {any} */ (undefined), false)), '[]', 'undefined 输入返回空');
  assert.equal(countHiddenEntries(/** @type {any} */ (null), false), 0);
  assert.equal(countHiddenEntries(/** @type {any} */ (undefined), false), 0);
});

test('接线：目录列表用可见条目渲染，并给出隐藏数量与空态提示', () => {
  const overlaySrc = fs.readFileSync(path.resolve(here, '../src/ui/GameCenterOverlay.js'), 'utf8');
  const librarySrc = fs.readFileSync(path.resolve(here, '../src/ui/GameLibrary.js'), 'utf8');
  assert.match(overlaySrc, /entries: visibleEntries/, '列表必须用可见条目渲染');
  assert.ok(
    !/catalogEntries\.map\(\s*\/\*\* @type \{CatalogEntry\} \*\//.test(overlaySrc),
    '不得再用未过滤的 catalogEntries 渲染列表',
  );
  assert.match(librarySrc, /data-gamecenter-hidden-pending/, '必须如实告知被隐藏的数量');
  assert.match(librarySrc, /data-gamecenter-catalog-empty/, '真实来源下无已审批游戏时必须有空态');
  assert.match(overlaySrc, /selectVisibleEntries\(catalogEntries, isFixtureSource\)/, '必须使用可见性规则函数');
});
