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
const { db, now } = require('../src/db');

const PORT = Number(process.env.TASKCLI_PORT || 3979);
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
    sendJson(res, 200, { id, removedTasks: cnt });
  },

  // GET /api/projects/:id/tasks  —— 某看板全部任务
  async 'GET /api/projects/:id/tasks'(req, res, id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!p) return sendJson(res, 404, { error: `项目不存在: ${id}` });
    const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, id').all(id);
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
        'INSERT INTO tasks(project_id, title, content, status, priority, position, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)'
      )
      .run(id, String(b.title).trim(), b.content || '', b.status || 'todo', b.priority || 'normal', pos, t, t);
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
};

/* ----------------------------- 路由 ----------------------------- */

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
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
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
    ];
    for (const [method, re, name] of patterns) {
      if (req.method !== method) continue;
      const m = urlPath.match(re);
      if (m) return await api[name](req, res, Number(m[1]));
    }

    if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'API 不存在' });

    // 其余走静态文件
    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`taskcli web 已启动: http://localhost:${PORT}\n`);
  process.stdout.write(`数据库: ${require('../src/db').resolveDbPath()}\n`);
});
