'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * 本地存储方案（零外部依赖，使用 Node 内置 node:sqlite）：
 * - 默认数据库文件位于 ~/.taskcli/taskcli.db
 * - 可用环境变量 TASKCLI_DB 覆盖路径（便于多项目/多 agent 隔离）
 * - 开启 WAL 日志模式与 foreign_keys 外键约束（删除项目级联删除其任务）
 */
function resolveDbPath() {
  if (process.env.TASKCLI_DB) return process.env.TASKCLI_DB;
  const dir = path.join(os.homedir(), '.taskcli');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'taskcli.db');
}

const db = new DatabaseSync(resolveDbPath());
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// 多进程并发安全：CLI 与 Web 服务可能同时打开同一文件，等待锁而非立即报错
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    code       TEXT    NOT NULL DEFAULT '',
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    status     TEXT    NOT NULL DEFAULT 'todo',
    priority   TEXT    NOT NULL DEFAULT 'normal',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);

  CREATE TABLE IF NOT EXISTS task_tracks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_task ON task_tracks(task_id);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/**
 * 为每个任务生成一个全局唯一的「独立编号」code，格式 T-XXXXXX。
 * 采用去除易混淆字符（I/O/0/1）的 base32 字符集，碰撞概率极低，
 * 生成后仍做一次唯一性校验（极端情况下重试），保证索引不冲突。
 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genTaskCode() {
  let code;
  do {
    let s = '';
    for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    code = 'T-' + s;
  } while (db.prepare('SELECT 1 FROM tasks WHERE code = ?').get(code));
  return code;
}

/**
 * 迁移：为已存在的表补齐 code 列，并为历史任务回填独立编号。
 * 兼容旧库（无 code 列）升级，新库（建表时已有 code 列）直接跳过。
 */
(function migrateTaskCode() {
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!cols.includes('code')) {
    // 旧库升级：先补齐列，再建唯一索引（索引必须在列存在之后才能创建）
    db.exec('ALTER TABLE tasks ADD COLUMN code TEXT NOT NULL DEFAULT \'\'');
  }
  // 唯一索引幂等创建（新建库与升级库都确保存在）
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_code ON tasks(code)');
  const rows = db.prepare('SELECT id FROM tasks WHERE code IS NULL OR code = \'\'').all();
  if (rows.length) {
    const upd = db.prepare('UPDATE tasks SET code = ? WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const r of rows) upd.run(genTaskCode(), r.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
})();

function now() {
  return Date.now();
}

module.exports = { db, now, resolveDbPath, genTaskCode };
