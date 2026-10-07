'use strict';

const { loadSqlite } = require('./sqlite-guard');
const { resolveDbPath } = require('./brand');
const { DatabaseSync } = loadSqlite();

/**
 * 本地存储方案（零外部依赖，使用 Node 内置 node:sqlite）：
 * - 默认数据库文件位于 ~/.t2a/t2a.db
 * - 可用环境变量 T2A_DB（兼容旧名 TASKCLI_DB）覆盖路径，便于多项目/多 agent 隔离
 * - 若旧目录 ~/.taskcli 已有数据且新目录尚未建立，自动沿用旧库，避免改名丢数据
 * - 开启 WAL 日志模式与 foreign_keys 外键约束（删除项目级联删除其任务）
 */

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

/**
 * 迁移：为「agent 联动」补齐任务字段与依赖表。
 * - assignee / claimed_at / lease_until：认领者 + 租约（到期可自动回收，防 agent 挂掉后任务卡死）
 * - attempts / last_error / result：失败重试与产出留痕
 * - external_key：幂等键，agent 重试建任务时不会重复插入
 * 全部按列存在性判断，兼容旧库升级。
 */
const DEFAULT_LEASE_MS = 30 * 60 * 1000;

(function migrateAgentFields() {
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  const addCol = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${ddl}`);
  };
  addCol('assignee', 'TEXT');
  addCol('claimed_at', 'INTEGER');
  addCol('lease_until', 'INTEGER');
  addCol('attempts', 'INTEGER NOT NULL DEFAULT 0');
  addCol('last_error', "TEXT NOT NULL DEFAULT ''");
  addCol('result', "TEXT NOT NULL DEFAULT ''");
  addCol('external_key', 'TEXT');

  // 幂等键唯一索引（NULL / 空串不参与唯一约束）
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_extkey ON tasks(external_key) WHERE external_key IS NOT NULL AND external_key <> ''"
  );

  // 任务依赖（DAG）：B 依赖 A，则 A 未完成前 B 不可被认领
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_deps (
      task_id       INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_deps_on ON task_deps(depends_on_id)');

  // 审计事件：谁（actor）在何时对哪个任务/项目做了什么，便于多 agent 协作复盘
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      kind       TEXT    NOT NULL,
      actor      TEXT    NOT NULL DEFAULT '',
      task_id    INTEGER,
      project_id INTEGER,
      detail     TEXT    NOT NULL DEFAULT ''
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id)');
})();

/** 写一条审计事件（kind 形如 task.claim / task.done / project.add） */
function logEvent(kind, opts) {
  const o = opts || {};
  return db
    .prepare('INSERT INTO events(ts, kind, actor, task_id, project_id, detail) VALUES(?,?,?,?,?,?)')
    .run(now(), kind, o.actor || '', o.task_id ?? null, o.project_id ?? null, o.detail || '');
}

function now() {
  return Date.now();
}

/** 解析租约时长：支持 "30m" / "2h" / "90s" / 纯毫秒数，默认 30 分钟 */
function parseDuration(v, fallback = DEFAULT_LEASE_MS) {
  if (v === undefined || v === true || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  const mul = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return Math.max(1, Math.round(n * mul));
}

/** 未完成的前置依赖（依赖任务状态不是 done 即视为未完成） */
function pendingDeps(taskId) {
  return db
    .prepare(
      `SELECT d.depends_on_id AS id, t.title, t.status
         FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
        WHERE d.task_id = ? AND t.status <> 'done'
        ORDER BY d.depends_on_id`
    )
    .all(taskId);
}

/** 系统日志：写入任务的跟踪记录（回收/重试等自动动作留痕，便于回溯） */
function addTrack(taskId, content, ts = now()) {
  const info = db
    .prepare('INSERT INTO task_tracks(task_id, content, created_at) VALUES(?,?,?)')
    .run(taskId, content, ts);
  return db.prepare('SELECT * FROM task_tracks WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * 回收过期租约：doing 中但租约已到期的任务，释放回 todo（清空认领人），
 * 并写一条系统跟踪记录。返回被回收的任务列表。
 */
function reclaimExpired(ts = now()) {
  const rows = db
    .prepare(
      `SELECT id, title, assignee FROM tasks
        WHERE status = 'doing' AND assignee IS NOT NULL AND assignee <> ''
          AND lease_until IS NOT NULL AND lease_until < ?`
    )
    .all(ts);
  if (!rows.length) return rows;
  const upd = db.prepare(
    "UPDATE tasks SET status = 'todo', assignee = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?"
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      upd.run(ts, r.id);
      addTrack(r.id, `[系统] 租约超时，已从 ${r.assignee} 回收，任务回到待办`, ts);
      logEvent('task.reclaim', {
        actor: 'system',
        task_id: r.id,
        detail: `租约超时，从 ${r.assignee} 回收`,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows;
}

/**
 * 原子认领：单条 UPDATE + WHERE 条件保证「只有一个调用方能抢到」，
 * 以 changes 判定胜负，避免多 agent 并发重复干活。
 * 返回 {ok:true,data:row} 或 {ok:false,code,message}
 */
function claimTask(id, agent, leaseMs = DEFAULT_LEASE_MS) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'NOT_FOUND', message: `记录不存在: ${id}` };
  if (row.status === 'done' || row.status === 'archive') {
    return { ok: false, code: 'INVALID_STATUS', message: `任务 #${id} 已处于终态 ${row.status}，不可认领` };
  }
  const pend = pendingDeps(id);
  if (pend.length) {
    return {
      ok: false,
      code: 'DEP_NOT_READY',
      message: `任务 #${id} 的前置依赖未完成: ${pend.map((p) => `#${p.id}(${p.status})`).join(', ')}`,
      data: { pending: pend },
    };
  }
  const ts = now();
  const info = db
    .prepare(
      `UPDATE tasks SET status = 'doing', assignee = ?, claimed_at = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
          AND (assignee IS NULL OR assignee = '' OR lease_until IS NULL OR lease_until < ?)`
    )
    .run(agent, ts, ts + leaseMs, ts, id, ts);
  if (info.changes !== 1) {
    const cur = db.prepare('SELECT assignee, lease_until FROM tasks WHERE id = ?').get(id);
    const until = cur.lease_until ? new Date(cur.lease_until).toLocaleString('zh-CN') : '未知';
    return {
      ok: false,
      code: 'CONFLICT',
      message: `任务 #${id} 已被 "${cur.assignee}" 认领（租约至 ${until}），换一条或先 heartbeat 抢占前确认对方已停止`,
      data: { assignee: cur.assignee, lease_until: cur.lease_until },
    };
  }
  logEvent('task.claim', {
    actor: agent,
    task_id: id,
    project_id: row.project_id,
    detail: `认领（租约 ${Math.round(leaseMs / 1000)}s）`,
  });
  return { ok: true, data: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) };
}

