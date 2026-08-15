'use strict';

const fs = require('fs');

// node:sqlite 在 Node 22 仍是实验特性，会在 stderr 打印 ExperimentalWarning。
// 该警告不影响 stdout 的 JSON 解析，这里移除默认打印器并自行过滤，保持 agent 输出干净。
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning') return;
  process.stderr.write(`Warning: ${w && w.message ? w.message : w}\n`);
});

const { db, now, genTaskCode } = require('./db');

/* ----------------------------- 参数解析 ----------------------------- */

/**
 * 简陋但可靠的参数解析：
 *   --key value  -> options.key = 'value'
 *   --flag       -> options.flag = true
 *   其余         -> positionals[]
 */
function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
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

function out(json, data, human) {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write((human || '') + '\n');
  }
}

function fail(msg) {
  throw new Error(msg);
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
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
      if (!ref) fail('用法: taskcli project add <名称> [--desc <描述>]');
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
      return out(json, row, `已创建项目 #${row.id} "${row.name}"`);
    }
    case 'rename': {
      const newName = args[1];
      if (!ref || !newName) fail('用法: taskcli project rename <id|名称> <新名称>');
      const p = resolveProject(ref) || fail(`项目不存在: ${ref}`);
      db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(newName, now(), p.id);
      return out(json, { id: p.id, name: newName }, `项目 #${p.id} 已重命名为 "${newName}"`);
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      if (!ref) fail('用法: taskcli project remove <id|名称> [--yes]');
      const p = resolveProject(ref) || fail(`项目不存在: ${ref}`);
      const cnt = db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id = ?').get(p.id).c;
      if (!options.yes) {
        fail(`将删除项目 "${p.name}" 及其下 ${cnt} 条记录。请追加 --yes 确认删除。`);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
      // 若删除的是默认项目，清理默认
      const def = db.prepare("SELECT value FROM meta WHERE key='default_project'").get();
      if (def && Number(def.value) === p.id) db.prepare("DELETE FROM meta WHERE key='default_project'").run();
      return out(json, { id: p.id, removedTasks: cnt }, `已删除项目 "${p.name}" 及其 ${cnt} 条记录`);
    }
    default:
      throw new Error(`未知 project 动作: ${action || '(空)'}`);
  }
}

/* ----------------------------- task 命令 ----------------------------- */

function readStdin() {
  if (process.stdin.isTTY) fail('批量模式需要从管道读取 JSON，例如: echo \'[{"title":".."}]\' | taskcli task add --project X --batch');
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
          fail('stdin 不是合法 JSON 数组: ' + e.message);
        }
        if (!Array.isArray(items)) fail('批量数据必须是 JSON 数组');
        const t = now();
        const ins = db.prepare(
          'INSERT INTO tasks(project_id, code, title, content, status, priority, position, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
        );
        const ids = [];
        db.exec('BEGIN');
        try {
          let pos = db.prepare('SELECT COALESCE(MAX(position),0) m FROM tasks WHERE project_id = ?').get(p.id).m;
          for (const it of items) {
            if (!it || !it.title) fail('批量条目缺少 title 字段');
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
              t
            );
            ids.push(Number(info.lastInsertRowid));
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        return out(json, { project: p.name, inserted: ids.length, ids }, `已批量插入 ${ids.length} 条记录到 "${p.name}"`);
      }
      const title = args[0];
      if (!title) fail('用法: taskcli task add <标题> --project <名称> [--content <内容>] [--status idea|todo|doing|done|archive] [--priority low|normal|high]');
      const p = getActiveProject(options);
      const t = now();
      const info = db
        .prepare(
          'INSERT INTO tasks(project_id, code, title, content, status, priority, position, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
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
          t
        );
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
      return out(json, row, `已添加 #${row.id} [${row.code}] "${row.title}" 到 "${p.name}"`);
    }
    case 'update':
    case 'edit':
    case 'set': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) fail('用法: taskcli task update <id> [--title] [--content] [--status] [--priority] [--project]');
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
      if (Object.keys(fields).length === 0) fail('没有可更新的字段，请至少提供一个 --title/--content/--status/--priority/--project');
      fields.updated_at = now();
      const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...Object.values(fields), id);
      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return out(json, updated, `已更新 #${id}`);
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) fail('用法: taskcli task remove <id> [--yes]');
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || fail(`记录不存在: ${id}`);
      if (!options.yes) fail(`将删除记录 #${id} "${row.title}"。请追加 --yes 确认删除。`);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      return out(json, { id }, `已删除 #${id} "${row.title}"`);
    }
    case 'show':
    case 'get': {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) fail('用法: taskcli task show <id>');
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
        fail('用法: taskcli task search <关键词>  (支持空格分隔的多关键词，模糊匹配 编号/标题/内容/项目)');
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
    default:
      throw new Error(`未知 task 动作: ${action || '(空)'}`);
  }
}

/* ----------------------------- 帮助 ----------------------------- */

function printHelp() {
  const text = `
taskcli —— 本地任务看板 CLI（SQLite 存储，agent 友好）

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
  taskcli task add <标题> --project <名称> [--content <内容>] [--status idea|todo|doing|done|archive] [--priority low|normal|high]
  taskcli task add --project <名称> --batch     # 从 stdin 读取 JSON 数组批量插入
  taskcli task update <id> [--title] [--content] [--status] [--priority] [--project]
  taskcli task remove <id> --yes
  taskcli task show <id>
  taskcli task search <关键词>        # 模糊搜索（编号/标题/内容/项目）

agent 友好:
  - 所有命令支持 --json 输出结构化数据
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

状态 (status):    idea(灵感区) | todo(待办) | doing(进行中) | done(已完成) | archive(存档)
优先级 (priority): low(低) | normal(普通) | high(高)

示例:
  echo '[{"title":"登录页","status":"doing"},{"title":"埋点"}]' | taskcli task add --project 我的看板 --batch
  taskcli task update 3 --status done
  taskcli task list --project 我的看板 --json
`;
  process.stdout.write(text + '\n');
}

/* ----------------------------- 入口 ----------------------------- */

function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const json = !!options.json;
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
  throw new Error(`未知资源: ${resource}（可用 project / task）`);
}

try {
  main();
} catch (e) {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
}
