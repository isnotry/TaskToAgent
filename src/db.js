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

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function now() {
  return Date.now();
}

module.exports = { db, now, resolveDbPath };
