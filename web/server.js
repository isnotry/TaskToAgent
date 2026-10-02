'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// node:sqlite 在 Node 22 仍是实验特性，静默其 stderr 警告，保持输出干净
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning') return;
  process.stderr.write(`Warning: ${w && w.message ? w.message : w}\n`);
});

// 复用 CLI 的同一份数据库与表结构（同一文件、同一连接配置）
const {
  db,
  now,
  genTaskCode,
  DEFAULT_LEASE_MS,
  parseDuration,
  pendingDeps,
  addTrack,
  claimTask,
  nextTask,
  depWouldCycle,
  revision,
  logEvent,
} = require('../src/db');

const PORT = Number(process.env.TASKCLI_PORT || 3979);
// 默认只监听回环地址，避免局域网无鉴权访问；需要外部访问时设 TASKCLI_HOST=0.0.0.0
const HOST = process.env.TASKCLI_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * 结构化错误响应：保留 error 字符串（兼容既有前端），附带机器可读 code。
 * 与 CLI 的 {ok:false,error:{code,message}} 保持同一套语义。
 */
function sendErr(res, httpCode, code, message, extra) {
  sendJson(res, httpCode, { error: message, code, ...(extra || {}) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('JSON 解析失败: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function setDefaultIfFirst(id) {
  const total = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  if (total === 1) {
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('default_project',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(id));
  }
}

/* ----------------------------- API 实现 ----------------------------- */

const api = {
  // GET /api/projects  —— 列表（含任务数）
  async 'GET /api/projects'(req, res) {
    const rows = db.prepare('SELECT * FROM projects ORDER BY id').all();
    const out = rows.map((r) => ({
      ...r,
      task_count: db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id = ?').get(r.id).c,
    }));
    sendJson(res, 200, out);
  },

  // POST /api/projects  —— 新建项目  body: {name, description}
  async 'POST /api/projects'(req, res) {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) return sendJson(res, 400, { error: 'name 不能为空' });
    const name = String(b.name).trim();
    const exists = db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
    if (exists) return sendJson(res, 409, { error: `项目已存在: ${name}` });
    const t = now();
    const info = db
      .prepare('INSERT INTO projects(name, description, created_at, updated_at) VALUES(?,?,?,?)')
      .run(name, b.description || '', t, t);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
    setDefaultIfFirst(row.id);
    sendJson(res, 201, row);
  },

  // PATCH /api/projects/:id  —— 重命名  body: {name}
  async 'PATCH /api/projects/:id'(req, res, id) {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) return sendJson(res, 400, { error: 'name 不能为空' });
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) return sendJson(res, 404, { error: `项目不存在: ${id}` });
    db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(String(b.name).trim(), now(), id);
    sendJson(res, 200, db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  },

  // DELETE /api/projects/:id  —— 删除（级联删任务）
  async 'DELETE /api/projects/:id'(req, res, id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) return sendJson(res, 404, { error: `项目不存在: ${id}` });
    const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id = ?').get(id).c;
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    const def = db.prepare("SELECT value FROM meta WHERE key='default_project'").get();
    if (def && Number(def.value) === id) db.prepare("DELETE FROM meta WHERE key='default_project'").run();
    logEvent('project.remove', { actor: 'web', project_id: Number(id), detail: `${p.name}（连带 ${cnt} 条任务）` });
    sendJson(res, 200, { id, removedTasks: cnt });
  },

  // GET /api/projects/:id/tasks  —— 某看板全部任务
  async 'GET /api/projects/:id/tasks'(req, res, id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) return sendJson(res, 404, { error: `项目不存在: ${id}` });
    const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, id').all(id);
    sendJson(res, 200, rows);
  },

  // GET /api/search?q=<关键词>  —— 全局模糊搜索（跨项目，匹配 编号/标题/内容/项目名）
  //   多关键词以空格分隔，按 AND 组合；?project=<id> 可限定项目范围。
  async 'GET /api/search'(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, []);
    const pid = u.searchParams.get('project');
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const where = [];
    const params = [];
    if (pid) {
      where.push('t.project_id = ?');
      params.push(pid);
    }
    const tokCond = tokens
      .map(
        () =>
          '(LOWER(t.code) LIKE ? OR LOWER(t.title) LIKE ? OR LOWER(t.content) LIKE ? OR LOWER(p.name) LIKE ?)'
      )
      .join(' AND ');
    where.push(tokCond);
    for (const tk of tokens) {
      const like = `%${tk}%`;
      params.push(like, like, like, like);
    }
    const sql =
      'SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ' +
      where.join(' AND ') +
      ' ORDER BY t.updated_at DESC';
    const rows = db.prepare(sql).all(...params);
    sendJson(res, 200, rows);
  },

  // POST /api/projects/:id/tasks  —— 新建任务  body: {title, content, status, priority}
  async 'POST /api/projects/:id/tasks'(req, res, id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) return sendJson(res, 404, { error: `项目不存在: ${id}` });
    const b = await readBody(req);
    if (!b.title || !String(b.title).trim()) return sendJson(res, 400, { error: 'title 不能为空' });
    const t = now();
    const pos = db.prepare('SELECT COALESCE(MAX(position),0) m FROM tasks WHERE project_id = ?').get(id).m + 1;
    const info = db
      .prepare(
        'INSERT INTO tasks(project_id, code, title, content, status, priority, position, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        genTaskCode(),
        String(b.title).trim(),
        b.content || '',
        b.status || 'todo',
        b.priority || 'normal',
        pos,
        t,
        t
      );
    sendJson(res, 201, db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
  },

  // PATCH /api/tasks/:id  —— 更新任务
  async 'PATCH /api/tasks/:id'(req, res, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: `记录不存在: ${id}` });
    const b = await readBody(req);
    const fields = {};
    if (b.title !== undefined) fields.title = String(b.title);
    if (b.content !== undefined) fields.content = String(b.content);
    if (b.status !== undefined) fields.status = String(b.status);
    if (b.priority !== undefined) fields.priority = String(b.priority);
    if (b.project_id !== undefined) fields.project_id = Number(b.project_id);
    // agent 产出与失败留痕
    if (b.result !== undefined) fields.result = String(b.result);
    if (b.last_error !== undefined) fields.last_error = String(b.last_error);
    if (Object.keys(fields).length === 0) return sendJson(res, 400, { error: '没有可更新的字段' });
    fields.updated_at = now();
    const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...Object.values(fields), id);
    sendJson(res, 200, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  },

  // DELETE /api/tasks/:id
  async 'DELETE /api/tasks/:id'(req, res, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: `记录不存在: ${id}` });
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    // 删除必须留痕：否则任务"凭空消失"，事后查不到是谁删的
    logEvent('task.remove', {
      actor: 'web',
      task_id: Number(id),
      project_id: row.project_id,
      detail: row.title,
    });
    sendJson(res, 200, { id });
  },

  // GET /api/tasks/:id/tracks  —— 某任务的全部跟踪记录（按 id 升序）
  async 'GET /api/tasks/:id/tracks'(req, res, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: `记录不存在: ${id}` });
    const rows = db
      .prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id ASC')
      .all(id);
    sendJson(res, 200, rows);
  },

  // POST /api/tasks/:id/tracks  —— 新增一条跟踪记录  body: {content}
  async 'POST /api/tasks/:id/tracks'(req, res, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: `记录不存在: ${id}` });
    const b = await readBody(req);
    if (!b.content || !String(b.content).trim()) {
      return sendJson(res, 400, { error: 'content 不能为空' });
    }
    const info = db
      .prepare('INSERT INTO task_tracks(task_id, content, created_at) VALUES(?,?,?)')
      .run(id, String(b.content).trim(), now());
    sendJson(res, 201, db.prepare('SELECT * FROM task_tracks WHERE id = ?').get(info.lastInsertRowid));
  },

  // DELETE /api/tracks/:id  —— 删除一条跟踪记录
  async 'DELETE /api/tracks/:id'(req, res, id) {
    db.prepare('DELETE FROM task_tracks WHERE id = ?').run(id);
    sendJson(res, 200, { id });
  },

  /* --------------------- agent 联动：认领 / 租约 / 结果 --------------------- */

  // POST /api/tasks/next  —— 取下一个可做任务并原子认领
  //   body: {project_id|project?, agent?, lease?: "30m", statuses?: ["todo"]}
  async 'POST /api/tasks/next'(req, res) {
    const b = await readBody(req);
    let pid = b.project_id;
    if (pid === undefined && b.project) {
      const p = db.prepare('SELECT id FROM projects WHERE name = ?').get(String(b.project));
      if (!p) return sendErr(res, 404, 'NOT_FOUND', `项目不存在: ${b.project}`);
      pid = p.id;
    }
    if (pid === undefined) {
      const def = db.prepare("SELECT value FROM meta WHERE key = 'default_project'").get();
      pid = def ? Number(def.value) : db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get()?.id;
    }
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(pid));
    if (!proj) return sendErr(res, 404, 'NOT_FOUND', `项目不存在: ${pid}`);
    const agent = b.agent ? String(b.agent) : 'agent';
    const lease = parseDuration(b.lease ?? b.lease_ms, DEFAULT_LEASE_MS);
    const statuses = Array.isArray(b.statuses) && b.statuses.length ? b.statuses : ['todo'];
    const t = nextTask(proj.id, agent, lease, statuses);
    if (!t) return sendErr(res, 404, 'NO_TASK', `项目 "${proj.name}" 当前没有可认领的任务`);
    sendJson(res, 200, {
      ...t,
      project_name: proj.name,
      tracks: db.prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id').all(t.id),
    });
  },

  // POST /api/tasks/:id/claim  —— 认领指定任务（并发安全，冲突返回 409）
  async 'POST /api/tasks/:id/claim'(req, res, id) {
    const b = await readBody(req);
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id))
      return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    const res2 = claimTask(id, b.agent ? String(b.agent) : 'agent', parseDuration(b.lease ?? b.lease_ms));
    if (!res2.ok) {
      const http = res2.code === 'CONFLICT' ? 409 : 400;
      return sendErr(res, http, res2.code, res2.message, res2.data);
    }
    sendJson(res, 200, res2.data);
  },

  // POST /api/tasks/:id/heartbeat  —— 续租（未认领时等价于认领）
  async 'POST /api/tasks/:id/heartbeat'(req, res, id) {
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    const agent = b.agent ? String(b.agent) : 'agent';
    if (!row.assignee) {
      const r = claimTask(id, agent, parseDuration(b.lease ?? b.lease_ms));
      if (!r.ok) return sendErr(res, r.code === 'CONFLICT' ? 409 : 400, r.code, r.message, r.data);
      return sendJson(res, 200, r.data);
    }
    if (b.agent && row.assignee !== String(b.agent))
      return sendErr(res, 409, 'CONFLICT', `任务 #${id} 当前由 "${row.assignee}" 持有`);
    const ts = now();
    const lease = parseDuration(b.lease ?? b.lease_ms);
    db.prepare('UPDATE tasks SET lease_until = ?, updated_at = ? WHERE id = ?').run(ts + lease, ts, id);
    sendJson(res, 200, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  },

  // POST /api/tasks/:id/release  —— 放弃任务，回到待办
  async 'POST /api/tasks/:id/release'(req, res, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    const ts = now();
    db.prepare(
      "UPDATE tasks SET status = 'todo', assignee = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?"
    ).run(ts, id);
    addTrack(id, '[系统] 任务已被释放，回到待办', ts);
    logEvent('task.release', { actor: row.assignee || 'web', task_id: id, project_id: row.project_id });
    sendJson(res, 200, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  },

  // POST /api/tasks/:id/done  —— 完成  body: {result?, agent?}
  async 'POST /api/tasks/:id/done'(req, res, id) {
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    if (b.agent && row.assignee && row.assignee !== String(b.agent))
      return sendErr(res, 409, 'CONFLICT', `任务 #${id} 当前由 "${row.assignee}" 持有`);
    const agent = b.agent ? String(b.agent) : row.assignee || 'agent';
    const ts = now();
    db.prepare("UPDATE tasks SET status = 'done', result = ?, assignee = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(
      b.result ? String(b.result) : '',
      row.assignee || agent,
      ts,
      id
    );
    addTrack(id, `[${agent}] ${b.result ? `完成：${b.result}` : '完成'}`, ts);
    logEvent('task.done', { actor: agent, task_id: id, project_id: row.project_id, detail: b.result || '' });
    sendJson(res, 200, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  },

  // POST /api/tasks/:id/fail  —— 失败计数  body: {error?, max?, retry?}
  async 'POST /api/tasks/:id/fail'(req, res, id) {
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    if (b.agent && row.assignee && row.assignee !== String(b.agent))
      return sendErr(res, 409, 'CONFLICT', `任务 #${id} 当前由 "${row.assignee}" 持有`);
    const agent = b.agent ? String(b.agent) : row.assignee || 'agent';
    const attempts = (row.attempts || 0) + 1;
    const max = Number.isInteger(Number(b.max)) ? Number(b.max) : 3;
    const err = b.error ? String(b.error) : '（未提供 error 详情）';
    const retry = b.retry === false ? false : attempts < max;
    const ts = now();
    db.prepare(
      'UPDATE tasks SET status = ?, attempts = ?, last_error = ?, assignee = ?, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?'
    ).run(retry ? 'todo' : 'blocked', attempts, err, retry ? null : row.assignee || agent, ts, id);
    addTrack(id, `[${agent}] 第 ${attempts} 次失败：${err}`, ts);
    logEvent('task.fail', {
      actor: agent,
      task_id: id,
      project_id: row.project_id,
      detail: `第 ${attempts} 次：${err}`,
    });
    sendJson(res, 200, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  },

  /* ----------------------------- 依赖（DAG） ----------------------------- */

  // GET /api/tasks/:id/deps
  async 'GET /api/tasks/:id/deps'(req, res, id) {
    const row = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id);
    if (!row) return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    sendJson(
      res,
      200,
      db
        .prepare(
          `SELECT d.depends_on_id AS id, t.code, t.title, t.status
             FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
            WHERE d.task_id = ? ORDER BY d.depends_on_id`
        )
        .all(id)
    );
  },

  // POST /api/tasks/:id/deps  —— body: {depends_on}
  async 'POST /api/tasks/:id/deps'(req, res, id) {
    const b = await readBody(req);
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id))
      return sendErr(res, 404, 'NOT_FOUND', `记录不存在: ${id}`);
    const depId = Number(b.depends_on);
    if (!Number.isInteger(depId)) return sendErr(res, 400, 'USAGE', 'depends_on 必须是任务 id');
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(depId))
      return sendErr(res, 404, 'NOT_FOUND', `依赖任务不存在: ${depId}`);
    if (depWouldCycle(id, depId))
      return sendErr(res, 400, 'INVALID_DEP', `会形成循环依赖: #${id} → #${depId}`);
    if (db.prepare('SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ?').get(id, depId))
      return sendErr(res, 409, 'EXISTS', `依赖已存在: #${id} → #${depId}`);
    db.prepare('INSERT INTO task_deps(task_id, depends_on_id, created_at) VALUES(?,?,?)').run(id, depId, now());
    logEvent('task.dep.add', { actor: b.agent || 'web', task_id: id, detail: `依赖 #${depId}` });
    sendJson(res, 201, { task_id: id, depends_on_id: depId });
  },

  // DELETE /api/tasks/:id/deps/:dep
  async 'DELETE /api/tasks/:id/deps/:dep'(req, res, id, depId) {
    const info = db.prepare('DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?').run(id, depId);
    if (info.changes !== 1) return sendErr(res, 404, 'NOT_FOUND', `依赖不存在: #${id} → #${depId}`);
    sendJson(res, 200, { task_id: id, depends_on_id: depId });
  },

  // GET /api/activity  —— 审计事件流水（?limit=&kind=&task=&actor=）
  //   注意：SSE 事件流占用的是 /api/events，两者不同
  async 'GET /api/activity'(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const where = [];
    const params = [];
    const kind = u.searchParams.get('kind');
    const task = u.searchParams.get('task');
    const actor = u.searchParams.get('actor');
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (task) {
      where.push('task_id = ?');
      params.push(Number(task));
    }
    if (actor) {
      where.push('actor = ?');
      params.push(actor);
    }
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
    sendJson(
      res,
      200,
      db
        .prepare(
          `SELECT * FROM events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
        )
        .all(...params, limit)
    );
  },

  // GET /api/projects/:id/ready  —— 可开工任务（依赖已就绪 + 无人认领），只观察不认领
  async 'GET /api/projects/:id/ready'(req, res, id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) return sendErr(res, 404, 'NOT_FOUND', `项目不存在: ${id}`);
    const rows = db
      .prepare(
        `SELECT * FROM tasks WHERE project_id = ? AND status = 'todo' AND (assignee IS NULL OR assignee = '')
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, position, id`
      )
      .all(id);
    sendJson(
      res,
      200,
      rows.filter((r) => pendingDeps(r.id).length === 0)
    );
  },

  /* ----------------------------- 事件流（SSE） ----------------------------- */

  /**
   * GET /api/events  —— 数据变化时推送（事件驱动，不是定时刷新）
   *   - 服务端按 interval 探测一次数据版本号，只有变化才推 changed；没变化只发心跳注释
   *   - 探测能覆盖 CLI / MCP / Web 三端的写入（都落在同一个 SQLite 文件上）
   *   - changed 里带 changes 摘要（增量审计事件），前端可只刷新相关的看板
   *   - interval：?interval=2000 或环境变量 TASKCLI_SSE_INTERVAL_MS，默认 1000ms，范围 300~10000
   */
  async 'GET /api/events'(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const raw = Number(u.searchParams.get('interval')) || Number(process.env.TASKCLI_SSE_INTERVAL_MS) || 1000;
    const intervalMs = Math.min(Math.max(raw, 300), 10000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);

    const maxEventId = () => db.prepare('SELECT COALESCE(MAX(id),0) m FROM events').get().m;
    const eventsSince = (id) =>
      db
        .prepare('SELECT id, ts, kind, actor, task_id, project_id FROM events WHERE id > ? ORDER BY id LIMIT 50')
        .all(id);

    let last = revision();
    let lastEventId = maxEventId();
    res.write(
      `event: init\ndata: ${JSON.stringify({ revision: last, intervalMs, at: Date.now() })}\n\n`
    );

    let idleTicks = 0; // 连续无变化的探测次数，用于降低心跳频率
    const timer = setInterval(() => {
      try {
        const cur = revision();
        if (cur !== last) {
          last = cur;
          const changes = eventsSince(lastEventId);
          if (changes.length) lastEventId = changes[changes.length - 1].id;
          idleTicks = 0;
          res.write(
            `event: changed\ndata: ${JSON.stringify({ revision: cur, at: Date.now(), changes })}\n\n`
          );
        } else {
          idleTicks += 1;
          // 空闲时才发心跳（约每 15s 一次），避免无变化时每秒写一行
          if (idleTicks * intervalMs >= 15000) {
            idleTicks = 0;
            res.write(': ping\n\n');
          }
        }
      } catch {
        clearInterval(timer);
      }
    }, intervalMs);

    const stop = () => clearInterval(timer);
    req.on('close', stop);
    res.on('close', stop);
  },
};

/* ----------------------------- 路由 ----------------------------- */

/**
 * 缓存策略：前端构建产物带内容 hash（index-xxxx.js），文件名变了就是内容变了，
 * 所以资源可以长缓存；但 index.html 绝不能缓存，否则浏览器会拿旧的 HTML 去引用
 * 已经不存在的旧 JS（表现为"刷新了但改动没生效"）。
 * 之前两类都没发 Cache-Control，浏览器自行 heuristic 缓存，正是踩这个坑的根因。
 */
function cacheControlFor(ext) {
  if (ext === '.html') return 'no-cache, must-revalidate';
  if ('.js .css .woff .woff2 .ttf .svg .png .jpg .jpeg .gif .webp'.split(' ').includes(ext)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback：无扩展名的导航请求（如 "/"）回退到 index.html
      if (!path.extname(urlPath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Not Found');
          }
          res.writeHead(200, {
            'Content-Type': MIME['.html'],
            'Cache-Control': cacheControlFor('.html'),
          });
          return res.end(req.method === 'HEAD' ? undefined : d2);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(ext),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = req.url.split('?')[0];

    // 精确匹配 API
    const key = `${req.method} ${urlPath}`;
    if (api[key]) return await api[key](req, res);

    // 带参数的 API（:id）
    const patterns = [
      ['PATCH', /^\/api\/projects\/(\d+)$/, 'PATCH /api/projects/:id'],
      ['DELETE', /^\/api\/projects\/(\d+)$/, 'DELETE /api/projects/:id'],
      ['GET', /^\/api\/projects\/(\d+)\/tasks$/, 'GET /api/projects/:id/tasks'],
      ['POST', /^\/api\/projects\/(\d+)\/tasks$/, 'POST /api/projects/:id/tasks'],
      ['PATCH', /^\/api\/tasks\/(\d+)$/, 'PATCH /api/tasks/:id'],
      ['DELETE', /^\/api\/tasks\/(\d+)$/, 'DELETE /api/tasks/:id'],
      ['GET', /^\/api\/tasks\/(\d+)\/tracks$/, 'GET /api/tasks/:id/tracks'],
      ['POST', /^\/api\/tasks\/(\d+)\/tracks$/, 'POST /api/tasks/:id/tracks'],
      ['DELETE', /^\/api\/tracks\/(\d+)$/, 'DELETE /api/tracks/:id'],
      // agent 联动
      ['POST', /^\/api\/tasks\/(\d+)\/claim$/, 'POST /api/tasks/:id/claim'],
      ['POST', /^\/api\/tasks\/(\d+)\/heartbeat$/, 'POST /api/tasks/:id/heartbeat'],
      ['POST', /^\/api\/tasks\/(\d+)\/release$/, 'POST /api/tasks/:id/release'],
      ['POST', /^\/api\/tasks\/(\d+)\/done$/, 'POST /api/tasks/:id/done'],
      ['POST', /^\/api\/tasks\/(\d+)\/fail$/, 'POST /api/tasks/:id/fail'],
      ['GET', /^\/api\/tasks\/(\d+)\/deps$/, 'GET /api/tasks/:id/deps'],
      ['POST', /^\/api\/tasks\/(\d+)\/deps$/, 'POST /api/tasks/:id/deps'],
      ['DELETE', /^\/api\/tasks\/(\d+)\/deps\/(\d+)$/, 'DELETE /api/tasks/:id/deps/:dep'],
      ['GET', /^\/api\/projects\/(\d+)\/ready$/, 'GET /api/projects/:id/ready'],
    ];
    for (const [method, re, name] of patterns) {
      if (req.method !== method) continue;
      const m = urlPath.match(re);
      if (m) return await api[name](req, res, ...m.slice(1).map(Number));
    }

    if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'API 不存在' });

    // 其余走静态文件。HEAD 与 GET 同路径同头（只省掉响应体），
    // 便于用 curl -I / 开发者工具核对 Cache-Control。
    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`taskcli web 已启动: http://${HOST}:${PORT}\n`);
  process.stdout.write(`数据库: ${require('../src/db').resolveDbPath()}\n`);
  process.stdout.write(`agent 联动: POST /api/tasks/next  ·  SSE /api/events\n`);
});
