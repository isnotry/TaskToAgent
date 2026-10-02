'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 内置上手指南：任何 agent 只要能跑到本 CLI，就能 self-serve 拿到完整玩法
const { GUIDE_TEXT, GUIDE_JSON, ENTRY, AUTONOMY_RULE } = require('./agent-guide');
// 报告：把任务 + 执行日志 + 产物 + 依赖汇总成一份 Markdown 交付物
const { buildTaskReport, buildProjectReport, buildDeliverables } = require('./report');
// Node < 22.13 没有 node:sqlite，这里提前拦截并给修复指引（否则用户只能看模块堆栈）
const sqliteGuard = require('./sqlite-guard');
// 本地配置：默认 agent 身份 + 错误名自动纠正（agent 名字总被填错，靠提示不可靠）
const {
  CONFIG_PATH,
  load: loadConfig,
  save: saveConfig,
  normalizeAgent,
  defaultAgent,
} = require('./config');

// node:sqlite 在 Node 22 仍是实验特性，会在 stderr 打印 ExperimentalWarning。
// 该警告不影响 stdout 的 JSON 解析，这里移除默认打印器并自行过滤，保持 agent 输出干净。
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
  reclaimExpired,
  claimTask,
  nextTask,
  depWouldCycle,
  logEvent,
  resolveDbPath,
} = require('./db');

/* ------------------------- 退出码与错误契约 ------------------------- */

/**
 * agent 友好的退出码：不用解析文本就能判断该怎么处理。
 *  0 OK            成功
 *  1 ERROR         业务/运行时错误（不存在、参数非法…）
 *  2 NO_TASK       没有可执行的任务（task next / task ready 为空）
 *  3 CONFLICT      认领冲突（已被别人持有且租约未过期）
 *  4 USAGE         用法错误
 *  5 CONFIRM       需要显式 --yes 确认
 */
const EXIT = { OK: 0, ERROR: 1, NO_TASK: 2, CONFLICT: 3, USAGE: 4, CONFIRM: 5 };

