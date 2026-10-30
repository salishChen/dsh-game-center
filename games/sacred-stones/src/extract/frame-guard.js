/**
 * 帧号守卫：把"当心 lag-1"变成一处会让它红的机械判定。
 *
 * 背景：同一天里 lag-1 踩了三次（帧 900 整屏差 7,456 px、帧 3200 差 1,105 px、盲区 1,250）。
 * 三次都不是不细心，而是**流程里没有任何一处会因为帧号不对而失败**。
 * 而错帧产出的数字往往完全合理：1,250 不比 931 更可疑，它甚至自洽地解释了多出来的 319。
 * 唯一能抓住它的东西就是"这帧编号不对"。
 *
 * 规则（三条，都改成了机械检查）：
 *   1. 任何测量输出必须带 frameNo；
 *   2. 脚本对期望帧号做断言，不一致就拒绝输出（抛 FrameMismatchError，不写结果文件）；
 *   3. 复现别人的结果时先 diff frameNo，不一致直接拒，不许进入像素比较。
 */

export class FrameMismatchError extends Error {
  constructor({expected, actual, context}) {
    super(
      `帧号不符：期望第 ${expected} 帧，实际第 ${actual} 帧${context ? `（${context}）` : ''}。` +
        '拒绝输出结果：跨帧比较得到的差异看起来和真实差异一模一样。' +
        '常见原因是"取快照前多跑/少跑了一帧"（lag-1）。',
    );
    this.name = 'FrameMismatchError';
    this.code = 'FRAME_MISMATCH';
    this.expected = expected;
    this.actual = actual;
    this.context = context;
  }
}

/** 帧号断言：不对就抛，绝不"带着警告继续算"。 */
export function assertFrameNo(actual, expected, context) {
  if (!Number.isInteger(actual)) throw new TypeError(`帧号必须是整数，收到 ${actual}`);
  if (!Number.isInteger(expected)) throw new TypeError(`期望帧号必须是整数，收到 ${expected}`);
  if (actual !== expected) throw new FrameMismatchError({expected, actual, context});
  return actual;
}

/** 写进任何产物 JSON 的帧标记：帧号是这些数字的一部分，丢了以后没法判断结论还成不成立。 */
export function frameStamp(frameNo, extra = {}) {
  return {frameNo, ...extra};
}

/**
 * 从命令行取期望帧号。`--expect-frame N` 优先，否则用 fallback（通常就是本次要跑到的帧）。
 * 用于"复现别人的结果"：把当时的帧号写死在命令里，脚本就会替你拒绝跨帧比较。
 */
export function expectedFrameFromArgv(argv, fallback) {
  const at = argv.indexOf('--expect-frame');
  if (at === -1) return fallback;
  const value = Number(argv[at + 1]);
  if (!Number.isInteger(value)) throw new TypeError(`--expect-frame 需要一个整数，收到 ${argv[at + 1]}`);
  return value;
}
