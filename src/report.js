'use strict';

/**
 * 报告生成：把「任务 + 执行日志 + 产物 + 依赖」汇总成一份 Markdown 文档。
 *
 * 解决的问题：执行过程写在 task_tracks / result 里，看板首页只看得到标题，
 * 人要看结果必须逐个点开。这里导出一份可直接交付的产物。
 */

const { db } = require('./db');

const STATUS_LABEL = {
  idea: '灵感区',
  todo: '待办',
  doing: '进行中',
  blocked: '阻塞',
  review: '待验收',
  done: '已完成',
  archive: '存档',
};

const PRIORITY_LABEL = { low: '低', normal: '普通', high: '高' };

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function depsOf(id) {
  return db
    .prepare(
      `SELECT d.depends_on_id AS id, t.code, t.title, t.status
         FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
        WHERE d.task_id = ? ORDER BY d.depends_on_id`
    )
    .all(id);
}

function tracksOf(id) {
  return db.prepare('SELECT * FROM task_tracks WHERE task_id = ? ORDER BY id').all(id);
}

/** 单条任务的 Markdown（含产物与执行日志） */
function taskSection(t, opts) {
  const o = opts || {};
  const L = [];
  L.push(`### #${t.id} [${t.code}] ${t.title}`);
  L.push('');
  const meta = [
    `状态：${STATUS_LABEL[t.status] || t.status}`,
    `优先级：${PRIORITY_LABEL[t.priority] || t.priority}`,
    `认领人：${t.assignee || '-'}`,
    `创建：${fmtTs(t.created_at)}`,
    `更新：${fmtTs(t.updated_at)}`,
  ];
  if (t.attempts) meta.push(`失败次数：${t.attempts}${t.last_error ? `（最近：${t.last_error}）` : ''}`);
  L.push(meta.join(' · '));
  L.push('');
  if (t.content) {
    L.push('**描述**');
    L.push('');
    L.push(t.content);
    L.push('');
  }
  if (t.result) {
    L.push('**产出**');
    L.push('');
    L.push(t.result);
    L.push('');
  } else if (t.status === 'done') {
    L.push('_（未填写产出）_');
    L.push('');
  }
  const tracks = o.withLogs === false ? [] : tracksOf(t.id);
  if (tracks.length) {
    L.push(`**执行日志（${tracks.length} 条）**`);
    L.push('');
    for (const tr of tracks) L.push(`- ${fmtTs(tr.created_at)} — ${tr.content}`);
    L.push('');
  }
  const deps = depsOf(t.id);
  if (deps.length) {
    L.push('**依赖**');
    L.push('');
    for (const d of deps) L.push(`- #${d.id} [${d.code}] ${d.title}（${STATUS_LABEL[d.status] || d.status}）`);
    L.push('');
  }
  return L.join('\n');
}

function resolveProject(ref) {
  if (ref === undefined || ref === null || ref === '') {
    const def = db.prepare("SELECT value FROM meta WHERE key = 'default_project'").get();
    if (def) return db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(def.value)) || null;
    return db.prepare('SELECT * FROM projects ORDER BY id LIMIT 1').get() || null;
  }
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref)) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
  }
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(String(ref)) || null;
}

/** 单条任务报告 */
function buildTaskReport(id, opts) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) throw new Error(`记录不存在: ${id}`);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(t.project_id);
  const head = [
    `# 任务报告 #${t.id} [${t.code}]`,
    '',
    `看板：${p ? p.name : '-'} · 生成时间：${fmtTs(Date.now())}`,
    '',
    '---',
    '',
  ];
  return head.join('\n') + taskSection(t, opts);
}

/** 整个看板的报告：按状态分组，已完成的附完整产物 */
function buildProjectReport(ref, opts) {
  const p = resolveProject(ref);
  if (!p) throw new Error('项目不存在');
  const rows = db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, id')
    .all(p.id);
  const by = (s) => rows.filter((r) => r.status === s);
  const order = ['doing', 'review', 'blocked', 'done', 'todo', 'idea', 'archive'];
  const L = [];
  L.push(`# 看板报告：${p.name}`);
  L.push('');
  L.push(`生成时间：${fmtTs(Date.now())}`);
  if (p.description) L.push(`看板描述：${p.description}`);
  L.push(
    `统计：共 ${rows.length} 条 —— ` +
      order.map((s) => `${STATUS_LABEL[s]} ${by(s).length}`).join(' · ')
  );
  L.push('');
  L.push('---');
  L.push('');
  for (const s of order) {
    const list = by(s);
    if (!list.length) continue;
    L.push(`## ${STATUS_LABEL[s]}（${list.length}）`);
    L.push('');
    for (const t of list) L.push(taskSection(t, opts));
  }
  return L.join('\n');
}

/** 项目内所有已完成任务的「产出汇总」，便于只看结果 */
function buildDeliverables(ref) {
  const p = resolveProject(ref);
  if (!p) throw new Error('项目不存在');
  const rows = db
    .prepare("SELECT * FROM tasks WHERE project_id = ? AND status = 'done' ORDER BY updated_at DESC")
    .all(p.id);
  const L = [];
  L.push(`# 产出汇总：${p.name}`);
  L.push('');
  L.push(`生成时间：${fmtTs(Date.now())} · 已完成任务 ${rows.length} 条`);
  L.push('');
  L.push('---');
  L.push('');
  for (const t of rows) {
    L.push(`## #${t.id} [${t.code}] ${t.title}`);
    L.push('');
    L.push(`认领人：${t.assignee || '-'} · 完成时间：${fmtTs(t.updated_at)}`);
    L.push('');
    L.push(t.result ? t.result : '_（未填写产出）_');
    L.push('');
  }
  return L.join('\n');
}

module.exports = { buildTaskReport, buildProjectReport, buildDeliverables, STATUS_LABEL };