class CliError extends Error {
  constructor(code, message, exit = EXIT.ERROR, hint) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

/* ----------------------------- 参数解析 ----------------------------- */

/**
 * 参数解析：
 *   --key=value  -> options.key = 'value'（值里可含空格或以 - 开头，agent 传长文本首选此写法）
 *   --key value  -> options.key = 'value'
 *   --flag       -> options.flag = true
 *   其余          -> positionals[]
 */
function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
      const next = argv[i + 1];
      // 只有形如 --xxx（后面跟字母）才当作下一个选项；负数、"-" 之类视为值
      const nextIsFlag = next !== undefined && /^--[A-Za-z]/.test(next);
      if (next === undefined || nextIsFlag) {
        options[key] = true;
      } else {
        options[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, options };
}

/* ----------------------------- 输出辅助 ----------------------------- */

// 是否处于 --json 模式（错误输出也要遵守同一契约）
let JSON_MODE = false;

/**
 * 统一成功输出：
 *   --json  -> {"ok":true,"data":...}
 *   人类态  -> 原表格/文本
 */
/**
 * hint：可选的「下一步该干什么」提示。
 * 让 agent 在踩空（没有任务、没认领就改状态…）时能被就地引导，而不是卡住。
 */
function out(json, data, human, hint) {
  if (json) {
    const payload = { ok: true, data: data === undefined ? null : data };
    if (hint) payload.hint = hint;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    if (human) process.stdout.write(human + '\n');
    if (hint) process.stdout.write(`提示: ${hint}\n`);
  }
}

function fail(msg, code = 'ERROR', exit = EXIT.ERROR, hint) {
  throw new CliError(code, msg, exit, hint);
}

/** 「没有任务」的统一提示，任何入口复用，保证引导口径一致 */
const HINT_NO_TASK =
  '没有可认领的任务。可以：① taskcli project list 换一个看板；② taskcli task add "<标题>" --project <看板> 新建；③ taskcli task ready 看是否有依赖未完成或被他人认领的项。';

/** 用法/参数错误：退出码 4 */
function usageError(msg) {
  return fail(msg, 'USAGE', EXIT.USAGE);
}

/** 破坏性操作缺少 --yes：退出码 5 */
function confirmError(msg) {
  return fail(msg, 'CONFIRM_REQUIRED', EXIT.CONFIRM);
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** 终端显示宽度（CJK 全角按 2 列算），用于表格对齐 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (
      c <= 0x115f ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    )) ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右侧补空格 */
function padDisp(s, n) {
  s = String(s == null ? '' : s);
  const w = dispWidth(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ----------------------------- 项目解析 ----------------------------- */

function resolveProject(ref) {
  if (ref === undefined) return null;
  const id = Number(ref);
  let row;
  if (Number.isInteger(id) && String(id) === String(ref)) {
    row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  } else {
    row = db.prepare('SELECT * FROM projects WHERE name = ?').get(ref);
  }
  return row || null;
}

function getActiveProject(options) {
  if (options.project) {
    const p = resolveProject(options.project);
    if (!p) fail(`项目不存在: ${options.project}`);
    return p;
  }
  if (process.env.TASKCLI_PROJECT) {
    const p = resolveProject(process.env.TASKCLI_PROJECT);
    if (p) return p;
  }
  const def = db.prepare("SELECT value FROM meta WHERE key = 'default_project'").get();
  if (def) {
    const p = resolveProject(def.value);
    if (p) return p;
  }
  const all = db.prepare('SELECT * FROM projects ORDER BY id').all();
  if (all.length === 1) return all[0];
  if (all.length === 0) fail('还没有任何项目，请先用 `taskcli project add <名称>` 创建');
  fail('存在多个项目，请通过 --project <名称> 指定，或用 `taskcli project` 设置默认');
}

function setDefaultProject(id) {
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('default_project',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(id));
}

/* ----------------------------- project 命令 ----------------------------- */

function handleProject(action, args, options, json) {
  const ref = args[0];
  switch (action) {
    case 'list':
    case 'ls': {
      const rows = db.prepare('SELECT * FROM projects ORDER BY id').all();
      if (json) return out(json, rows);
      if (rows.length === 0) return out(json, [], '(无项目)');
      const header = pad('ID', 5) + pad('NAME', 20) + pad('TASKS', 6) + 'UPDATED';
      const lines = [header, '-'.repeat(header.length)];
      for (const r of rows) {
        const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id = ?').get(r.id).c;
        lines.push(pad(r.id, 5) + pad(r.name, 20) + pad(cnt, 6) + fmtTime(r.updated_at));
      }
      return out(json, rows, lines.join('\n'));
    }
    case 'add':
    case 'new': {
      if (!ref) usageError('用法: taskcli project add <名称> [--desc <描述>]');
      const exists = db.prepare('SELECT id FROM projects WHERE name = ?').get(ref);
      if (exists) fail(`项目已存在: ${ref}`);
      const t = now();
      const info = db.prepare('INSERT INTO projects(name, description, created_at, updated_at) VALUES(?,?,?,?)').run(
        ref,
        options.desc || '',
        t,
        t
      );
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
      // 第一个项目自动设为默认，方便后续免 --project 调用
      const total = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
      if (total === 1) setDefaultProject(row.id);
      logEvent('project.add', { actor: currentAgent(options), project_id: row.id, detail: row.name });
      return out(json, row, `已创建项目 #${row.id} "${row.name}"`);
    }
    case 'rename': {
      const newName = args[1];
      if (!ref || !newName) usageError('用法: taskcli project rename <id|名称> <新名称>');
      const p = resolveProject(ref) || fail(`项目不存在: ${ref}`);
      db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(newName, now(), p.id);
      return out(json, { id: p.id, name: newName }, `项目 #${p.id} 已重命名为 "${newName}"`);
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      if (!ref) usageError('用法: taskcli project remove <id|名称> [--yes]');
      const p = resolveProject(ref) || fail(`项目不存在: ${ref}`);
      const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id = ?').get(p.id).c;
      if (!options.yes) {
        confirmError(`将删除项目 "${p.name}" 及其下 ${cnt} 条记录。请追加 --yes 确认删除。`);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
      // 若删除的是默认项目，清理默认
      const def = db.prepare("SELECT value FROM meta WHERE key='default_project'").get();
      if (def && Number(def.value) === p.id) db.prepare("DELETE FROM meta WHERE key='default_project'").run();
      logEvent('project.remove', {
        actor: currentAgent(options),
        project_id: p.id,
        detail: `${p.name}（连带 ${cnt} 条任务）`,
      });
      return out(json, { id: p.id, removedTasks: cnt }, `已删除项目 "${p.name}" 及其 ${cnt} 条记录`);
    }
    default:
      throw new CliError('UNKNOWN_ACTION', `未知 project 动作: ${action || '(空)'}`, EXIT.USAGE);
  }
}

/* ----------------------------- task 命令 ----------------------------- */

// 最近一次身份是否被别名纠正过（用于在认领类命令里提示）
let lastAgentNote = '';

/** 当前 agent 身份：--agent > 环境变量 TASKCLI_AGENT > 配置 agent > 'agent'，最后过一遍别名纠正 */
function currentAgent(options) {
  const o = options || {};
  let a;
  if (o.agent !== undefined && o.agent !== true && String(o.agent).trim()) a = String(o.agent).trim();
  else a = defaultAgent();
  const n = normalizeAgent(a);
  if (n.corrected) {
    lastAgentNote = `身份 "${n.from}" 已按配置纠正为 "${n.name}"（改配置：taskcli config alias <错名> <正名>）。`;
  }
  return n.name;
}

/** 认领类命令的提示：身份纠正说明 + 后续规矩 */
function agentHint(extra) {
  const parts = [];
  if (lastAgentNote) parts.push(lastAgentNote);
  if (extra) parts.push(extra);
  return parts.length ? parts.join(' ') : undefined;
}

function requireTask(id) {
  if (!Number.isInteger(id)) usageError('任务 id 必须是整数');
  return (
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ||
    fail(`记录不存在: ${id}`, 'NOT_FOUND', EXIT.ERROR)
  );
}

/**
 * 归属校验：显式传了 --agent 且任务已被别的 agent 持有时拒绝操作，
 * 避免 A 把 B 正在跑的任务关掉/改状态。
 */
function checkOwner(row, options) {
  const agent = options.agent;
  if (agent !== undefined && agent !== true && row.assignee && row.assignee !== String(agent)) {
    fail(
      `任务 #${row.id} 当前由 "${row.assignee}" 持有，不能由 "${agent}" 操作（先 release，或去掉 --agent 强制操作）`,
      'CONFLICT',
      EXIT.CONFLICT
    );
  }
}

function fmtLease(ms) {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function readStdin() {
  if (process.stdin.isTTY)
    usageError('批量模式需要从管道读取 JSON，例如: echo \'[{"title":".."}]\' | taskcli task add --project X --batch');
  return fs.readFileSync(0, 'utf8');
}

function handleTask(action, args, options, json) {
  switch (action) {
    case 'list':
    case 'ls': {
      const p = getActiveProject(options);
      let rows;
      if (options.status) {
        rows = db
          .prepare('SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY position, id')
          .all(p.id, options.status);
      } else {
        rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, id').all(p.id);
      }
      if (json) return out(json, rows);
      if (rows.length === 0) return out(json, [], `(项目 "${p.name}" 暂无记录)`);
      const header = pad('编号', 10) + pad('ID', 5) + pad('STATUS', 10) + pad('PRIORITY', 9) + pad('TITLE', 28) + 'UPDATED';
      const lines = [`项目: ${p.name}`, header, '-'.repeat(header.length)];
      for (const r of rows) {
        lines.push(
          pad(r.code, 10) + pad(r.id, 5) + pad(r.status, 10) + pad(r.priority, 9) + pad(r.title, 28) + fmtTime(r.updated_at)
        );
      }
      return out(json, rows, lines.join('\n'));
    }
    case 'add':
    case 'new': {
      if (options.batch) {
        const p = getActiveProject(options);
        let items;
        try {
          items = JSON.parse(readStdin());
        } catch (e) {
          usageError('stdin 不是合法 JSON 数组: ' + e.message);
        }
        if (!Array.isArray(items)) usageError('批量数据必须是 JSON 数组');
        const t = now();
        const ins = db.prepare(
          'INSERT INTO tasks(project_id, code, title, content, status, priority, position, created_at, updated_at, external_key) VALUES(?,?,?,?,?,?,?,?,?,?)'
        );
        const ids = [];
        const skipped = [];
        db.exec('BEGIN');
        try {
          let pos = db.prepare('SELECT COALESCE(MAX(position),0) m FROM tasks WHERE project_id = ?').get(p.id).m;
          for (const it of items) {
            if (!it || !it.title) usageError('批量条目缺少 title 字段');
            const key = it.key ? String(it.key) : null;
            if (key) {
              const dup = db.prepare('SELECT id, code FROM tasks WHERE external_key = ?').get(key);
              if (dup) {
                skipped.push({ key, id: dup.id, code: dup.code });
                continue;
              }
            }
            pos += 1;
            const info = ins.run(
              p.id,
              genTaskCode(),
              String(it.title),
              it.content || '',
              it.status || 'todo',
              it.priority || 'normal',
              pos,
              t,
              t,
              key
            );
            ids.push(Number(info.lastInsertRowid));
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        logEvent('task.add', {
          actor: currentAgent(options),
          project_id: p.id,
          detail: `批量插入 ${ids.length} 条`,
        });
        // 防呆：一次塞很多条，很可能是把「执行过程」当成了任务
        const batchHint =
          ids.length >= 3
            ? '一次建了多条任务。若这些只是执行过程/心得而非真正的待办，请用 task log <id> 记过程、task done --result 写产出；完成后用 taskcli report --out 导出一份报告交付。'
            : undefined;
        return out(
          json,
          { project: p.name, inserted: ids.length, ids, skipped },
          `已批量插入 ${ids.length} 条记录到 "${p.name}"` +
            (skipped.length ? `（跳过 ${skipped.length} 条重复幂等键）` : ''),
          batchHint
        );
      }
      const title = args[0];
      if (!title) usageError('用法: taskcli task add <标题> --project <名称> [--content <内容>] [--status idea|todo|doing|done|archive] [--priority low|normal|high] [--key <幂等键>]');
      const p = getActiveProject(options);
      // 幂等键：agent 重试时不会重复插入，命中已存在的任务则原样返回
      const extKey = options.key !== undefined && options.key !== true ? String(options.key) : '';
      if (extKey) {
        const dup = db.prepare('SELECT * FROM tasks WHERE external_key = ?').get(extKey);
        if (dup) return out(json, dup, `已存在相同幂等键的任务 #${dup.id} [${dup.code}]（未重复创建）`);
      }
      const t = now();
      const info = db
        .prepare(
          'INSERT INTO tasks(project_id, code, title, content, status, priority, position, created_at, updated_at, external_key) VALUES(?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          p.id,
          genTaskCode(),
          title,
          options.content || '',
          options.status || 'todo',
          options.priority || 'normal',
          (db.prepare('SELECT COALESCE(MAX(position),0) m FROM tasks WHERE project_id = ?').get(p.id).m) + 1,
          t,
          t,
          extKey || null
        );
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
      logEvent('task.add', {
        actor: currentAgent(options),
        task_id: row.id,
        project_id: p.id,
        detail: row.title,
      });
      return out(json, row, `已添加 #${row.id} [${row.code}] "${row.title}" 到 "${p.name}"`);
    }
    case 'update':
    case 'edit':
    case 'set': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task update <id> [--title] [--content] [--status] [--priority] [--project]');
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || fail(`记录不存在: ${id}`);
      const fields = {};
      if (options.title !== undefined) fields.title = options.title;
      if (options.content !== undefined) fields.content = options.content;
      if (options.status !== undefined) fields.status = options.status;
      if (options.priority !== undefined) fields.priority = options.priority;
      if (options.project !== undefined) {
        const p = resolveProject(options.project) || fail(`项目不存在: ${options.project}`);
        fields.project_id = p.id;
      }
      // 转派 / 纠正归属（--assignee "" 表示清空）
      if (options.assignee !== undefined) {
        fields.assignee = String(options.assignee).trim() === '' ? null : String(options.assignee).trim();
      }
      if (Object.keys(fields).length === 0)
        usageError('没有可更新的字段，请至少提供一个 --title/--content/--status/--priority/--project');
      fields.updated_at = now();
      const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...Object.values(fields), id);
      logEvent('task.update', {
        actor: currentAgent(options),
        task_id: id,
        project_id: row.project_id,
        detail: Object.keys(fields)
          .filter((k) => k !== 'updated_at')
          .join(','),
      });
      // 防呆：直接把状态改成 doing 属于「绕过认领」。给了 --agent 就顺手补认领，
      // 没给就提示正确姿势，避免多 agent 撞车。
      let hint;
      if (fields.status === 'doing') {
        if (options.agent && options.agent !== true && !row.assignee) {
          const lease = parseDuration(options.lease, DEFAULT_LEASE_MS);
          const ts = now();
          db
            .prepare('UPDATE tasks SET assignee = ?, claimed_at = ?, lease_until = ?, updated_at = ? WHERE id = ?')
            .run(String(options.agent), ts, ts + lease, ts, id);
          logEvent('task.claim', {
            actor: String(options.agent),
            task_id: id,
            project_id: row.project_id,
            detail: '随状态变更自动认领',
          });
          hint = `已自动把 #${id} 认领给 ${options.agent}（下次直接用 task start <id> --agent <名称> 或 task next 更省事）`;
        } else if (!row.assignee) {
          hint = `#${id} 尚未被认领：多 agent 协作请用 task start <id> --agent <名称> 或 task next，手动改状态会和别人撞车`;
        }
      }

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return out(json, updated, `已更新 #${id}`, hint);
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task remove <id> [--yes]');
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || fail(`记录不存在: ${id}`);
      if (!options.yes) confirmError(`将删除记录 #${id} "${row.title}"。请追加 --yes 确认删除。`);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      logEvent('task.remove', {
        actor: currentAgent(options),
        task_id: id,
        project_id: row.project_id,
        detail: row.title,
      });
      return out(json, { id }, `已删除 #${id} "${row.title}"`);
    }
    case 'show':
    case 'get': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task show <id>');
      const row = db
        .prepare(
          'SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?'
        )
        .get(id) || fail(`记录不存在: ${id}`);
      if (json) return out(json, row);
      const lines = [
        `ID:        ${row.id}`,
        `编号:      ${row.code}`,
        `项目:      ${row.project_name}`,
        `标题:      ${row.title}`,
        `状态:      ${row.status}`,
        `优先级:    ${row.priority}`,
        `创建:      ${fmtTime(row.created_at)}`,
        `更新:      ${fmtTime(row.updated_at)}`,
        `内容:`,
        row.content || '(空)',
      ];
      return out(json, row, lines.join('\n'));
    }
    case 'search':
    case 'find': {
      const q = args[0] || options.q || '';
      if (!q || !String(q).trim()) {
        usageError('用法: taskcli task search <关键词>  (支持空格分隔的多关键词，模糊匹配 编号/标题/内容/项目)');
      }
      const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      const cond = tokens
        .map(() => '(LOWER(t.code) LIKE ? OR LOWER(t.title) LIKE ? OR LOWER(t.content) LIKE ? OR LOWER(p.name) LIKE ?)')
        .join(' AND ');
      const sql =
        'SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ' +
        cond +
        ' ORDER BY t.updated_at DESC';
      const params = [];
      for (const tk of tokens) {
        const like = `%${tk}%`;
        params.push(like, like, like, like);
      }
      const rows = db.prepare(sql).all(...params);
      if (json) return out(json, rows);
      if (rows.length === 0) return out(json, [], `(未找到匹配 "${q}" 的任务)`);
      const header = pad('编号', 10) + pad('ID', 5) + pad('项目', 16) + pad('状态', 10) + pad('标题', 26);
      const lines = [`搜索 "${q}" —— 命中 ${rows.length} 条`, header, '-'.repeat(header.length)];
      for (const r of rows) {
        lines.push(
          pad(r.code, 10) + pad(r.id, 5) + pad(r.project_name, 16) + pad(r.status, 10) + pad(r.title, 26)
        );
      }
      return out(json, rows, lines.join('\n'));
    }

    /* -------------------- agent 联动：认领 / 租约 / 结果 -------------------- */

    // next：一次调用完成「回收过期租约 → 挑一条依赖就绪且无人认领的 → 原子认领」
    case 'next':
    case 'pull': {
      const p = getActiveProject(options);
      const agent = currentAgent(options);
      const lease = parseDuration(options.lease);
      const statuses = String(options.status || 'todo')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const t = nextTask(p.id, agent, lease, statuses);
      if (!t) {
        fail(
          `项目 "${p.name}" 当前没有可认领的任务（候选状态 ${statuses.join('/')}；可能存在未完成依赖或全部已被认领）`,
          'NO_TASK',
          EXIT.NO_TASK,
          HINT_NO_TASK
        );
      }
      const data = {
        ...t,
        project_name: p.name,
        tracks: db.prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id').all(t.id),
      };
      return out(
        json,
        data,
        `已认领 #${t.id} [${t.code}] "${t.title}" → ${agent}（租约 ${fmtLease(lease)}）`,
        agentHint(AUTONOMY_RULE)
      );
    }

    // start：最直觉的入口「开始做这条」= 认领 + 置为进行中（claim 的同义别名）
    case 'start':
    case 'begin':
    // claim：认领指定任务（并发安全，抢不到返回退出码 3）
    case 'claim':
    case 'take': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task start|claim <id> --agent <名称> [--lease 30m]');
      const agent = currentAgent(options);
      const lease = parseDuration(options.lease);
      const res = claimTask(id, agent, lease);
      if (!res.ok) {
        fail(res.message, res.code, res.code === 'CONFLICT' ? EXIT.CONFLICT : EXIT.ERROR);
      }
      return out(
        json,
        res.data,
        `已认领 #${id} [${res.data.code}] "${res.data.title}" → ${agent}（租约 ${fmtLease(lease)}）`,
        agentHint(AUTONOMY_RULE)
      );
    }

    // heartbeat：长任务续租，防止做到一半被回收；未认领时等价于 claim
    case 'heartbeat':
    case 'hb': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task heartbeat <id> --agent <名称> [--lease 30m]');
      const row = requireTask(id);
      const agent = currentAgent(options);
      const lease = parseDuration(options.lease);
      if (!row.assignee) {
        const res = claimTask(id, agent, lease);
        if (!res.ok) fail(res.message, res.code, res.code === 'CONFLICT' ? EXIT.CONFLICT : EXIT.ERROR);
        return out(json, res.data, `任务 #${id} 未认领，已直接认领 → ${agent}`);
      }
      checkOwner(row, options);
      const ts = now();
      db.prepare('UPDATE tasks SET lease_until = ?, updated_at = ? WHERE id = ?').run(ts + lease, ts, id);
      logEvent('task.heartbeat', { actor: agent, task_id: id, project_id: row.project_id, detail: `续租 ${fmtLease(lease)}` });
      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return out(json, updated, `已续租 #${id} → ${fmtLease(lease)}（${agent}）`);
    }

    // assign：指定/纠正归属（认领人写错时用它改，不动状态）
    case 'assign':
    case 'owner': {
      // 批量纠正：task assign --from <错名> --to <正名>
      if (args[0] === undefined) {
        const from = options.from;
        const to = options.to || options.agent;
        if (!from || !to)
          usageError(
            '用法: taskcli task assign <id> --agent <名称> [--force]   |   taskcli task assign --from <错名> --to <正名>'
          );
        const ts = now();
        const info = db
          .prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE assignee = ?')
          .run(String(to), ts, String(from));
        logEvent('task.assign', { actor: String(to), detail: `批量转派 ${from} → ${to}，共 ${info.changes} 条` });
        return out(
          json,
          { from, to, updated: info.changes },
          `已将 ${info.changes} 条任务从 "${from}" 转派为 "${to}"`,
          '建议再用 taskcli config alias <错名> <正名>，以后填错会自动纠正。'
        );
      }
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task assign <id> --agent <名称> [--force]');
      const row = requireTask(id);
      const agent = currentAgent(options);
      if (row.assignee && row.assignee !== agent && !options.force) {
        fail(
          `#${id} 已由 "${row.assignee}" 持有，转派请加 --force`,
          'CONFLICT',
          EXIT.CONFLICT,
          '若只是想把认领人名字改对（比如 agent 身份填错了），加 --force 即可。'
        );
      }
      const ts = now();
      db.prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?').run(agent, ts, id);
      logEvent('task.assign', {
        actor: agent,
        task_id: id,
        project_id: row.project_id,
        detail: `归属从 ${row.assignee || '-'} 改为 ${agent}`,
      });
      return out(
        json,
        db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
        `#${id} 的认领人已设为 ${agent}`
      );
    }

    // release：放弃任务，回到待办并清空认领信息
    case 'release':
    case 'drop': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task release <id> [--agent <名称>]');
      const row = requireTask(id);
      checkOwner(row, options);
      const ts = now();
      db.prepare(
        "UPDATE tasks SET status = 'todo', assignee = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?"
      ).run(ts, id);
      addTrack(id, `[系统] ${currentAgent(options)} 释放了任务，回到待办`, ts);
      logEvent('task.release', { actor: currentAgent(options), task_id: id, project_id: row.project_id });
      return out(json, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), `已释放 #${id}，回到待办`);
    }

    // done：标记完成，可附带产出/总结
    case 'done':
    case 'finish': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task done <id> [--result "产出说明"] [--agent <名称>]');
      const row = requireTask(id);
      checkOwner(row, options);
      const agent = currentAgent(options);
      const ts = now();
      db.prepare(
        "UPDATE tasks SET status = 'done', result = ?, assignee = ?, lease_until = NULL, updated_at = ? WHERE id = ?"
      ).run(options.result ? String(options.result) : '', row.assignee || agent, ts, id);
      const note = options.result ? `完成：${options.result}` : '完成';
      addTrack(id, `[${agent}] ${note}`, ts);
      logEvent('task.done', {
        actor: agent,
        task_id: id,
        project_id: row.project_id,
        detail: options.result ? String(options.result) : '',
      });
      return out(json, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), `已完成 #${id} [${row.code}]`);
    }

    // fail：记录失败原因并累加 attempts；未超上限则回待办重试，超出则转 blocked 等人
    case 'fail': {
      const id = Number(args[0]);
      if (!Number.isInteger(id))
        usageError('用法: taskcli task fail <id> [--error "原因"] [--max 3] [--no-retry] [--agent <名称>]');
      const row = requireTask(id);
      checkOwner(row, options);
      const agent = currentAgent(options);
      const attempts = (row.attempts || 0) + 1;
      const max = Number.isInteger(Number(options.max)) && options.max !== true ? Number(options.max) : 3;
      const err = options.error ? String(options.error) : '（未提供 --error 详情）';
      const noRetry = options['no-retry'] !== undefined;
      const retry = !noRetry && attempts < max;
      const ts = now();
      db.prepare(
        `UPDATE tasks SET status = ?, attempts = ?, last_error = ?, assignee = ?, claimed_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`
      ).run(retry ? 'todo' : 'blocked', attempts, err, retry ? null : row.assignee || agent, ts, id);
      addTrack(
        id,
        `[${agent}] 第 ${attempts} 次失败：${err}${retry ? `（将在待办重试，上限 ${max} 次）` : `（已达上限 ${max}，转 blocked 等待人工）`}`,
        ts
      );
      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      logEvent('task.fail', {
        actor: agent,
        task_id: id,
        project_id: row.project_id,
        detail: `第 ${attempts} 次失败：${err}`,
      });
      return out(
        json,
        updated,
        `已记录 #${id} 第 ${attempts} 次失败 → ${retry ? 'todo（可重试）' : 'blocked（等人工）'}`
      );
    }

    /* -------------------- 执行日志（与 Web 端共享 task_tracks） -------------------- */

    case 'log': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task log <id> <内容>   或 --content="多行内容"');
      requireTask(id);
      const content =
        options.content !== undefined && options.content !== true
          ? String(options.content)
          : args.slice(1).join(' ');
      if (!content.trim()) usageError('日志内容不能为空');
      const actor = options.agent ? String(options.agent) : '';
      const tr = addTrack(id, actor ? `[${actor}] ${content}` : content);
      logEvent('task.log', { actor, task_id: id, detail: content.slice(0, 200) });
      return out(json, tr, `已记录 #${id} 的跟踪记录 #${tr.id}`);
    }

    case 'logs':
    case 'tracks': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) usageError('用法: taskcli task logs <id>');
      requireTask(id);
      const rows = db.prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id').all(id);
      if (json) return out(json, rows);
      if (!rows.length) return out(json, [], `(#${id} 暂无跟踪记录)`);
      const lines = [`#${id} 的跟踪记录（${rows.length} 条）`];
      for (const r of rows) lines.push(`  ${fmtTime(r.created_at)}  ${r.content}`);
      return out(json, rows, lines.join('\n'));
    }

    /* -------------------- 依赖（DAG）与就绪判定 -------------------- */

    case 'dep':
    case 'deps': {
      const sub = String(args[0] || 'list').toLowerCase();
      const id = Number(args[1]);
      if (!Number.isInteger(id))
        usageError('用法: taskcli task dep add <id> --on <依赖id> | task dep rm <id> --on <依赖id> | task dep list <id>');
      requireTask(id);
      if (sub === 'add' || sub === 'link') {
        const depId = Number(options.on);
        if (!Number.isInteger(depId)) usageError('请提供 --on <依赖任务 id>');
        const depRow = requireTask(depId);
        if (depWouldCycle(id, depId)) fail(`会形成循环依赖: #${id} → #${depId}`, 'INVALID_DEP', EXIT.ERROR);
        const dup = db.prepare('SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ?').get(id, depId);
        if (dup) fail(`依赖已存在: #${id} → #${depId}`, 'EXISTS', EXIT.ERROR);
        db.prepare('INSERT INTO task_deps(task_id, depends_on_id, created_at) VALUES(?,?,?)').run(id, depId, now());
        logEvent('task.dep.add', { actor: currentAgent(options), task_id: id, detail: `依赖 #${depId}` });
        return out(json, { task_id: id, depends_on_id: depId }, `已设置 #${id} 依赖 #${depId} "${depRow.title}"`);
      }
      if (sub === 'rm' || sub === 'remove' || sub === 'unlink') {
        const depId = Number(options.on);
        if (!Number.isInteger(depId)) usageError('请提供 --on <依赖任务 id>');
        const info = db.prepare('DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?').run(id, depId);
        if (info.changes !== 1) fail(`依赖不存在: #${id} → #${depId}`, 'NOT_FOUND', EXIT.ERROR);
        logEvent('task.dep.rm', { actor: currentAgent(options), task_id: id, detail: `移除依赖 #${depId}` });
        return out(json, { task_id: id, depends_on_id: depId }, `已移除 #${id} 对 #${depId} 的依赖`);
      }
      const rows = db
        .prepare(
          `SELECT d.depends_on_id AS id, t.code, t.title, t.status
             FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
            WHERE d.task_id = ? ORDER BY d.depends_on_id`
        )
        .all(id);
      if (json) return out(json, rows);
      if (!rows.length) return out(json, [], `(#${id} 无依赖)`);
      const lines = [`#${id} 的依赖（${rows.length} 条）`];
      for (const r of rows) lines.push(`  #${r.id} [${r.code}] ${pad(r.status, 9)}${r.title}`);
      return out(json, rows, lines.join('\n'));
    }

    // ready：列出「依赖已就绪 + 无人认领」的可开工任务（不认领，只观察）
    case 'ready': {
      const p = getActiveProject(options);
      reclaimExpired();
      const statuses = String(options.status || 'todo')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ph = statuses.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT * FROM tasks WHERE project_id = ? AND status IN (${ph}) AND (assignee IS NULL OR assignee = '')
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, position, id`
        )
        .all(p.id, ...statuses);
      const ready = rows.filter((r) => pendingDeps(r.id).length === 0);
      if (json) return out(json, ready, undefined, ready.length ? undefined : HINT_NO_TASK);
      if (!ready.length) return out(json, [], `(项目 "${p.name}" 暂无可开工任务)`, HINT_NO_TASK);
      const lines = [`项目 "${p.name}" 可开工任务（${ready.length} 条）`];
      for (const r of ready)
        lines.push(`  ${pad(r.code, 10)}${pad('#' + r.id, 6)}${pad(r.priority, 8)}${r.title}`);
      return out(json, ready, lines.join('\n'));
    }

    default:
      throw new CliError('UNKNOWN_ACTION', `未知 task 动作: ${action || '(空)'}`, EXIT.USAGE);
  }
}

/* ------------------------- 审计事件与数据库维护 ------------------------- */

/** events：查看审计流水（谁在什么时间对哪条任务做了什么） */
function handleEvents(action, args, options, json) {
  const limit = Number.isInteger(Number(options.limit)) ? Number(options.limit) : 50;
  const where = [];
  const params = [];
  if (options.kind && options.kind !== true) {
    where.push('kind = ?');
    params.push(String(options.kind));
  }
  if (options.task !== undefined) {
    const tid = Number(options.task);
    if (!Number.isInteger(tid)) usageError('--task 必须是任务 id');
    where.push('task_id = ?');
    params.push(tid);
  }
  if (options.actor && options.actor !== true) {
    where.push('actor = ?');
    params.push(String(options.actor));
  }
  const sql =
    'SELECT * FROM events' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC LIMIT ?';
  const rows = db.prepare(sql).all(...params, limit);
  if (json) return out(json, rows);
  if (!rows.length) return out(json, [], '(暂无事件)');
  const lines = [`最近 ${rows.length} 条事件（新的在前）`];
  for (const r of rows) {
    lines.push(
      `  ${fmtTime(r.ts)}  ${pad(r.kind, 16)}${pad(r.actor || '-', 12)}${pad(
        r.task_id ? '#' + r.task_id : '-',
        7
      )}${r.detail}`
    );
  }
  return out(json, rows, lines.join('\n'));
}

/** db：备份 / 查看数据库路径 */
function handleDb(action, args, options, json) {
  const src = resolveDbPath();
  if (action === 'path' || action === 'info') {
    return out(json, { path: src }, src);
  }
  if (action === 'backup' || action === 'snapshot' || action === 'dump') {
    // 先把 WAL 落盘到主库文件，保证快照自包含（否则只复制主库会丢最近写入）
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .replace(/\..+/, '');
    const file = options.name && options.name !== true ? String(options.name) : `taskcli-${stamp}.db`;
    const dir = options.out && options.out !== true ? String(options.out) : path.dirname(src);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file);
    fs.copyFileSync(src, dest);
    const size = fs.statSync(dest).size;
    logEvent('db.backup', { actor: currentAgent(options), detail: dest });
    return out(json, { path: dest, size }, `已备份到 ${dest}（${(size / 1024).toFixed(1)} KB）`);
  }
  usageError('用法: taskcli db backup [--out <目录>] [--name <文件名>]  |  taskcli db path');
}

/**
 * report：导出「执行过程 + 产物」的 Markdown 报告。
 * --out 指定文件/目录则落盘并返回路径；不带 --out 直接打印到终端（便于管道）。
 */
function handleReport(action, args, options, json) {
  const opts = { withLogs: options['no-logs'] === undefined };
  let md;
  let subject;
  if (options.task !== undefined) {
    const id = Number(options.task);
    if (!Number.isInteger(id)) usageError('--task 必须是任务 id');
    md = buildTaskReport(id, opts);
    subject = `task-${id}`;
  } else {
    const p = getActiveProject(options);
    md =
      options.deliverables !== undefined || action === 'deliverables'
        ? buildDeliverables(p.id)
        : buildProjectReport(p.id, opts);
    subject = `project-${p.id}`;
  }

  if (options.out !== undefined) {
    const raw = options.out === true ? path.join(os.homedir(), '.taskcli', 'reports') : String(options.out);
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .replace(/\..+/, '');
    const dest = path.extname(raw) ? raw : path.join(raw, `taskcli-${subject}-${stamp}.md`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, md);
    logEvent('report.export', { actor: currentAgent(options), detail: dest });
    return out(
      json,
      { path: dest, bytes: Buffer.byteLength(md) },
      `报告已写入 ${dest}`,
      '用编辑器 / Markdown 预览打开即可；不带 --out 则直接打印到终端。'
    );
  }
  process.stdout.write(md + '\n');
  return undefined;
}

/**
 * 同步探测本地 HTTP 服务是否在监听（doctor 用）。
 * 用 spawnSync 跑一条子命令，避免把 cli.js 变成全程async 的大改。
 */
function probeWeb(url) {
  try {
    const { spawnSync } = require('child_process');
    const probe = `
const http=require('http');const req=http.get(${JSON.stringify(url)},r=>{process.exit(0)});
req.on('error',()=>process.exit(1));req.setTimeout(800,()=>{req.destroy();process.exit(1)});
`;
    const r = spawnSync(process.execPath, ['-e', probe], { timeout: 3000, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * doctor：环境自检。跑不起来时先跑它，一次说清 Node 版本、数据库路径、
 * 数据完整性、网页服务可达性，避免 agent 在模块堆栈里猜。
 */
function handleDoctor(options, json) {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint });

  // 1. Node 版本（node:sqlite 实际门槛 22.13，不是文档常写的 22.5）
  const nodeOk = sqliteGuard.isSupported();
  add(
    'Node 版本',
    nodeOk,
    `${sqliteGuard.currentVersion()}（需要 >= ${sqliteGuard.MIN_MAJOR}.${sqliteGuard.MIN_MINOR}，因内置模块 node:sqlite）`,
    nodeOk ? undefined : '升级 Node，或直接用新版本执行：/opt/homebrew/bin/node ' + ENTRY + ' ...'
  );

  // 2. 数据库文件
  const dbPath = resolveDbPath();
  let dbOk = true;
  let dbDetail = dbPath;
  try {
    const st = fs.statSync(dbPath);
    dbDetail = `${dbPath}（${(st.size / 1024).toFixed(1)} KB）`;
  } catch {
    dbOk = false;
    dbDetail = `${dbPath}（尚未创建，首次写入命令会自动生成）`;
  }
  add('数据库文件', dbOk, dbDetail);

  // 3. 表结构与可读性
  let dataOk = true;
  let dataDetail;
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    const missing = ['projects', 'tasks', 'events'].filter((t) => !tables.includes(t));
    if (missing.length) {
      dataOk = false;
      dataDetail = `缺表：${missing.join(', ')}（首次运行会自动建表；若数据来自旧版本请备份后重建）`;
    } else {
      const c = db.prepare('SELECT COUNT(*) AS n FROM tasks').get();
      const p = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
      dataDetail = `${tables.length} 张表，${p.n} 个看板 / ${c.n} 个任务`;
    }
  } catch (e) {
    dataOk = false;
    dataDetail = `读取失败：${e.message}`;
  }
  add('数据可读', dataOk, dataDetail);

  // 4. 网页服务端口（装了但没启动不算错，只提示）。同步探测，避免输出竞态。
  const port = Number(process.env.TASKCLI_PORT || 3979);
  const url = `http://127.0.0.1:${port}`;
  add(
    '网页服务',
    true,
    probeWeb(url)
      ? `${url}（运行中）`
      : `${url}（未启动，需要时跑 npm run web）`
  );

  // 5. 前端构建产物
  const dist = path.join(__dirname, '..', 'web', 'dist', 'index.html');
  const uiOk = fs.existsSync(dist);
  add('前端产物', uiOk, uiOk ? dist : `${dist} 不存在，改完前端需跑 npm run build:ui`);

  const failed = checks.filter((c) => !c.ok);
  const payload = { ok: failed.length === 0, node: process.execPath, db: dbPath, checks };
  if (json) return out(json, payload, JSON.stringify(payload, null, 2));

  const lines = [`taskcli doctor   Node=${sqliteGuard.currentVersion()}  DB=${dbPath}`, ''];
  for (const c of checks) {
    lines.push(`${c.ok ? '✔' : '✖'} ${padDisp(c.name, 12)}${c.detail}`);
    if (c.hint) lines.push(`  → ${c.hint}`);
  }
  lines.push('');
  lines.push(failed.length ? `✖ ${failed.length} 项需处理` : '✔ 全部正常');
  process.stdout.write(lines.join('\n') + '\n');
  return undefined;
}

