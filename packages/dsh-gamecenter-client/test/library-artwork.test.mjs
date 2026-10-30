// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ARTWORK_SRC = path.resolve(root, 'src/ui/LibraryArtwork.js');
const COVERS_SRC = path.resolve(root, 'src/ui/default-covers.js');

/** Load LibraryArtwork in a controlled VM sandbox with React createElement and useState mock */
function loadArtworkModule() {
  const src = fs.readFileSync(ARTWORK_SRC, 'utf8');
  // 封面数据在兄弟模块 src/ui/default-covers.js；vm 里没有模块解析，
  // 先把它内联进同一个沙箱（共享 exports），再由下面的导入替换去取。
  const covers = fs.readFileSync(COVERS_SRC, 'utf8')
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/export const DEFAULT_COVERS\s*=/g, 'exports.DEFAULT_COVERS =')
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');
  let stateValue = null;
  const mockSetState = (val) => {
    stateValue = typeof val === 'function' ? val(stateValue) : val;
  };

  const reactMock = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (init) => {
      if (stateValue === null) {
        stateValue = typeof init === 'function' ? init() : init;
      }
      return [stateValue, mockSetState];
    },
  };

  const transformed = src
    .replace(/^\/\/ @ts-check\s*$/m, '')
    .replace(/^\/\/ @ts-expect-error[^\n]*\n/m, '')
    .replace(/import\s*\{([^}]*)\}\s*from\s*'react';?/g, (_m, names) => {
      const jsNames = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'))
        .join(', ');
      return `const {${jsNames}} = __deps.react;`;
    })
    .replace(/import\s*\{([^}]*)\}\s*from\s*'\.\/default-covers\.js';?/g, (_m, names) => {
      const jsNames = names.split(',').map((n) => n.trim()).filter(Boolean).join(', ');
      return `const {${jsNames}} = exports;`;
    })
    .replace(/export const DEFAULT_COVERS\s*=/g, 'const DEFAULT_COVERS = exports.DEFAULT_COVERS =')
    .replace(/export function (\w+)/g, 'exports.$1 = function $1');

  const sandbox = {
    __deps: { react: reactMock },
    exports: {},
    module: { exports: {} },
  };

  vm.runInNewContext(`${covers}\n${transformed}`, sandbox, { filename: 'LibraryArtwork.js' });
  return {
    DEFAULT_COVERS: sandbox.exports.DEFAULT_COVERS,
    LibraryArtwork: sandbox.exports.LibraryArtwork,
  };
}

test('DEFAULT_COVERS 包含 example.crazy-flasher4 且均为标准 data:image/jpeg;base64 URI', () => {
  const { DEFAULT_COVERS } = loadArtworkModule();
  assert.ok(DEFAULT_COVERS, 'DEFAULT_COVERS 映射必须存在');
  assert.ok(DEFAULT_COVERS['example.crazy-flasher4'], '必须包含 example.crazy-flasher4 默认封面');

  for (const [key, uri] of Object.entries(DEFAULT_COVERS)) {
    assert.ok(uri.startsWith('data:image/jpeg;base64,'), `${key} 封面必须为标准 data:image/jpeg;base64 URI`);
    const base64Part = uri.slice('data:image/jpeg;base64,'.length);
    const buf = Buffer.from(base64Part, 'base64');
    assert.ok(buf.length > 1000, `${key} 图片解码后体积异常`);
    assert.equal(buf[0], 0xff, `${key} 必须为 JPEG 格式魔数`);
    assert.equal(buf[1], 0xd8, `${key} 必须为 JPEG 格式魔数`);
    assert.equal(buf[2], 0xff, `${key} 必须为 JPEG 格式魔数`);
  }
});

test('DEFAULT_COVERS 与 games/ 对应 assets/cover.jpg 文件内容严格一致', () => {
  const { DEFAULT_COVERS } = loadArtworkModule();
  const cf4Asset = fs.readFileSync(path.resolve(root, '../../games/crazy-flasher4/assets/cover.jpg'));

  const cf4Decoded = Buffer.from(DEFAULT_COVERS['example.crazy-flasher4'].slice('data:image/jpeg;base64,'.length), 'base64');

  assert.equal(cf4Decoded.compare(cf4Asset), 0, 'crazy-flasher4 base64 必须与 assets/cover.jpg 完全一致');
});

test('LibraryArtwork 默认直接渲染 DEFAULT_COVERS 封面图片', () => {
  const { LibraryArtwork, DEFAULT_COVERS } = loadArtworkModule();

  // Test example.crazy-flasher4
  const vnodeCf4 = LibraryArtwork({ gameId: 'example.crazy-flasher4' });
  assert.equal(vnodeCf4.type, 'div');
  assert.ok(vnodeCf4.props.className.includes('gc-art-cover-wrap'));
  const imgCf4 = vnodeCf4.props.children;
  assert.equal(imgCf4.type, 'img');
  assert.equal(imgCf4.props.src, DEFAULT_COVERS['example.crazy-flasher4']);

  // 关键词兜底：id 不在 DEFAULT_COVERS 里，但命中 flasher 关键词时回落到内置封面
  // （原先这条路径由已下线的火焰纹章夹具覆盖，现用中性 id 保留同一覆盖率）
  const vnodeKeyword = LibraryArtwork({ gameId: 'example.crazy-flasher4-remaster' });
  assert.equal(vnodeKeyword.type, 'div');
  assert.ok(vnodeKeyword.props.className.includes('gc-art-cover-wrap'));
  const imgKeyword = vnodeKeyword.props.children;
  assert.equal(imgKeyword.type, 'img');
  assert.equal(imgKeyword.props.src, DEFAULT_COVERS['example.crazy-flasher4']);
});

test('LibraryArtwork 支持自定义 coverUrl 覆盖，并保留容错与矢量图回退', () => {
  const { LibraryArtwork } = loadArtworkModule();

  // Custom coverUrl
  const customNode = LibraryArtwork({ gameId: 'example.crazy-flasher4', coverUrl: 'https://example.com/custom.jpg' });
  assert.equal(customNode.props.children.props.src, 'https://example.com/custom.jpg');

  // Other game without coverUrl renders vector graphics
  const arenaNode = LibraryArtwork({ gameId: 'example.cat-arena' });
  assert.ok(arenaNode.props.className.includes('gc-art-arena'));
  assert.equal(arenaNode.props.children[1].type, 'svg');
});
