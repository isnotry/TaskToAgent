'use strict';

/**
 * MCP server（stdio JSON-RPC 2.0，零依赖）
 *
 * 让支持 MCP 的 agent（CodeBuddy / Claude Desktop / Cline 等）直接以 tool 方式
 * 操作本地看板，而不必拼接 shell 命令。与 CLI、网页共用同一份 SQLite。
 *
 * 启动：t2a mcp
 * 约束：stdout 只能出现 JSON-RPC 消息，日志/警告一律走 stderr。
 */

// node:sqlite 的实验特性警告会打到 stderr，这里静默，保持 stdout 干净
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning') return;
  process.stderr.write(`Warning: ${w && w.message ? w.message : w}\n`);
});

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
  logEvent,
} = require('./db');

const { buildTaskReport, buildProjectReport, buildDeliverables } = require('./report');
// 握手即把协作规矩注入客户端上下文（server instructions）
const { INSTRUCTIONS, AUTONOMY_RULE } = require('./agent-guide');
const { normalizeAgent } = require('./config');
const brand = require('./brand');
const brandEnv = brand.env;

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'TaskToAgent', version: '1.1.0' };

/* ----------------------------- 业务辅助 ----------------------------- */

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function die(code, msg) {
  throw new ToolError(code, msg);
}

function resolveProject(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref)) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
  }
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(String(ref)) || null;
}

function activeProject(ref) {
  if (ref) {
    const p = resolveProject(ref);
    if (!p) die('NOT_FOUND', `项目不存在: ${ref}`);
    return p;
  }
  if (brandEnv('PROJECT')) {
    const p = resolveProject(brandEnv('PROJECT'));
    if (p) return p;
  }
  const def = db.prepare("SELECT value FROM meta WHERE key = 'default_project'").get();
  if (def) {
    const p = resolveProject(def.value);
    if (p) return p;
  }
  const all = db.prepare('SELECT * FROM projects ORDER BY id').all();
  if (all.length === 1) return all[0];
  if (!all.length) die('NOT_FOUND', '还没有任何项目，请先调用 project_add');
  die('USAGE', `存在多个项目，请传 project 参数（现有: ${all.map((p) => p.name).join(', ')}）`);
}

function taskRow(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) die('USAGE', 'id 必须是整数');
  return (
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(n) ||
    die('NOT_FOUND', `记录不存在: ${n}`)
  );
}

function withTracks(row, projectName) {
  return {
    ...row,
    project_name: projectName,
    tracks: db.prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id').all(row.id),
  };
}

function setDefaultIfFirst(id) {
  const total = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  if (total === 1) {
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('default_project',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(id));
  }
}

/**
 * MCP 场景下的身份由「服务端配置」决定，不采信模型传入的 agent：
 * agent 名字总被填错（一律 codebuddy），与其提示不如直接强制。
 * 需要允许覆盖时设 T2A_MCP_ALLOW_AGENT_ARG=1。
 */
const SERVER_AGENT =
  normalizeAgent(brandEnv('AGENT') || require('./config').load().agent || 'mcp').name ||
  'mcp';

function agentOf(a) {
  if (brandEnv('MCP_ALLOW_AGENT_ARG') === '1' && a && String(a.agent || '').trim()) {
    return normalizeAgent(String(a.agent).trim()).name;
  }
  return SERVER_AGENT;
}

/* ----------------------------- 工具实现 ----------------------------- */