/** config：默认 agent 身份 + 错误名自动纠正规则 */
function handleConfig(action, args, options, json) {
  if (action === 'path') return out(json, { path: CONFIG_PATH }, CONFIG_PATH);

  if (action === 'set') {
    const key = args[0];
    const val = args[1];
    if (key !== 'agent' || val === undefined)
      usageError('用法: taskcli config set agent <名称>   例: taskcli config set agent workbuddy');
    const cfg = saveConfig({ agent: String(val) });
    return out(json, cfg, `默认 agent 身份已设为 "${val}"`);
  }

  if (action === 'alias') {
    const from = args[0];
    const to = args[1];
    if (!from || !to)
      usageError('用法: taskcli config alias <错名> <正名>   例: taskcli config alias codebuddy workbuddy');
    const cfg = loadConfig();
    const aliases = { ...(cfg.agentAliases || {}), [String(from)]: String(to) };
    const next = saveConfig({ agentAliases: aliases });
    return out(json, next, `已设置纠正规则："${from}" → "${to}"（以后填 ${from} 会自动记为 ${to}）`);
  }

  const cfg = loadConfig();
  if (json) return out(json, cfg);
  const al = Object.entries(cfg.agentAliases || {});
  const lines = [
    `配置文件: ${CONFIG_PATH}`,
    `默认身份: ${cfg.agent || '(未设置，回落 "agent")'}`,
    `纠正规则: ${al.length ? al.map(([k, v]) => `${k} → ${v}`).join(' , ') : '(无)'}`,
  ];
  return out(json, cfg, lines.join('\n'));
}

