// @ts-check
/**
 * 受控媒体占位（v3）。
 *
 * 【为什么是占位而不是图片】封面/截图必须由 Host 受控拉取（校验 host 白名单、
 * mime、sha256、体积上限、像素上限），Client **不得**在 iframe 或页面里直接外链
 * 跨域图片。本轮 Host 的 `mediaFetch` 端点因安全未决保持禁用，因此这里**只渲染
 * 占位**，不发起任何媒体请求；`mediaFetch` 一旦启用，只需把占位换成受控字节即可，
 * 展示层接口不变。
 *
 * 【不冒充可用】占位会明确写出"媒体暂不可用"，不显示破图、不显示空白，
 * 避免用户误以为游戏没有配图。
 */

// @ts-expect-error 运行时由 DSH 浏览器静态外部表提供
import { createElement as h } from 'react';

/** 占位框样式。 */
const PLACEHOLDER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px dashed var(--dsw-alias-border-l3, #d0d7de)',
  borderRadius: '6px',
  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
  color: 'var(--dsw-alias-label-secondary, #57606a)',
  fontSize: '12px',
  textAlign: 'center',
  padding: '8px',
};

/**
 * @param {object} props
 * @param {any} [props.cover] 封面元数据（可为 null）
 * @param {any[]} [props.screenshots] 截图元数据数组
 * @returns {any}
 */
export function GameMediaPlaceholder(props) {
  const cover = props.cover ?? null;
  const screenshots = Array.isArray(props.screenshots) ? props.screenshots : [];

  // 目录元数据里根本没有媒体时，不显示任何占位（避免无谓噪音）。
  if (cover === null && screenshots.length === 0) return null;

  const alt = typeof cover?.alt === 'string' && cover.alt !== '' ? cover.alt : null;

  return h(
    'div',
    {
      'data-gamecenter-media-placeholder': '',
      style: { display: 'flex', flexDirection: 'column', gap: '6px' },
    },
    cover !== null &&
      h(
        'div',
        {
          'data-gamecenter-media-slot': 'cover',
          style: { ...PLACEHOLDER_STYLE, minHeight: '96px' },
        },
        alt !== null ? `封面暂不可用：${alt}` : '封面暂不可用',
      ),
    screenshots.length > 0 &&
      h(
        'div',
        {
          'data-gamecenter-media-slot': 'screenshots',
          style: PLACEHOLDER_STYLE,
        },
        `截图 ${screenshots.length} 张暂不可用（媒体受控拉取尚未启用）`,
      ),
  );
}
