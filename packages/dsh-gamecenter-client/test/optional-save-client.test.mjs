/**
 * 存档可选（2026-10-21）客户端口径守卫。
 *
 * 只断言三件容易回退的事实：
 * 1. 能力判定只认协议 `hasSaveCapability`，客户端不自己读 `manifest.save`；
 * 2. 无存档游戏启动时不发 `saveLatest`；
 * 3. 无存档关闭的顺序不可颠倒——撤销租约确认 → 释放端口 → 销毁容器，
 *    且**不得**进入 `requestPause` 保存确认链。
 *
 * 这是源码级守卫，不能替代真实浏览器/实机验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const overlaySrc = readFileSync(path.join(here, '../src/ui/GameCenterOverlay.js'), 'utf8');

test('存档能力只认协议实现，客户端不自行读 manifest.save', () => {
  assert.match(overlaySrc, /from '@dsh-gamecenter\/protocol'/, '必须从协议导入能力函数');
  assert.match(overlaySrc, /hasSaveCapability\(/, '必须调用 hasSaveCapability');
  // 注释里提到 `manifest.save?.x` 是说明"禁止这样写"，只断言真实代码使用。
  const codeLines = overlaySrc
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
  const offenders = codeLines.filter((line) => /manifest\s*\.?\s*save\s*[?.]/.test(line));
  assert.deepEqual(offenders, [], '客户端不得再写一份 manifest.save 判定');
});

test('无存档游戏启动时不调用 saveLatest', () => {
  assert.match(
    overlaySrc,
    /isResume && supportsSave && supportsResume && typeof service\.saveLatest === 'function'/,
    'saveLatest 必须被 supportsSave 门控',
  );
  assert.match(overlaySrc, /该游戏不支持存档，本次为全新对局/, '无存档要如实告知，不冒充"没找到存档"');
});

test('无存档关闭：撤销确认 → 释放端口 → 销毁容器，且不进保存确认链', () => {
  const start = overlaySrc.indexOf('supportsSave === false');
  assert.ok(start > 0, '必须存在无存档关闭分支');
  const end = overlaySrc.indexOf('对局已结束（该游戏不支持存档', start);
  assert.ok(end > start, '无存档关闭应给出明确结束文案');
  const block = overlaySrc.slice(start, end);

  const revoke = block.indexOf('revokeLeaseConfirmed(runningSession)');
  const dispose = block.indexOf('dispatcher.dispose()');
  const destroy = block.indexOf('sessionController.abandon()');

  assert.ok(revoke >= 0, '必须先向 Host 撤销租约');
  assert.ok(dispose > revoke, '释放端口必须在撤销之后（否则撤销没有调用通道）');
  assert.ok(destroy > dispose, '销毁容器必须在释放端口之后');
  assert.equal(block.includes('requestPause'), false, '无存档路径不得进入保存确认链');
  assert.equal(block.includes('saveAck'), false, '无存档路径不得等 saveAck');
});

test('有存档游戏路径保持原样：仍走 finalize / requestPause', () => {
  const pageIdx = overlaySrc.indexOf('if (isPage && sessionController !== null) {');
  assert.ok(pageIdx > 0);
  const tail = overlaySrc.slice(pageIdx, pageIdx + 2400);
  assert.ok(tail.includes('sessionController.finalize(reason)'), '页面模式有存档仍走 finalize');
  assert.ok(tail.includes('const paused = requestPause(reason)'), '弹层模式有存档仍走 requestPause');
});