/* ----------------------------- 帮助 ----------------------------- */

/** 输出可直接粘贴到 MCP 客户端的 mcpServers 配置（省去手写绝对路径） */
function printMcpConfig(options) {
  const o = options || {};
  const agent =
    (o.agent && o.agent !== true && String(o.agent)) || process.env.TASKCLI_AGENT || defaultAgent();
  process.stdout.write(
    JSON.stringify(
      {
        mcpServers: {
          taskcli: {
            command: process.execPath,
            args: [ENTRY, 'mcp'],
            env: { TASKCLI_AGENT: agent },
          },
        },
      },
      null,
      2
    ) + '\n'
  );
}

function printHelp() {
  const text = `
taskcli —— 本地任务看板 CLI（SQLite 存储，agent 友好）

环境要求:
  Node.js >= 22.13（内置模块 node:sqlite；22.12 实测没有）
  跑不起来先执行: taskcli doctor

存储:
  DB 默认位于 ~/.taskcli/taskcli.db，可用环境变量 TASKCLI_DB 覆盖。
  指定看板可用环境变量 TASKCLI_PROJECT 或每条命令的 --project <名称>。

项目 (project) —— 用来区分不同的看板:
  taskcli project list
  taskcli project add <名称> [--desc <描述>]
  taskcli project rename <id|名称> <新名称>
  taskcli project remove <id|名称> --yes

任务 (task) —— 看板内的记录（标题/内容/状态/优先级）:
  taskcli task list [--project <名称>] [--status idea|todo|doing|done|archive]
  taskcli task add <标题> --project <名称> [--content <内容>] [--status <s>] [--priority low|normal|high] [--key <幂等键>]
  taskcli task add --project <名称> --batch     # 从 stdin 读取 JSON 数组批量插入
  taskcli task update <id> [--title] [--content] [--status] [--priority] [--project]
  taskcli task remove <id> --yes
  taskcli task show <id>
  taskcli task search <关键词>        # 模糊搜索（编号/标题/内容/项目）

agent 联动 —— 认领 / 租约 / 结果 / 日志 / 依赖:
  taskcli task next    [--project P] [--agent A] [--lease 30m] [--status todo]   # 取下一个可做任务并原子认领
  taskcli task claim   <id> [--agent A] [--lease 30m]        # 认领指定任务（并发安全）
  taskcli task heartbeat <id> [--agent A] [--lease 30m]      # 长任务续租
  taskcli task release <id> [--agent A]                      # 放弃任务，回到待办
  taskcli task done    <id> [--result "产出"] [--agent A]     # 完成并留产出
  taskcli task fail    <id> [--error "原因"] [--max 3]        # 失败计数，未达上限回待办重试
  taskcli task log     <id> <内容>                            # 写执行日志
  taskcli task logs    <id>                                   # 看执行日志
  taskcli task dep add <id> --on <依赖id>                     # 设依赖（B 等 A 完成）
  taskcli task dep list|rm <id> [--on <依赖id>]
  taskcli task ready   [--project P]                          # 列出可开工任务（只观察，不认领）

身份配置（agent 名字总被填错时用）:
  taskcli config                              # 查看默认身份与纠正规则
  taskcli config set agent workbuddy           # 设默认身份（CLI / MCP 未指定时用它）
  taskcli config alias codebuddy workbuddy     # 填错自动纠正：codebuddy → workbuddy
  taskcli task assign --from codebuddy --to workbuddy   # 批量纠正已认领的任务

入门（给 agent / 新同事）:
  taskcli agent            # 打印完整上手指南（最小循环 + 要点 + 退出码）
  taskcli agent --json     # 机读版，便于 agent 之间传递
  taskcli mcp --print-config   # 输出可直接粘贴的 MCP 客户端配置

产物导出:
  taskcli report [--project P] [--task <id>] [--out <文件|目录>] [--deliverables] [--no-logs]
      # 把任务 + 执行日志 + 产物 + 依赖汇总成 Markdown；--out 落盘，不带则打印
  taskcli report --deliverables --out ~/Desktop    # 只导出已完成任务的「产出汇总」

审计与维护:
  taskcli doctor                                          # 环境自检（Node/数据库/表/网页服务/前端产物）
  taskcli events [--kind <事件类型>] [--task <id>] [--actor <名称>] [--limit 50]   # 审计流水
  taskcli db backup [--out <目录>] [--name <文件名>]    # 快照（先 checkpoint WAL）
  taskcli db path                                       # 打印当前数据库文件路径
  taskcli mcp                                           # 以 MCP server 运行（stdio JSON-RPC）

agent 友好:
  - 所有命令支持 --json，输出统一为 {"ok":true,"data":...} / {"ok":false,"error":{"code":..,"message":..}}
  - 退出码: 0 成功 / 1 业务错误 / 2 无可执行任务 / 3 认领冲突 / 4 用法错误 / 5 需要 --yes
  - 身份: --agent <名称> 或环境变量 TASKCLI_AGENT
  - 破坏性操作（remove）必须显式 --yes，无 TTY 阻塞
  - 批量添加: echo '[{"title":"A","content":".."},{"title":"B"}]' | taskcli task add --project X --batch
`;
  process.stdout.write(text + '\n');
}

