import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { checkLogin, checkLogins, cookieDbFor, resolveEnvs, allConfigEnvs, describeLogin, SESSION_COOKIES } from '../../src/login-state.js';

let TMP;
before(async () => {
  TMP = path.join(os.tmpdir(), `xnp-login-${Date.now()}`);
  await fs.ensureDir(TMP);
});
after(async () => {
  await fs.remove(TMP).catch(() => {});
});

/** 造一个 moz_cookies 表只有一个 name 列的假库（够 precheck 用） */
async function fakeDb(env, cookieNames) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(TMP, env);
  await fs.ensureDir(dir);
  const file = path.join(dir, 'cookies.sqlite');
  await fs.remove(file);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE moz_cookies (name TEXT, host TEXT)');
  const ins = db.prepare('INSERT INTO moz_cookies (name, host) VALUES (?, ?)');
  for (const n of cookieNames) ins.run(n, '.tiktok.com');
  db.close();
  return file;
}

describe('登录态预检', () => {
  test('cookie 名清单包含四个 session cookie', () => {
    for (const n of ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard']) {
      assert.ok(SESSION_COOKIES.includes(n), `缺少 ${n}`);
    }
  });

  test('有 sessionid → 判为已登录', async () => {
    await fakeDb('TK01', ['sessionid', 'tt_csrf_token']);
    const r = await checkLogin('TK01', { dir: path.join(TMP, 'TK01') });
    assert.equal(r.state, 'in');
    assert.ok(r.session >= 1);
    assert.equal(r.cookies, 2);
  });

  test('只有无关 cookie → 判为未登录', async () => {
    await fakeDb('TK02', ['tt_csrf_token', 'msToken']);
    const r = await checkLogin('TK02', { dir: path.join(TMP, 'TK02') });
    assert.equal(r.state, 'out');
    assert.equal(r.session, 0);
    assert.match(r.note, /没有 sessionid/);
  });

  test('库不存在 → unknown（不能误判成未登录，会误杀任务）', async () => {
    const r = await checkLogin('TK98', { dir: path.join(TMP, 'TK98') });
    assert.equal(r.state, 'unknown');
    assert.match(r.note, /没有 cookie 库/);
  });

  test('空环境名 → unknown', async () => {
    const r = await checkLogin('');
    assert.equal(r.state, 'unknown');
  });

  test('坏文件（不是 sqlite）→ unknown 而不是抛异常', async () => {
    const dir = path.join(TMP, 'TKBAD');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'cookies.sqlite'), 'not a database at all');
    const r = await checkLogin('TKBAD', { dir });
    assert.equal(r.state, 'unknown');
    assert.ok(r.note.length > 0);
  });

  test('批量判定返回每个环境的结果', async () => {
    await fakeDb('TK03', ['sessionid_ss']);
    await fakeDb('TK04', ['msToken']);
    const map = await checkLogins(['TK03', 'TK04'], { dir: path.join(TMP, 'TK03') });
    // TK04 的库不在这个 dir 下 —— 单独指定它自己的目录
    map.TK04 = await checkLogin('TK04', { dir: path.join(TMP, 'TK04') });
    assert.equal(map.TK03.state, 'in');
    assert.equal(map.TK04.state, 'out');
  });

  test('cookie 库路径落在环境的 camoufox_data 子目录', () => {
    const p = cookieDbFor('TK07', 'D:/fox/camoufox_data/TK07');
    assert.equal(path.basename(p), 'cookies.sqlite');
    assert.equal(path.basename(path.dirname(p)), 'TK07');
  });

  test('describe 三种状态都说人话', () => {
    assert.match(describeLogin({ env: 'TK01', state: 'in', session: 4 }), /已登录/);
    assert.match(describeLogin({ env: 'TK02', state: 'out', note: 'x' }), /未登录/);
    assert.match(describeLogin({ env: 'TK03', state: 'unknown', note: '占用' }), /未知/);
  });
});

describe('定时任务的账号 → 环境解析', () => {
  const cfg = {
    accounts: [
      { name: '01', bitEnvId: 'TK01', browserEnv: 'TK01' },
      { name: '02', bitEnvId: 'TK02', browserEnv: 'TK02' },
      { name: '07', browserEnv: 'TK07' },
    ],
  };

  test('配置里的序号能解析成环境', () => {
    assert.deepEqual(resolveEnvs('02', cfg), ['TK02']);
  });

  test('已经是环境名也能解析', () => {
    assert.deepEqual(resolveEnvs('tk07', cfg), ['TK07']);
  });

  test('多个账号用逗号分隔，去重', () => {
    assert.deepEqual(resolveEnvs('01,TK01,02', cfg), ['TK01', 'TK02']);
  });

  test('配置里没有的序号按 TK0N 兜底', () => {
    assert.deepEqual(resolveEnvs('9', cfg), ['TK09']);
    assert.deepEqual(resolveEnvs('TK12', cfg), ['TK12']);
  });

  test('空值返回空数组（不能让预检去查一堆空环境）', () => {
    assert.deepEqual(resolveEnvs('', cfg), []);
    assert.deepEqual(resolveEnvs(undefined, cfg), []);
  });

  test('allConfigEnvs 只返回 TKxx 形状的环境', () => {
    const envs = allConfigEnvs({ accounts: [{ name: '01', bitEnvId: 'TK01' }, { name: 'helper', bitEnvId: 'x' }] });
    assert.deepEqual(envs, ['TK01']);
  });
});
