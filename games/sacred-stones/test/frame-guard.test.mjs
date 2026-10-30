import test from 'node:test';
import assert from 'node:assert/strict';

import {assertFrameNo, expectedFrameFromArgv, frameStamp, FrameMismatchError} from '../src/extract/frame-guard.js';

test('帧号一致：正常返回，不打扰调用方', () => {
  assert.equal(assertFrameNo(900, 900), 900);
});

test('帧号不一致：抛 FRAME_MISMATCH，消息里同时给出期望与实际', () => {
  assert.throws(
    () => assertFrameNo(901, 900, '取快照多跑了一帧'),
    (err) => {
      assert.ok(err instanceof FrameMismatchError);
      assert.equal(err.code, 'FRAME_MISMATCH');
      assert.equal(err.expected, 900);
      assert.equal(err.actual, 901);
      assert.match(err.message, /期望第 900 帧/);
      assert.match(err.message, /实际第 901 帧/);
      assert.match(err.message, /lag-1/);
      return true;
    },
  );
});

test('帧号不是整数：直接类型错，不静默比较', () => {
  assert.throws(() => assertFrameNo(900.5, 900), TypeError);
  assert.throws(() => assertFrameNo(900, undefined), TypeError);
});

test('--expect-frame 从命令行取期望帧号，缺省用兜底值', () => {
  assert.equal(expectedFrameFromArgv(['node', 'x.mjs'], 900), 900);
  assert.equal(expectedFrameFromArgv(['node', 'x.mjs', '--expect-frame', '901'], 900), 901);
  assert.throws(() => expectedFrameFromArgv(['node', 'x.mjs', '--expect-frame', 'abc'], 900), TypeError);
});

test('frameStamp 把帧号与附加字段一起打进产物', () => {
  assert.deepEqual(frameStamp(900, {diffPixels: 0}), {frameNo: 900, diffPixels: 0});
});