function printProjectHelp() {
  const text = `
taskcli project —— 项目（看板）管理

  taskcli project list                                  列出所有看板（含任务数）
  taskcli project add <名称> [--desc <描述>]            新建看板
  taskcli project rename <id|名称> <新名称>            改名
  taskcli project remove <id|名称> --yes               删除看板（连带删除其下任务）

提示:
  - 可用 id 或名称引用项目，按名称精确匹配
  - 第一个创建的项目自动设为默认，之后免 --project
  - 用环境变量 TASKCLI_PROJECT 指定默认看板
  - 所有命令支持 --json 输出
`;
  process.stdout.write(text + '\n');
}

function printTaskHelp() {
  const text = `
taskcli task —— 看板内记录（标题/内容/状态/优先级）

  taskcli task list [--project <名称>] [--status idea|todo|doing|done|archive]
  taskcli task add <标题> --project <名称> [--content <内容>] [--status <s>] [--priority low|normal|high]
  taskcli task add --project <名称> --batch      # 从 stdin 读 JSON 数组批量插入多条
  taskcli task update <id> [--title] [--content] [--status] [--priority] [--project]
  taskcli task remove <id> --yes
  taskcli task show <id>
  taskcli task search <关键词>        # 模糊搜索（编号/标题/内容/项目）

agent 联动:
  taskcli task next       [--project P] [--agent A] [--lease 30m] [--status todo]
  taskcli task start      <id> [--agent A] [--lease 30m]   # 「开始做这条」= 认领 + 置为进行中
  taskcli task claim      <id> [--agent A] [--lease 30m]   # start 的同义写法
  taskcli task heartbeat  <id> [--agent A] [--lease 30m]
  taskcli task release    <id> [--agent A]
  taskcli task done       <id> [--result "产出"] [--agent A]
  taskcli task fail       <id> [--error "原因"] [--max 3] [--no-retry]
  taskcli task log        <id> <内容>        /  taskcli task logs <id>
  taskcli task dep add    <id> --on <依赖id> /  dep list|rm <id> [--on <依赖id>]
  taskcli task ready      [--project P]

状态 (status):    idea(灵感区) | todo(待办) | doing(进行中) | blocked(阻塞) | review(待验收) | done(已完成) | archive(存档)
优先级 (priority): low(低) | normal(普通) | high(高)
租约 (lease):     30m / 2h / 90s / 1800000（毫秒），默认 30m；到期任务自动回收回待办

退出码:  0 成功 | 1 业务错误 | 2 无可执行任务 | 3 认领冲突 | 4 用法错误 | 5 需要 --yes

示例:
  echo '[{"title":"登录页","status":"doing"},{"title":"埋点"}]' | taskcli task add --project 我的看板 --batch
  taskcli task update 3 --status done
  taskcli task list --project 我的看板 --json
  taskcli task next --project 我的看板 --agent codebuddy --json   # 取任务 → 干活 → done
`;
  process.stdout.write(text + '\n');
}

