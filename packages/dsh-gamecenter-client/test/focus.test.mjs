/**
 * 弹层焦点与 Escape 约定的单元测试（node --test）。
 *
 * 用一个最小 DOM 替身验证**真实逻辑**（src/ui/focus.js），不是对文案做断言：
 * - Escape 只作用于最上层；
 * - 输入法组字中的 Escape 不关闭；
 * - 关闭后焦点回到打开前元素；该元素已消失时退回触发元素。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureFocusReturn, isFocusable, openLayerCount, pushEscapeLayer } from '../src/ui/focus.js';

/**
 * 最小 DOM 替身：只实现焦点逻辑用到的接口。
 * @param {string} name
 */
function fakeElement(name) {
  return {
    name,
    isConnected: true,
    disabled: false,
    hidden: false,
    focused: false,
    focus() {
      this.focused = true;
      doc.activeElement = this;
    },
  };
}

const doc = {
  activeElement: /** @type {any} */ (null),
  /** @type {EventListener[]} */
  listeners: [],
  /**
   * @param {string} type
   * @param {EventListener} fn
   */
  addEventListener(type, fn) {
    if (type === 'keydown') this.listeners.push(fn);
  },
  /**
   * @param {string} type
   * @param {EventListener} fn
   */
  removeEventListener(type, fn) {
    if (type !== 'keydown') return;
    const i = this.listeners.indexOf(fn);
    if (i !== -1) this.listeners.splice(i, 1);
  },
  /** @param {Partial<KeyboardEvent>} init */
  dispatchEscape(init = {}) {
    const event = {
      key: 'Escape',
      isComposing: false,
      keyCode: 27,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...init,
    };
    for (const fn of [...this.listeners]) fn(/** @type {any} */ (event));
    return event;
  },
};

globalThis.document = /** @type {any} */ (doc);

test('Escape 只关闭最上层弹层，且 preventDefault 避免连动全局快捷键', () => {
  const closed = [];
  const pop1 = pushEscapeLayer(() => closed.push('bottom'));
  const pop2 = pushEscapeLayer(() => closed.push('top'));
  assert.equal(openLayerCount(), 2);

  const event = doc.dispatchEscape();
  assert.deepEqual(closed, ['top'], '只有栈顶应被触发');
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);

  pop2();
  assert.equal(openLayerCount(), 1);
  doc.dispatchEscape();
  assert.deepEqual(closed, ['top', 'bottom']);
  pop1();
  assert.equal(openLayerCount(), 0);
  assert.equal(doc.listeners.length, 0, '最后一个弹层关闭后必须移除全局监听');
});

test('出栈函数幂等，重复调用不会破坏层栈', () => {
  const pop = pushEscapeLayer(() => {});
  pop();
  pop();
  assert.equal(openLayerCount(), 0);
});

test('输入法组字中的 Escape 不关闭弹层', () => {
  let closed = 0;
  const pop = pushEscapeLayer(() => {
    closed += 1;
  });
  doc.dispatchEscape({ isComposing: true });
  assert.equal(closed, 0, '组字中不得关闭');
  doc.dispatchEscape({ keyCode: 229 });
  assert.equal(closed, 0, 'keyCode 229 也不得关闭');
  doc.dispatchEscape({ key: 'a' });
  assert.equal(closed, 0, '非 Escape 不触发');
  doc.dispatchEscape();
  assert.equal(closed, 1);
  pop();
});

test('关闭后焦点回到打开前的元素', () => {
  const trigger = fakeElement('trigger');
  const dialog = fakeElement('dialog');
  trigger.focus();
  const restore = captureFocusReturn(dialog);
  dialog.focus();
  assert.equal(doc.activeElement, dialog);
  restore();
  assert.equal(doc.activeElement, trigger, '必须回到触发元素');
});

test('原元素已从文档移除时，退回可聚焦的兜底元素而不是把焦点丢给 body', () => {
  const removed = fakeElement('removed');
  const fallback = fakeElement('fallback');
  removed.focus();
  const restore = captureFocusReturn(fallback);
  removed.isConnected = false;
  restore();
  assert.equal(doc.activeElement, fallback);
});

test('原元素与兜底都不可聚焦时不强行 focus', () => {
  const removed = fakeElement('removed');
  const disabledFallback = fakeElement('disabled');
  removed.focus();
  const restore = captureFocusReturn(disabledFallback);
  removed.isConnected = false;
  disabledFallback.disabled = true;
  restore();
  assert.equal(doc.activeElement, removed, '没有可聚焦目标时保持原状');
});

test('isFocusable 拒绝 null / 非元素 / 已移除 / disabled / hidden', () => {
  assert.equal(isFocusable(null), false);
  assert.equal(isFocusable(undefined), false);
  assert.equal(isFocusable({}), false);
  assert.equal(isFocusable(fakeElement('ok')), true);
  assert.equal(isFocusable({ isConnected: false, focus() {} }), false);
  assert.equal(isFocusable({ focus() {}, disabled: true }), false);
  assert.equal(isFocusable({ focus() {}, hidden: true }), false);
});
