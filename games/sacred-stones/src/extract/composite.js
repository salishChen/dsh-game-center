/**
 * 叠层混合的判定规则。
 *
 * 规则是**逐像素**的，不是列表级的——这是本项目里最容易写错的一处：
 *
 *   混合发生的充要条件（在该像素上）：
 *     ① 第一目标侧有不透明像素（选中的层里，该像素不是索引 0）
 *     ② 第二目标侧有不透明像素（下方某一层属于第二目标且该像素不透明；
 *        或者 BLDCNT 的 BD 位让"背景色"参与）
 *   任一条不满足 ⇒ 该像素**完全不混合**，第一目标原样显示。
 *
 * 反例（真实遇到过的）：BLDCNT = 0x0c42 的第二目标是 `BG2|BG3`（列表非空），
 * 但在 1,049 个像素上这两层都透明 ⇒ 若按"列表非空就混"实现，这 1,049 个像素会被多混。
 * 列表非空不等于"这个像素有第二目标"。
 */
export function shouldBlend({topIsFirst, belowExists, belowIsSecond, backdropInSecond}) {
  if (!topIsFirst) return false;
  if (belowExists && belowIsSecond) return true;
  return Boolean(backdropInSecond);
}

/** 该像素下方应当作为混合对象的颜色：有层就用层，没有就用背景色。 */
export function belowColorFor({below, backdrop}) {
  return below ? [below[0], below[1], below[2]] : [backdrop[0], backdrop[1], backdrop[2]];
}
