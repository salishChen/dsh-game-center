import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryAccess} from '../src/core/memory-access.js';
import {SUPPORTED_CART_SHA256} from '../src/rom-identity.js';

// 受支持卡带的哈希只有一个来源（契约 §8.1）：从 src/rom-identity.js 取，测试里不写字面量。
const ROM = `sha256:${SUPPORTED_CART_SHA256[0]}`;

function fakeIo(memory = new Map()) {
  const io = {
    memory,
    calls: [],
    read8(addr) {
      io.calls.push(['r8', addr]);
      if (!memory.has(addr)) throw new Error('unmapped');
      return memory.get(addr) & 0xff;
    },
    read16(addr) {
      io.calls.push(['r16', addr]);
      if (!memory.has(addr)) throw new Error('unmapped');
      return memory.get(addr) & 0xffff;
    },
    read32(addr) {
      io.calls.push(['r32', addr]);
      if (!memory.has(addr)) throw new Error('unmapped');
      return memory.get(addr) >>> 0;
    },
    write8(addr, v) {
      io.calls.push(['w8', addr, v]);
      memory.set(addr, v & 0xff);
    },
    write16(addr, v) {
      io.calls.push(['w16', addr, v]);
      memory.set(addr, v & 0xffff);
    },
  };
  return io;
}

const TABLE = {
  schema: 1,
  romId: ROM,
  entries: {
    cursorX: {address: '0x0202BCC4', type: 'u16'},
    flag: {address: '0x02000001', type: 'u8'},
  },
};

test('按名读：u16 / u8 各走对方法', () => {
  const memory = new Map([[0x0202bcc4, 0x1234], [0x02000001, 0x7f]]);
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io: fakeIo(memory)});
  assert.equal(mem.readU16('cursorX'), 0x1234);
  assert.equal(mem.readU8('flag'), 0x7f);
});

test('读失败返回 null，不返回 0（0 是合法值，不能拿它表示失败）', () => {
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io: fakeIo(new Map())});
  assert.equal(mem.readU16('cursorX'), null);
  assert.notEqual(mem.readU16('cursorX'), 0);
});

test('未声明的名字：读/写都直接报错并列出可用项', () => {
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io: fakeIo()});
  assert.throws(() => mem.readU16('nope'), /没有 nope/);
  assert.throws(() => mem.readU16('nope'), /cursorX/);
});

test('写：u16 会掩到 16 位，u8 掩到 8 位', () => {
  const io = fakeIo(new Map());
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io});
  mem.writeU16('cursorX', 0x1_2345);
  mem.writeU8('flag', 0x1ff);
  assert.equal(io.memory.get(0x0202bcc4), 0x2345);
  assert.equal(io.memory.get(0x02000001), 0xff);
});

test('写错宽度必须拒绝（u8 项不能用 writeU16 写）', () => {
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io: fakeIo()});
  assert.throws(() => mem.writeU16('flag', 1), /1 字节/);
});

test('不提供 32 位写（GBA 语义是两次 16 位写，给了就是陷阱）', () => {
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io: fakeIo()});
  assert.equal(typeof mem.writeU32, 'undefined');
});

test('ROM 不匹配时拒绝构造（地址表不能跨 ROM 复用）', () => {
  assert.throws(
    () => createMemoryAccess({table: TABLE, romId: 'sha256:other', io: fakeIo()}),
    /不匹配/,
  );
});

test('raw 通道只在需要时用，且读失败同样返回 null', () => {
  const memory = new Map([[0x0202bcc4, 0x0042]]);
  const mem = createMemoryAccess({table: TABLE, romId: ROM, io: fakeIo(memory)});
  assert.equal(mem.raw.read16(0x0202bcc4), 0x42);
  assert.equal(mem.raw.read16(0x03000000), null);
});