const TOOLS = {
  project_list: {
    description: '列出所有看板（含任务数）',
    schema: { type: 'object', properties: {} },
    run: () =>
      db
        .prepare('SELECT * FROM projects ORDER BY id')
        .all()
        .map((r) => ({
          ...r,
          task_count: db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id = ?').get(r.id).c,
        })),
  },

  project_add: {
    description: '新建看板',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name'],
    },
    run: (a) => {
      const name = String(a.name).trim();
      if (db.prepare('SELECT id FROM projects WHERE name = ?').get(name))
        die('EXISTS', `项目已存在: ${name}`);
      const t = now();
      const info = db
        .prepare('INSERT INTO projects(name, description, created_at, updated_at) VALUES(?,?,?,?)')
        .run(name, a.description || '', t, t);
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
      setDefaultIfFirst(row.id);
      logEvent('project.add', { actor: agentOf(a.agent), project_id: row.id, detail: name });
      return row;
    },
  },

  task_list: {
    description: '列出某看板的任务（可按状态过滤）',
    schema: {
      type: 'object',
      properties: { project: { type: 'string' }, status: { type: 'string' } },
    },
    run: (a) => {
      const p = activeProject(a.project);
      if (a.status)
        return db
          .prepare('SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY position, id')
          .all(p.id, String(a.status));
      return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, id').all(p.id);
    },
  },

  task_show: {
    description: '查看单条任务详情（含执行日志）',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: (a) => {
      const row = taskRow(a.id);
      const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id);
      return withTracks(row, p ? p.name : '');
    },
  },

  task_search: {
    description: '全局模糊搜索（编号/标题/内容/项目名，空格分隔多关键词为 AND）',
    schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    run: (a) => {
      const tokens = String(a.q).toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) return [];
      const cond = tokens
        .map(() => '(LOWER(t.code) LIKE ? OR LOWER(t.title) LIKE ? OR LOWER(t.content) LIKE ? OR LOWER(p.name) LIKE ?)')
        .join(' AND ');
      const params = [];
      for (const tk of tokens) {
        const like = `%${tk}%`;
        params.push(like, like, like, like);
      }
      return db
        .prepare(
          `SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE ${cond} ORDER BY t.updated_at DESC`
        )
        .all(...params);
    },
  },

  task_add: {
    description: '新增任务（支持 key 幂等，重复调用不会重复创建）',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        project: { type: 'string' },
        content: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string' },
        key: { type: 'string', description: '幂等键' },
      },
      required: ['title'],
    },
    run: (a) => {
      const p = activeProject(a.project);
      const key = a.key ? String(a.key) : null;
      if (key) {
        const dup = db.prepare('SELECT * FROM tasks WHERE external_key = ?').get(key);
        if (dup) return dup;
      }
      const t = now();
      const pos = db.prepare('SELECT COALESCE(MAX(position),0) m FROM tasks WHERE project_id = ?').get(p.id).m + 1;
      const info = db
        .prepare(
          `INSERT INTO tasks(project_id, code, title, content, status, priority, position, created_at, updated_at, external_key)
           VALUES(?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          p.id,
          genTaskCode(),
          String(a.title),
          a.content || '',
          a.status || 'todo',
          a.priority || 'normal',
          pos,
          t,
          t,
          key
        );
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
      logEvent('task.add', { actor: agentOf(a.agent), task_id: row.id, project_id: p.id, detail: row.title });
      return row;
    },
  },

  task_update: {
    description: '更新任务字段（title/content/status/priority/project_id/result/last_error）',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        content: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string' },
        project_id: { type: 'integer' },
        result: { type: 'string' },
        last_error: { type: 'string' },
      },
      required: ['id'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const fields = {};
      for (const k of ['title', 'content', 'status', 'priority', 'project_id', 'result', 'last_error']) {
        if (a[k] !== undefined) fields[k] = k === 'project_id' ? Number(a[k]) : String(a[k]);
      }
      if (!Object.keys(fields).length) die('USAGE', '没有可更新的字段');
      fields.updated_at = now();
      const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...Object.values(fields), row.id);
      logEvent('task.update', {
        actor: agentOf(a.agent),
        task_id: row.id,
        project_id: row.project_id,
        detail: Object.keys(fields).filter((k) => k !== 'updated_at').join(','),
      });
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    },
  },

  task_next: {
    description: '取下一个「依赖已就绪且无人认领」的任务并原子认领（返回任务+项目名+历史日志）。没有任务时返回 NO_TASK',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        agent: { type: 'string' },
        lease: { type: 'string', description: '租约时长，如 30m / 2h / 90s' },
        statuses: { type: 'array', items: { type: 'string' }, description: '候选状态，默认 [todo]' },
      },
    },
    run: (a) => {
      const p = activeProject(a.project);
      const agent = agentOf(a.agent);
      const t = nextTask(p.id, agent, parseDuration(a.lease, DEFAULT_LEASE_MS), a.statuses || ['todo']);
      if (!t) die('NO_TASK', `项目 "${p.name}" 当前没有可认领的任务`);
      return { ...withTracks(t, p.name), hint: AUTONOMY_RULE };
    },
  },

  task_claim: {
    description: '认领指定任务；已被他人持有且租约未过期时返回 CONFLICT',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, agent: { type: 'string' }, lease: { type: 'string' } },
      required: ['id'],
    },
    run: (a) => {
      const id = Number(a.id);
      const res = claimTask(id, agentOf(a.agent), parseDuration(a.lease, DEFAULT_LEASE_MS));
      if (!res.ok) die(res.code, res.message);
      return res.data;
    },
  },

  task_heartbeat: {
    description: '续租（长任务定期调用，防止被判定中断而回收）；未认领时等价于认领',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, agent: { type: 'string' }, lease: { type: 'string' } },
      required: ['id'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const agent = agentOf(a.agent);
      if (!row.assignee) {
        const res = claimTask(row.id, agent, parseDuration(a.lease, DEFAULT_LEASE_MS));
        if (!res.ok) die(res.code, res.message);
        return res.data;
      }
      if (a.agent && row.assignee !== String(a.agent)) die('CONFLICT', `任务 #${row.id} 当前由 "${row.assignee}" 持有`);
      const ts = now();
      db.prepare('UPDATE tasks SET lease_until = ?, updated_at = ? WHERE id = ?').run(
        ts + parseDuration(a.lease, DEFAULT_LEASE_MS),
        ts,
        row.id
      );
      logEvent('task.heartbeat', { actor: agent, task_id: row.id, project_id: row.project_id });
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    },
  },

  task_release: {
    description: '放弃任务，回到待办并清空认领信息',
    schema: { type: 'object', properties: { id: { type: 'integer' }, agent: { type: 'string' } }, required: ['id'] },
    run: (a) => {
      const row = taskRow(a.id);
      const ts = now();
      db.prepare(
        "UPDATE tasks SET status = 'todo', assignee = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?"
      ).run(ts, row.id);
      addTrack(row.id, `[系统] ${agentOf(a.agent)} 释放了任务，回到待办`, ts);
      logEvent('task.release', { actor: agentOf(a.agent), task_id: row.id, project_id: row.project_id });
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    },
  },

  task_done: {
    description: '标记完成，可附带产出说明',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, result: { type: 'string' }, agent: { type: 'string' } },
      required: ['id'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const agent = agentOf(a.agent);
      if (a.agent && row.assignee && row.assignee !== String(a.agent))
        die('CONFLICT', `任务 #${row.id} 当前由 "${row.assignee}" 持有`);
      const ts = now();
      db.prepare("UPDATE tasks SET status = 'done', result = ?, assignee = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(
        a.result ? String(a.result) : '',
        row.assignee || agent,
        ts,
        row.id
      );
      addTrack(row.id, `[${agent}] ${a.result ? `完成：${a.result}` : '完成'}`, ts);
      logEvent('task.done', { actor: agent, task_id: row.id, project_id: row.project_id, detail: a.result || '' });
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    },
  },

  task_fail: {
    description: '记录失败并计数；未达 max（默认 3）回待办重试，超限转 blocked 等人工',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        error: { type: 'string' },
        max: { type: 'integer' },
        retry: { type: 'boolean' },
        agent: { type: 'string' },
      },
      required: ['id'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const agent = agentOf(a.agent);
      if (a.agent && row.assignee && row.assignee !== String(a.agent))
        die('CONFLICT', `任务 #${row.id} 当前由 "${row.assignee}" 持有`);
      const attempts = (row.attempts || 0) + 1;
      const max = Number.isInteger(Number(a.max)) ? Number(a.max) : 3;
      const err = a.error ? String(a.error) : '（未提供 error 详情）';
      const retry = a.retry === false ? false : attempts < max;
      const ts = now();
      db.prepare(
        `UPDATE tasks SET status = ?, attempts = ?, last_error = ?, assignee = ?, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`
      ).run(retry ? 'todo' : 'blocked', attempts, err, retry ? null : row.assignee || agent, ts, row.id);
      addTrack(row.id, `[${agent}] 第 ${attempts} 次失败：${err}`, ts);
      logEvent('task.fail', { actor: agent, task_id: row.id, project_id: row.project_id, detail: `第 ${attempts} 次：${err}` });
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    },
  },

  task_log: {
    description: '给任务写一条执行日志',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, content: { type: 'string' }, agent: { type: 'string' } },
      required: ['id', 'content'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const actor = agentOf(a.agent);
      const tr = addTrack(row.id, `[${actor}] ${a.content}`);
      logEvent('task.log', { actor, task_id: row.id, detail: String(a.content).slice(0, 200) });
      return tr;
    },
  },

  task_logs: {
    description: '查看任务的执行日志',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: (a) => {
      const row = taskRow(a.id);
      return db.prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id').all(row.id);
    },
  },

  task_deps: {
    description: '查看任务的依赖（未完成的依赖会阻塞认领）',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: (a) => {
      const row = taskRow(a.id);
      return db
        .prepare(
          `SELECT d.depends_on_id AS id, t.code, t.title, t.status
             FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
            WHERE d.task_id = ? ORDER BY d.depends_on_id`
        )
        .all(row.id);
    },
  },

  task_dep_add: {
    description: '设置依赖：本任务等被依赖任务 done 之后才可认领（自动防环）',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, depends_on: { type: 'integer' }, agent: { type: 'string' } },
      required: ['id', 'depends_on'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const depId = Number(a.depends_on);
      taskRow(depId);
      if (depWouldCycle(row.id, depId)) die('INVALID_DEP', `会形成循环依赖: #${row.id} → #${depId}`);
      if (db.prepare('SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ?').get(row.id, depId))
        die('EXISTS', `依赖已存在: #${row.id} → #${depId}`);
      db.prepare('INSERT INTO task_deps(task_id, depends_on_id, created_at) VALUES(?,?,?)').run(row.id, depId, now());
      logEvent('task.dep.add', { actor: agentOf(a.agent), task_id: row.id, detail: `依赖 #${depId}` });
      return { task_id: row.id, depends_on_id: depId };
    },
  },

  task_dep_rm: {
    description: '移除依赖',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, depends_on: { type: 'integer' }, agent: { type: 'string' } },
      required: ['id', 'depends_on'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const info = db
        .prepare('DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?')
        .run(row.id, Number(a.depends_on));
      if (info.changes !== 1) die('NOT_FOUND', `依赖不存在: #${row.id} → #${a.depends_on}`);
      logEvent('task.dep.rm', { actor: agentOf(a.agent), task_id: row.id, detail: `移除依赖 #${a.depends_on}` });
      return { task_id: row.id, depends_on_id: Number(a.depends_on) };
    },
  },

  task_ready: {
    description: '列出可开工任务（依赖已就绪 + 无人认领），只观察不认领',
    schema: { type: 'object', properties: { project: { type: 'string' } } },
    run: (a) => {
      const p = activeProject(a.project);
      const rows = db
        .prepare(
          `SELECT * FROM tasks WHERE project_id = ? AND status = 'todo' AND (assignee IS NULL OR assignee = '')
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, position, id`
        )
        .all(p.id);
      return rows.filter((r) => pendingDeps(r.id).length === 0);
    },
  },

  task_assign: {
    description: '指定或纠正任务的认领人（写错 agent 名字时用；不动任务状态）',
    schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, agent: { type: 'string' }, force: { type: 'boolean' } },
      required: ['id'],
    },
    run: (a) => {
      const row = taskRow(a.id);
      const agent = agentOf(a.agent);
      if (row.assignee && row.assignee !== agent && !a.force)
        die('CONFLICT', `任务 #${row.id} 已由 "${row.assignee}" 持有，转派请传 force: true`);
      const ts = now();
      db.prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?').run(agent, ts, row.id);
      logEvent('task.assign', {
        actor: agent,
        task_id: row.id,
        project_id: row.project_id,
        detail: `归属从 ${row.assignee || '-'} 改为 ${agent}`,
      });
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    },
  },

  task_report: {
    description: '导出 Markdown 报告（任务 + 执行日志 + 产物 + 依赖），把过程和结果交付给人看',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        task: { type: 'integer' },
        deliverables: { type: 'boolean', description: 'true=只汇总已完成任务的产出' },
        withLogs: { type: 'boolean', description: '是否包含执行日志，默认 true' },
      },
    },
    run: (a) => {
      const opts = { withLogs: a.withLogs !== false };
      if (a.task !== undefined) return { markdown: buildTaskReport(Number(a.task), opts) };
      const p = activeProject(a.project);
      return {
        markdown:
          a.deliverables === true ? buildDeliverables(p.id) : buildProjectReport(p.id, opts),
      };
    },
  },

  events: {
    description: '查看审计事件流水（谁在何时对哪条任务做了什么）',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        kind: { type: 'string' },
        task: { type: 'integer' },
        actor: { type: 'string' },
      },
    },
    run: (a) => {
      const where = [];
      const params = [];
      if (a.kind) {
        where.push('kind = ?');
        params.push(String(a.kind));
      }
      if (a.task !== undefined) {
        where.push('task_id = ?');
        params.push(Number(a.task));
      }
      if (a.actor) {
        where.push('actor = ?');
        params.push(String(a.actor));
      }
      const limit = Number.isInteger(Number(a.limit)) ? Number(a.limit) : 50;
      return db
        .prepare(
          `SELECT * FROM events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
        )
        .all(...params, limit);
    },
  },
};

/* ----------------------------- JSON-RPC ----------------------------- */

function toolsList() {
  return Object.keys(TOOLS).map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: TOOLS[name].schema,
  }));
}

function callTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) die('UNKNOWN_TOOL', `未知工具: ${name}`);
  const data = tool.run(args || {});
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/cancelled':
      return null; // 通知类消息不回包
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolsList() } };
    case 'tools/call':
      try {
        const r = callTool(params && params.name, params && params.arguments);
        return { jsonrpc: '2.0', id, result: r };
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'ERROR';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: e.message } }, null, 2) }],
            isError: true,
          },
        };
      }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法: ${method}` } };
  }
}

function start() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`MCP 解析失败: ${line}\n`);
        continue;
      }
      const res = handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`${brand.PRODUCT} MCP server 已启动（stdio）\n`);
}

module.exports = { start, TOOLS, handle };