/**
 * 取下一个可做的任务：先回收过期租约，再按优先级/顺序挑一条依赖已就绪且无人认领的，
 * 然后原子认领。抢不到就换下一条（并发安全）。
 * 返回 task row 或 null（无任务）
 */
function nextTask(projectId, agent, leaseMs = DEFAULT_LEASE_MS, statuses = ['todo']) {
  reclaimExpired();
  const list = Array.isArray(statuses) && statuses.length ? statuses : ['todo'];
  const ph = list.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM tasks
        WHERE project_id = ? AND status IN (${ph}) AND (assignee IS NULL OR assignee = '')
        ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, position, id`
    )
    .all(projectId, ...list);
  for (const r of rows) {
    if (pendingDeps(r.id).length) continue;
    const res = claimTask(r.id, agent, leaseMs);
    if (res.ok) return res.data;
  }
  return null;
}

/**
 * 依赖环检测：加入 task -> depends_on 这条边后是否成环。
 *
 * 新边是「taskId 依赖 dependsOnId」。若 dependsOnId 已经（间接）依赖 taskId，
 * 这条边就会闭合成环。判据：从 dependsOnId 出发，沿依赖方向（它依赖谁）
 * 能否走回 taskId。所以下一步要查的是「当前节点依赖了谁」，
 * 而不是「谁依赖当前节点」——后者只会越走越远，永远撞不回 taskId。
 */
function depWouldCycle(taskId, dependsOnId) {
  if (taskId === dependsOnId) return true;
  const seen = new Set();
  const stack = [dependsOnId];
  const q = db.prepare('SELECT depends_on_id FROM task_deps WHERE task_id = ?');
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of q.all(cur)) stack.push(r.depends_on_id);
  }
  return false;
}

/** 数据版本号（用于 SSE 变化检测：任务/项目/跟踪记录的条数与最近更新时间） */
function revision() {
  const t = db.prepare('SELECT COUNT(*) c, COALESCE(MAX(updated_at),0) m FROM tasks').get();
  const p = db.prepare('SELECT COUNT(*) c, COALESCE(MAX(updated_at),0) m FROM projects').get();
  const k = db.prepare('SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM task_tracks').get();
  return `${t.c}.${t.m}.${p.c}.${p.m}.${k.c}.${k.m}`;
}

module.exports = {
  db,
  now,
  resolveDbPath,
  genTaskCode,
  DEFAULT_LEASE_MS,
  parseDuration,
  pendingDeps,
  addTrack,
  reclaimExpired,
  claimTask,
  nextTask,
  depWouldCycle,
  revision,
  logEvent,
};