/* ----------------------------- 入口 ----------------------------- */

function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const json = !!options.json;
  JSON_MODE = json;
  const resource = positionals[0];
  const action = positionals[1];

  if (
    !resource ||
    resource === 'help' ||
    ((options.help || options.h) &&
      resource !== 'project' &&
      resource !== 'task' &&
      resource !== 'board' &&
      resource !== 'kanban')
  ) {
    return printHelp();
  }
  if (resource === 'project' && (action === 'help' || options.help || options.h)) {
    return printProjectHelp();
  }
  if (
    (resource === 'task' || resource === 'board' || resource === 'kanban') &&
    (action === 'help' || options.help || options.h)
  ) {
    return printTaskHelp();
  }
  if (resource === 'project') return handleProject(action, positionals.slice(2), options, json);
  if (resource === 'task' || resource === 'board' || resource === 'kanban') {
    return handleTask(action, positionals.slice(2), options, json);
  }
  if (resource === 'events' || resource === 'activity' || resource === 'log') {
    return handleEvents(action, positionals.slice(2), options, json);
  }
  if (resource === 'db') return handleDb(action, positionals.slice(2), options, json);
  // 环境自检：Node 版本 / 数据库 / 表结构 / 网页服务 / 前端产物
  if (resource === 'doctor' || resource === 'check' || resource === 'env') {
    return handleDoctor(options, json);
  }
  if (resource === 'report' || resource === 'export') {
    return handleReport(action, positionals.slice(2), options, json);
  }
  if (resource === 'config') return handleConfig(action, positionals.slice(2), options, json);
  // 自描述：agent 只要能执行到 CLI，就能拿到完整玩法（人读文本 / 机读 JSON）
  if (resource === 'agent' || resource === 'guide' || resource === 'howto') {
    if (json) return out(json, GUIDE_JSON);
    process.stdout.write(GUIDE_TEXT + '\n');
    return undefined;
  }
  // MCP server：走 stdio JSON-RPC，供支持 MCP 的 agent 直接调用
  if (resource === 'mcp') {
    if (options['print-config'] || options.printConfig || action === 'config') return printMcpConfig(options);
    return require('./mcp').start();
  }
  throw new CliError('UNKNOWN_RESOURCE', `未知资源: ${resource}（可用 project / task）`, EXIT.USAGE);
}

try {
  main();
} catch (e) {
  const code = e instanceof CliError ? e.code : 'ERROR';
  const exit = e instanceof CliError ? e.exit : EXIT.ERROR;
  // 同一契约：--json 时错误也走 stdout 的结构化输出，人类态才写 stderr
  if (JSON_MODE) {
    const payload = { ok: false, error: { code, message: e.message } };
    if (e.hint) payload.hint = e.hint;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stderr.write(`Error[${code}]: ${e.message}\n`);
    if (e.hint) process.stderr.write(`提示: ${e.hint}\n`);
  }
  process.exit(exit);
}
