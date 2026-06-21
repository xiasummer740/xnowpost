import initSqlJs from 'sql.js';
import fs from 'fs-extra';
import path from 'path';

let _SQL = null;

async function getInit() {
  if (!_SQL) _SQL = await initSqlJs();
  return _SQL;
}

/**
 * 打开 SQLite 数据库（自动从文件加载）
 * @param {string} dbPath
 */
export async function openDB(dbPath) {
  const SQL = await getInit();
  let buf = null;
  try {
    if (fs.existsSync(dbPath)) {
      buf = fs.readFileSync(dbPath);
    }
  } catch (_) {}
  const db = new SQL.Database(buf);

  return {
    run(sql, params = []) {
      db.run(sql, params);
    },

    exec(sql) {
      db.exec(sql);
    },

    get(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      let row;
      if (stmt.step()) row = stmt.getAsObject();
      stmt.free();
      return row;
    },

    all(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },

    transaction(fn) {
      db.run('BEGIN');
      try {
        fn();
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },

    /** 导出为 Buffer */
    export() {
      return Buffer.from(db.export());
    },

    close() {
      db.close();
    },
  };
}

/**
 * 初始化数据库（建表 + schema 迁移）
 */
export async function ensureDB(dbPath) {
  await fs.ensureDir(path.dirname(dbPath));
  const db = await openDB(dbPath);

  // 主表（仅建表，CREATE INDEX 放在迁移之后）
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      platform TEXT NOT NULL,
      metric TEXT NOT NULL,
      value INTEGER NOT NULL,
      account TEXT NOT NULL DEFAULT 'default',
      UNIQUE(date, account, platform, metric)
    );
  `);

  // 迁移：旧表没有 account 列，则重建表（sqlite 不允许直接改 UNIQUE 约束）
  const cols = db.all("PRAGMA table_info(daily_stats)").map(c => c.name);
  if (!cols.includes('account')) {
    db.exec(`
      ALTER TABLE daily_stats RENAME TO daily_stats_old;
    `);
    db.exec(`
      CREATE TABLE daily_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        platform TEXT NOT NULL,
        metric TEXT NOT NULL,
        value INTEGER NOT NULL,
        account TEXT NOT NULL DEFAULT 'default',
        UNIQUE(date, account, platform, metric)
      );
    `);
    db.exec(`
      INSERT INTO daily_stats (date, platform, metric, value, account)
        SELECT date, platform, metric, value, 'default' FROM daily_stats_old;
    `);
    db.exec(`DROP TABLE daily_stats_old;`);
  }

  // 索引放迁移之后，确保 account 列已存在
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
    CREATE INDEX IF NOT EXISTS idx_daily_stats_account ON daily_stats(account);
  `);

  // 内容表现表（暂未使用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT 'default',
      platform TEXT NOT NULL,
      publish_date TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_content_performance_account ON content_performance(account);
  `);

  fs.writeFileSync(dbPath, db.export());
  db.close();
}
