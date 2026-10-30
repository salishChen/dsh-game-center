/**
 * 受支持卡带的唯一来源。
 *
 * 纪律（契约 §8.1）：64 位十六进制串只允许在这个文件里出现字面量。
 * 代码、测试、文档、群消息一律引用常量名或从这里 import —— 靠人眼转录六十四位
 * 十六进制必然出错（本项目已经错过一次：`21c24f84` 被写成 `21c4f841`）。
 *
 * 口径：这是**当前唯一受支持的卡带版本**，不是"唯一正确哈希"。
 * 别的地区/版本/未打补丁的干净 dump 都会被判不符，这是有意的——提取器按固定偏移读，
 * 版本不同会解出错位的素材，而且不报错、只出一屏乱码。
 */

/** 受支持卡带的 sha256（小写十六进制，不带 `sha256:` 前缀）。 */
export const SUPPORTED_CART_SHA256 = [
  '167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0',
];

/** 受支持卡带的完整事实表。key 带 `sha256:` 前缀，便于与 `digestOf` 的输出直接比对。 */
export const SUPPORTED_ROM_CARTS = Object.freeze({
  'sha256:167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0': Object.freeze({
    cartSha256: '167ed57921c24f841108f46eabc33cb10e10f141b09d0fa6e75b5c5add3e4df0',
    region: '中文化',
    size: 16777216,
    title: 'FIREEMBLEM8',
    gameCode: 'BE8J',
    makerCode: '01',
    saveType: 'SRAM',
    saveBytes: 32768,
  }),
});

/** 报错文案：让玩家看懂"不是你的卡带坏了，是这个版本我们没适配"。 */
export const UNSUPPORTED_CART_MESSAGE = '这盘卡带不在受支持版本内，解出来的图/字会错位。请使用受支持版本的卡带文件。';

/** 判断一个 sha256（带或不带 `sha256:` 前缀都可以）是否受支持。 */
export function isSupportedCart(hash) {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  const bare = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return SUPPORTED_CART_SHA256.includes(bare.toLowerCase());
}

/** 取受支持卡带的事实；不受支持返回 null。 */
export function cartFacts(hash) {
  if (!isSupportedCart(hash)) return null;
  const bare = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return SUPPORTED_ROM_CARTS[`sha256:${bare.toLowerCase()}`] ?? null;
}
