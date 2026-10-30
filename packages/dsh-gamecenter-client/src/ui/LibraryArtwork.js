// @ts-check
// @ts-expect-error supplied by DSH
import {createElement as h, useState} from 'react';
import {DEFAULT_COVERS, defaultCoverFor} from './default-covers.js';

/** Original, bundled vector illustrations with bundled covers & graceful offline fallback.
 * @param {{gameId:string, className?:string, coverUrl?:string, alt?:string}} props */
export function LibraryArtwork({gameId, className='', coverUrl, alt=''}) {
  // 记"哪一张图加载失败"而不是布尔开关：同一实例换 gameId 复用时，上一张的失败
  // 不会把新封面一起压掉。
  const [failedUrl, setFailedUrl] = useState(/** @type {string|null} */ (null));
  // 目录封面优先；目录没给封面时用随包内置封面（零外链，离线可用）。
  const bundled = DEFAULT_COVERS[gameId] || defaultCoverFor(gameId) || '';
  // 以 `/` 开头的相对地址说明没被解析成绝对地址（后台封面就是这个形态）：此时宁可用
  // 内置封面，也不要渲染一个必然 404 的破图框。绝对 URL 与内置封面名照旧。
  const src = (typeof coverUrl === 'string' && coverUrl !== '' && !coverUrl.startsWith('/')) ? coverUrl : bundled;

  if (src && src !== failedUrl) {
    return h('div', {className: `gc-art gc-art-cover-wrap ${className}`},
      h('img', {
        src,
        alt: alt || gameId,
        className: 'gc-cover-image',
        onError: () => setFailedUrl(src),
      })
    );
  }

const kind = gameId.includes('cat-arena')
    ? 'arena'
    : gameId.includes('landlord')
    ? 'cards'
    : gameId.includes('minesweep')
    ? 'mines'
    : gameId.includes('crazy-flasher') || gameId.includes('flasher')
    ? 'flasher'
    : 'other';

  const ring = (/** @type {number} */ x) =>
    h('g', {key: x},
      h('circle', {cx: x, cy: 262, r: 43, fill: '#101a25', stroke: '#667e91', strokeWidth: 9}),
      h('circle', {cx: x, cy: 262, r: 24, fill: '#26394a', stroke: '#0c1420', strokeWidth: 8}),
      h('circle', {cx: x, cy: 262, r: 7, fill: '#a7bed0'})
    );

  return h('div', {className: `gc-art gc-art-${kind} ${className}`, 'aria-hidden': 'true'},
    h('div', {className: 'gc-art-orbit'}),
    h('svg', {viewBox: '0 0 520 340', fill: 'none', className: 'gc-art-vector'},
      kind === 'arena' ? h('g', {},
        h('path', {d: 'M42 298H488M82 312H445', stroke: '#739aaa', strokeOpacity: .22, strokeWidth: 2}),
        h('path', {d: 'M123 205L181 145H285L350 180L390 236H109Z', fill: '#e7a14c', stroke: '#172737', strokeWidth: 9, strokeLinejoin: 'round'}),
        h('path', {d: 'M181 145H244L224 192H139Z', fill: '#f6c875'}),
        h('path', {d: 'M247 150L288 153L334 180L274 190Z', fill: '#213e52', stroke: '#172737', strokeWidth: 6}),
        h('path', {d: 'M112 215H373L388 240H109Z', fill: '#aa632f'}),
        h('path', {d: 'M209 207L196 235M236 207L223 235M263 207L250 235', stroke: '#172737', strokeWidth: 12}),
        h('path', {d: 'M289 134L367 114L373 138L299 161Z', fill: '#93b5c3', stroke: '#172737', strokeWidth: 8}),
        h('path', {d: 'M359 110L383 105L394 140L369 147Z', fill: '#425b6c', stroke: '#172737', strokeWidth: 7}),
        h('path', {d: 'M154 169L134 127L108 137L128 190', fill: '#547c8c', stroke: '#172737', strokeWidth: 7}),
        h('path', {d: 'M107 141L67 129L72 148L45 151L76 169L61 186L117 170', fill: '#ffbc6b'}),
        h('path', {d: 'M388 215L432 194L421 224L451 229L420 242L438 262L389 253Z', fill: '#a5bfca', stroke: '#172737', strokeWidth: 7}),
        ring(169), ring(330),
        h('path', {d: 'M219 124V104L240 92L261 104V124L240 135Z', fill: '#79c6d9', stroke: '#172737', strokeWidth: 5}),
        h('path', {d: 'M233 113H247M240 106V120', stroke: '#e2faff', strokeWidth: 4, strokeLinecap: 'round'}),
        h('path', {d: 'M417 104L434 87M446 130L465 128M406 80L409 64', stroke: '#e8c98e', strokeWidth: 4, strokeLinecap: 'round'})
      ) :
      kind === 'cards' ? h('g', {strokeWidth: 3},
        h('g', {transform: 'rotate(-19 210 180)'},
          h('rect', {x: 109, y: 75, width: 147, height: 205, rx: 12, fill: '#a8c3d0', stroke: '#293c60'}),
          h('text', {x: 128, y: 118, fill: '#213e61', fontSize: 30, fontFamily: 'Georgia'}, 'K'),
          h('path', {d: 'M183 138L215 180L183 222L151 180Z', fill: '#315b7c'})
        ),
        h('g', {transform: 'rotate(12 320 180)'},
          h('rect', {x: 237, y: 57, width: 147, height: 205, rx: 12, fill: '#e2e5dc', stroke: '#293c60'}),
          h('text', {x: 256, y: 100, fill: '#b24b58', fontSize: 30, fontFamily: 'Georgia'}, 'A'),
          h('path', {d: 'M312 150C280 116 252 161 312 201C372 161 344 116 312 150Z', fill: '#bf5261'})
        ),
        h('path', {d: 'M171 290H391', stroke: '#b9a5d5', strokeOpacity: .3}),
        h('circle', {cx: 401, cy: 99, r: 6, fill: '#c2a9db'})
      ) :
      kind === 'mines' ? h('g', {transform: 'translate(134 49) rotate(8 120 120)'},
        ...Array.from({length: 16}, (_, i) =>
          h('rect', {
            key: i,
            x: (i % 4) * 58,
            y: Math.floor(i / 4) * 58,
            width: 52,
            height: 52,
            rx: 6,
            fill: [0, 5, 10].includes(i) ? '#41727a' : '#2b5365',
            stroke: '#7cbbc1',
            strokeOpacity: .3,
            strokeWidth: 2
          })
        ),
        h('path', {d: 'M85 123V93L109 100L85 110', fill: '#e5a77a', stroke: '#e5a77a', strokeWidth: 3}),
        h('text', {x: 21, y: 38, fill: '#c2e1d3', fontSize: 28, fontFamily: 'monospace'}, '1'),
        h('text', {x: 195, y: 154, fill: '#c2e1d3', fontSize: 28, fontFamily: 'monospace'}, '2'),
        h('circle', {cx: 145, cy: 203, r: 13, fill: '#112e3e', stroke: '#c1dbcf', strokeWidth: 3}),
        h('path', {d: 'M145 181V225M123 203H167M129 187L161 219M129 219L161 187', stroke: '#c1dbcf', strokeWidth: 3})
      ) :
      kind === 'flasher' ? h('g', {},
        // 场景与地面战术网格
        h('path', {d: 'M40 300H480M70 314H450', stroke: '#ef4444', strokeOpacity: .25, strokeWidth: 2}),
        h('path', {d: 'M30 80L160 30M380 40L490 90M20 220L120 180', stroke: '#dc2626', strokeOpacity: .35, strokeWidth: 2, strokeDasharray: '6 4'}),
        // 战术准星与雷达刻度 (徽章外环)
        h('circle', {cx: 260, cy: 150, r: 110, fill: 'none', stroke: '#ef4444', strokeOpacity: .18, strokeWidth: 1.5, strokeDasharray: '8 6'}),
        h('circle', {cx: 260, cy: 150, r: 75, fill: 'none', stroke: '#ef4444', strokeOpacity: .25, strokeWidth: 2}),
        h('path', {d: 'M260 30V80M260 220V270M140 150H190M330 150H380', stroke: '#ef4444', strokeOpacity: .4, strokeWidth: 2}),
        // 四角战术方括号
        h('path', {d: 'M170 80H150V100M350 80H370V100M150 200V220H170M370 200V220H350', stroke: '#f87171', strokeWidth: 3, fill: 'none'}),

        // 战术飞翼骷髅盾徽 (徽章)
        h('path', {d: 'M260 48L288 62V92C288 114 260 128 260 128C260 128 232 114 232 92V62L260 48Z', fill: '#2a0d0d', stroke: '#dc2626', strokeWidth: 3}),
        h('path', {d: 'M248 76A12 12 0 0 1 272 76C272 86 268 94 260 98C252 94 248 86 248 76Z', fill: '#fca5a5'}),
        h('circle', {cx: 255, cy: 77, r: 2.5, fill: '#2a0d0d'}),
        h('circle', {cx: 265, cy: 77, r: 2.5, fill: '#2a0d0d'}),
        h('path', {d: 'M256 86H264M257 89H263', stroke: '#2a0d0d', strokeWidth: 1.5}),
        h('path', {d: 'M230 65L200 55L210 75L190 70L205 90L230 85', fill: 'none', stroke: '#ef4444', strokeWidth: 2.5, strokeLinejoin: 'round'}),
        h('path', {d: 'M290 65L320 55L310 75L330 70L315 90L290 85', fill: 'none', stroke: '#ef4444', strokeWidth: 2.5, strokeLinejoin: 'round'}),

        // 武器装备：左右双持冲锋枪与重型手枪 (武器)
        h('path', {d: 'M145 155L90 135L85 148L110 156L102 182L116 186L126 162L148 170Z', fill: '#1f2937', stroke: '#f87171', strokeWidth: 2.5}),
        h('rect', {x: 72, y: 136, width: 16, height: 6, transform: 'rotate(20 80 139)', fill: '#4b5563'}),
        h('path', {d: 'M340 162L415 132L419 146L395 156L403 186L389 190L382 163L345 177Z', fill: '#1f2937', stroke: '#f87171', strokeWidth: 2.5}),
        h('rect', {x: 412, y: 128, width: 18, height: 7, transform: 'rotate(-22 421 131)', fill: '#4b5563'}),

        // 枪火爆炸、弹壳与火花特效 (特效)
        h('polygon', {points: '82,130 60,118 76,136 50,140 76,146 62,160 86,148', fill: '#fef08a'}),
        h('polygon', {points: '80,132 68,124 76,136 62,139 76,143 70,150 82,143', fill: '#ffffff'}),
        h('polygon', {points: '422,126 448,110 430,132 460,134 432,142 450,158 424,142', fill: '#fef08a'}),
        h('polygon', {points: '424,128 438,118 430,132 445,134 431,140 440,148 426,139', fill: '#ffffff'}),
        h('rect', {x: 120, y: 122, width: 10, height: 5, rx: 1.5, transform: 'rotate(-45 125 124)', fill: '#fbbf24', stroke: '#d97706', strokeWidth: 1}),
        h('rect', {x: 360, y: 115, width: 10, height: 5, rx: 1.5, transform: 'rotate(35 365 117)', fill: '#fbbf24', stroke: '#d97706', strokeWidth: 1}),
        h('circle', {cx: 55, cy: 110, r: 2.5, fill: '#f97316'}),
        h('circle', {cx: 42, cy: 145, r: 2, fill: '#ef4444'}),
        h('circle', {cx: 465, cy: 118, r: 2.5, fill: '#f97316'}),
        h('circle', {cx: 445, cy: 168, r: 2, fill: '#ef4444'}),
        h('circle', {cx: 180, cy: 120, r: 1.5, fill: '#fbbf24'}),
        h('circle', {cx: 310, cy: 110, r: 1.5, fill: '#fbbf24'}),

        // 人物形象：Andy Law 经典黑风衣、金发碎发与红光墨镜 (人物)
        h('path', {d: 'M205 175L150 255L190 250L220 205Z', fill: '#180c0c', stroke: '#991b1b', strokeWidth: 2.5}),
        h('path', {d: 'M285 175L345 255L305 250L275 205Z', fill: '#180c0c', stroke: '#991b1b', strokeWidth: 2.5}),
        h('path', {d: 'M220 148L240 138H275L295 148L285 245H225Z', fill: '#1f1717', stroke: '#dc2626', strokeWidth: 2.5}),
        h('path', {d: 'M230 160L282 225', stroke: '#475569', strokeWidth: 6, strokeLinecap: 'round'}),
        h('circle', {cx: 242, cy: 175, r: 2.5, fill: '#fbbf24'}),
        h('circle', {cx: 256, cy: 192, r: 2.5, fill: '#fbbf24'}),
        h('circle', {cx: 270, cy: 210, r: 2.5, fill: '#fbbf24'}),
        h('path', {d: 'M246 142L246 128H266L266 142Z', fill: '#e5e7eb'}),
        h('path', {d: 'M242 128C242 108 270 108 270 128Z', fill: '#fcd34d'}),
        h('path', {d: 'M236 122L222 105L240 108L242 90L256 102L265 88L272 104L288 98L278 116L288 122L270 126Z', fill: '#fbbf24', stroke: '#d97706', strokeWidth: 2, strokeLinejoin: 'round'}),
        h('path', {d: 'M242 118H270L266 125H246Z', fill: '#111827', stroke: '#dc2626', strokeWidth: 1.5}),
        h('line', {x1: 248, y1: 121, x2: 264, y2: 121, stroke: '#f87171', strokeWidth: 1.5}),

        // 标题与游戏标识 (标识)
        h('text', {x: 260, y: 282, textAnchor: 'middle', fill: '#fee2e2', fontSize: 24, fontWeight: 900, letterSpacing: 5, fontFamily: 'Impact,Arial Black,sans-serif'}, 'CRAZY FLASHER 4'),
        h('text', {x: 260, y: 304, textAnchor: 'middle', fill: '#f87171', fontSize: 12, fontWeight: 700, letterSpacing: 6, fontFamily: 'sans-serif'}, 'BULLETS RAIN · 枪林弹雨')
      ) :
      // 默认通用手柄
      h('g', {stroke: '#94c7df', strokeWidth: 10, strokeLinecap: 'round'},
        h('path', {d: 'M174 125H345Q368 125 380 161L404 237Q411 265 385 265Q370 265 343 232H176Q150 265 134 265Q109 265 117 237L140 161Q151 125 174 125Z', fill: '#233d53'}),
        h('path', {d: 'M169 172V209M150 191H188M326 176H327M352 200H353'})
      )
    )
  );
}
