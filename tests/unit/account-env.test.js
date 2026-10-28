import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateAccountEnvs } from '../../src/account-env.js';

const state10 = {};
for (let i = 1; i <= 10; i++) {
  state10[`TK${String(i).padStart(2, '0')}`] = { username: `user${String(i).padStart(2, '0')}` };
}

test('空状态：按顺序拿 TK01、TK02', () => {
  const out = allocateAccountEnvs([{ username: 'a' }, { username: 'b' }], {});
  assert.deepEqual(out.map((r) => r.env), ['TK01', 'TK02']);
});

test('已有 10 个号 + 只给 2 个新号 → TK11、TK12（绝不占用 TK01）', () => {
  const out = allocateAccountEnvs([{ username: 'new1' }, { username: 'new2' }], state10);
  assert.deepEqual(out.map((r) => r.env), ['TK11', 'TK12']);
});

test('已登记的用户名永远留在原环境（与文件行号无关）', () => {
  const out = allocateAccountEnvs([{ username: 'new1' }, { username: 'user03' }], state10);
  assert.deepEqual(out.map((r) => r.env), ['TK11', 'TK03']);
});

test('大小写不同也算同一个号', () => {
  const out = allocateAccountEnvs([{ username: 'USER03' }], state10);
  assert.equal(out[0].env, 'TK03');
});

test('同一份文件里重复的号：只分配一次，后面标记 duplicate', () => {
  const out = allocateAccountEnvs([{ username: 'dup' }, { username: 'DUP' }, { username: 'x' }], state10);
  assert.equal(out[0].env, 'TK11');
  assert.equal(out[1].duplicate, true);
  assert.equal(out[2].env, 'TK12');
});

test('改过用户名的号：邮箱对得上就认回原环境，不再分新号', () => {
  // 2026-10-24 真实事故：TK01 从 ryloclyjdcf 改名成 xnow.matrix 后，
  // 再导入那份老文件 → 旧用户名匹配不上 → 多出一条 TK12（同邮箱同密码），且没有对应环境。
  const state = {
    TK01: { username: 'xnow.matrix', email: 'RyloCora4271@outlook.com' },
    TK11: { username: 'tk.ins', email: '' },
  };
  const out = allocateAccountEnvs([{ username: 'ryloclyjdcf', email: 'rylocora4271@outlook.com' }], state);
  assert.equal(out[0].env, 'TK01', '应认回 TK01，而不是拿 TK12');
  assert.equal(out[0].duplicate, false);
});

test('邮箱匹配也要按大小写不敏感', () => {
  const state = { TK03: { username: 'old', email: 'A@B.com' } };
  const out = allocateAccountEnvs([{ username: 'renamed', email: 'a@b.COM' }], state);
  assert.equal(out[0].env, 'TK03');
});

test('邮箱撞了但用户名也撞了别的号：优先按用户名（不串号）', () => {
  const state = {
    TK03: { username: 'user03', email: 'a@b.com' },
    TK04: { username: 'user04', email: 'c@d.com' },
  };
  const out = allocateAccountEnvs([{ username: 'user03', email: 'c@d.com' }], state);
  assert.equal(out[0].env, 'TK03');
});

test('FoxProfile 里已有但状态没登记的环境也要避开（不撞号）', () => {
  const out = allocateAccountEnvs([{ username: 'n1' }], state10, ['TK11', 'TK12']);
  assert.equal(out[0].env, 'TK13');
});

test('中间空号优先复用（TK05 被删掉时）', () => {
  const holey = { ...state10 };
  delete holey.TK05;
  const out = allocateAccountEnvs([{ username: 'n1' }], holey);
  assert.equal(out[0].env, 'TK05');
});

test('空用户名行直接跳过', () => {
  const out = allocateAccountEnvs([{ username: '' }, { username: 'ok' }, {}], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'ok');
  assert.equal(out[0].index, 2);
});
