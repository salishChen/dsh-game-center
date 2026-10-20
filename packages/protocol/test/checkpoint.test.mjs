/**
 * 检查点幂等与冲突判定契约测试（证据分栏：UNIT）。
 *
 * 运行：node --test test/checkpoint.test.mjs（需先 tsc 产出 dist/）。
 * 只验证纯函数判定规则；真实事务与子进程并发由存储层与其测试负责。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideCheckpoint,
  encodeKeySegment,
  isValidIdentitySegment,
  saveStorageKey,
  isValidCheckpointOperationId,
  checkpointIdempotencyKey,
  canonicalCheckpointContent,
  CHECKPOINT_OPERATION_ID_PATTERN,
} from '../dist/checkpoint.js'

const digest = (s) => 'sha256:' + s.repeat(64).slice(0, 64)

test('首次保存：expectedRevision=0 且无既有存档 → 写入 revision 1', () => {
  const decision = decideCheckpoint({
    request: { operationId: 'op-1', expectedRevision: 0 },
    existing: null,
    requestContentDigest: digest('a'),
  })
  assert.deepEqual(decision, { kind: 'write', nextRevision: 1 })
})

test('连续保存：expectedRevision 等于当前 revision 才放行', () => {
  const decision = decideCheckpoint({
    request: { operationId: 'op-2', expectedRevision: 2 },
    existing: { revision: 2, operations: [{ operationId: 'op-1', contentDigest: digest('a') }] },
    requestContentDigest: digest('b'),
  })
  assert.deepEqual(decision, { kind: 'write', nextRevision: 3 })
})

test('并发冲突：expectedRevision 落后 → STALE_RUNTIME 并回带当前 revision', () => {
  const decision = decideCheckpoint({
    request: { operationId: 'op-race', expectedRevision: 2 },
    existing: { revision: 3, operations: [] },
    requestContentDigest: digest('c'),
  })
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.code, 'STALE_RUNTIME')
  assert.equal(decision.currentRevision, 3)
})

test('幂等重放：同 operationId 且内容一致 → 返回原 revision，不新增', () => {
  const sameDigest = digest('d')
  const decision = decideCheckpoint({
    request: { operationId: 'op-retry', expectedRevision: 1 },
    existing: {
      revision: 5,
      operations: [{ operationId: 'op-retry', contentDigest: sameDigest }],
    },
    requestContentDigest: sameDigest,
  })
  assert.deepEqual(decision, { kind: 'idempotent-replay', revision: 5 })
})

test('同 operationId 不同内容 → 拒绝，不得覆盖历史', () => {
  const decision = decideCheckpoint({
    request: { operationId: 'op-bad', expectedRevision: 1 },
    existing: {
      revision: 5,
      operations: [{ operationId: 'op-bad', contentDigest: digest('e') }],
    },
    requestContentDigest: digest('f'),
  })
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.code, 'PROTOCOL_INVALID')
  assert.equal(decision.currentRevision, 5)
})

test('同 generation 内不同动作是不同检查点：不同 operationId 各自递增', () => {
  const first = decideCheckpoint({
    request: { operationId: 'move-1', expectedRevision: 0 },
    existing: null,
    requestContentDigest: digest('1'),
  })
  assert.deepEqual(first, { kind: 'write', nextRevision: 1 })

  const second = decideCheckpoint({
    request: { operationId: 'move-2', expectedRevision: 1 },
    existing: { revision: 1, operations: [{ operationId: 'move-1', contentDigest: digest('1') }] },
    requestContentDigest: digest('2'),
  })
  assert.deepEqual(second, { kind: 'write', nextRevision: 2 }, '同 generation 不同动作必须产生新检查点')
})

test('operationId 形态校验', () => {
  assert.equal(isValidCheckpointOperationId('turn-12-interrogate'), true)
  assert.equal(isValidCheckpointOperationId('a.b:c_d-1'), true)
  assert.equal(isValidCheckpointOperationId(''), false)
  assert.equal(isValidCheckpointOperationId('has space'), false)
  assert.equal(isValidCheckpointOperationId('x'.repeat(129)), false)
  assert.equal(isValidCheckpointOperationId(123), false)
  assert.match(CHECKPOINT_OPERATION_ID_PATTERN.source, /A-Za-z0-9/)
})

test('幂等键作用范围：同 operationId 在不同玩家/游戏/存档下必须是不同键', () => {
  const base = { playerId: 'p1', gameId: 'example.minesweeping', saveId: 'save-1', operationId: 'op-1' }
  const key = checkpointIdempotencyKey(base)
  assert.notEqual(key, checkpointIdempotencyKey({ ...base, playerId: 'p2' }), '跨玩家必须不同')
  assert.notEqual(key, checkpointIdempotencyKey({ ...base, gameId: 'other.game' }), '跨游戏必须不同')
  assert.notEqual(key, checkpointIdempotencyKey({ ...base, saveId: 'save-2' }), '跨存档必须不同')
  assert.equal(key, checkpointIdempotencyKey({ ...base }), '相同四元组必须稳定')
  assert.match(key, /p1\|example\.minesweeping\|save-1\|op-1/)
})

test('幂等键：分隔符注入不能伪造另一段', () => {
  const a = checkpointIdempotencyKey({ playerId: 'p1', gameId: 'g|x', saveId: 's', operationId: 'o' })
  const b = checkpointIdempotencyKey({ playerId: 'p1', gameId: 'g', saveId: 'x|s', operationId: 'o' })
  assert.notEqual(a, b, '分隔符被转义后不能跨段伪造相同键')
})

test('内容摘要覆盖范围：改 RNG/虚拟时间/结构版本/提交都必须改变规范内容', () => {
  const base = {
    state: { board: [1, 2, 3] },
    elapsedGameMs: 1000,
    rngState: 'aa',
    gameStateSchemaVersion: 1,
    installedCommit: 'a'.repeat(40),
  }
  const canonical = canonicalCheckpointContent(base)

  assert.notEqual(canonical, canonicalCheckpointContent({ ...base, rngState: 'bb' }), '改 RNG 必须变化')
  assert.notEqual(canonical, canonicalCheckpointContent({ ...base, elapsedGameMs: 999 }), '改虚拟时间必须变化')
  assert.notEqual(canonical, canonicalCheckpointContent({ ...base, gameStateSchemaVersion: 2 }), '改结构版本必须变化')
  assert.notEqual(canonical, canonicalCheckpointContent({ ...base, installedCommit: 'b'.repeat(40) }), '改提交必须变化')
  assert.notEqual(canonical, canonicalCheckpointContent({ ...base, state: { board: [1, 2, 4] } }), '改棋盘必须变化')
  assert.equal(canonical, canonicalCheckpointContent({ ...base }), '相同内容必须稳定')
})

test('内容摘要：对象 key 顺序不影响结果', () => {
  const a = canonicalCheckpointContent({
    state: { z: 1, a: 2 },
    elapsedGameMs: 1,
    rngState: 'x',
    gameStateSchemaVersion: 1,
    installedCommit: 'c'.repeat(40),
  })
  const b = canonicalCheckpointContent({
    state: { a: 2, z: 1 },
    elapsedGameMs: 1,
    rngState: 'x',
    gameStateSchemaVersion: 1,
    installedCommit: 'c'.repeat(40),
  })
  assert.equal(a, b, 'key 顺序不同但内容相同必须得到同一规范串')
})

test('身份段编码：安全值原样、危险值转义且不可解释为分隔符', () => {
  assert.equal(encodeKeySegment('player-A'), 'player-A');
  assert.equal(encodeKeySegment('player_A1'), 'player_A1');
  assert.equal(encodeKeySegment('..'), null, '全点段必须拒绝');
  assert.equal(encodeKeySegment('.'), null);
  assert.equal(encodeKeySegment(''), null);
  assert.equal(encodeKeySegment(123), null);

  const traversal = encodeKeySegment('../player-A');
  assert.notEqual(traversal, null);
  assert.equal(traversal.includes('/'), false, '编码后不得含斜杠');
  assert.equal(traversal.includes('..'), false, '编码后不得含双点');
  assert.equal(traversal.includes('\\\\'), false, '编码后不得含反斜杠');
});

test('身份段编码：不同输入不产生相同键（防碰撞）', () => {
  const a = encodeKeySegment('a/b');
  const b = encodeKeySegment('a- b');
  const c = encodeKeySegment('ab');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  // 清洗式实现会把 'a/b' 和 'ab' 撞在一起；编码式不会
  assert.notEqual(a, 'ab');
});

test('存储键：三要素俱在才生成，缺失或非法一律返回 null（禁止降级公共路径）', () => {
  assert.equal(saveStorageKey({ playerId: 'p1', gameId: 'example.minesweeping', saveId: 'save-1' }), 'saves/p1/example.minesweeping/save-1.json');
  assert.equal(saveStorageKey({ playerId: '', gameId: 'g', saveId: 's' }), null, '缺身份必须拒绝，不得回落公共路径');
  const traversalKey = saveStorageKey({ playerId: '../player-A', gameId: 'g', saveId: 's' });
  assert.notEqual(traversalKey, null);
  assert.equal(traversalKey.startsWith('saves/'), true);
  assert.equal(traversalKey.split('/').length, 4, '穿越段必须被压成单段');
  assert.equal(traversalKey.includes('..'), false, '编码后不得含双点');
  const gameEscape = saveStorageKey({ playerId: 'p1', gameId: 'g/../x', saveId: 's' });
  assert.equal(gameEscape.startsWith('saves/p1/'), true);
  assert.equal(gameEscape.split('/').length, 4, 'gameId 穿越段必须被压成单段');
  assert.equal(gameEscape.includes('..'), false);
  assert.equal(saveStorageKey({ playerId: 'p1', gameId: 'g', saveId: '..' }), null);
  // 关键：任何包含编码后的键都不得出现可被文件系统解释为分层的穿越
  const key = saveStorageKey({ playerId: '../p', gameId: 'g', saveId: 's' });
  assert.equal(key.split('/').length, 4, '只能有 saves/player/game/file 四段');
});

test('身份合法性：合法身份可用，缺身份与穿越段不可用', () => {
  assert.equal(isValidIdentitySegment('player-A'), true);
  assert.equal(isValidIdentitySegment(''), false);
  assert.equal(isValidIdentitySegment('../x'), true, '可编码即合法，但编码后不含穿越语义');
  assert.equal(isValidIdentitySegment('..'), false);
  assert.equal(encodeKeySegment('../x').includes('..'), false);
});
