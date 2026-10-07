'use strict';

/**
 * 冒烟测试：每个工具都真调一遍，MCP 协议层也走一遍。
 *
 * 全程用临时数据库，绝不碰 ~/.t2a/t2a.db 真实数据。
 * 跑法：npm test
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require('./db') 之前设好，db.js 初始化时读一次
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-test-'));
process.env.T2A_DB = path.join(TMP_DIR, 'test.db');

const { handle, TOOLS } = require('../src/mcp');

// MCP 场景下认领人由服务端配置决定，不采信模型传入的 agent（见 mcp.js agentOf）
const SERVER_AGENT = process.env.T2A_AGENT || 'mcp';

/* ----------------------------- 小工具 ----------------------------- */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
  }
}

/** 直接调工具（失败时 ToolError 会抛出来） */
function call(name, args) {
  const tool = TOOLS[name];
  assert.ok(tool, `工具不存在: ${name}`);
  return tool.run(args || {});
}

/** 走 JSON-RPC 协议层，拿到解包后的结果 */
function rpc(method, params) {
  const res = handle({ jsonrpc: '2.0', id: 1, method, params });
  assert.ok(res, `${method} 不该回包`);
  assert.strictEqual(res.jsonrpc, '2.0');
  return res;
}

/** 走协议层调用工具，失败时返回 isError 而不是抛异常 */
function rpcCall(name, args) {
  const res = rpc('tools/call', { name, arguments: args || {} });
  assert.ok(res.result, 'tools/call 应返回 result');
  return res.result;
}

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

/* ----------------------------- 协议层 ----------------------------- */

console.log('协议层');

test('initialize 返回 serverInfo 与 instructions', () => {
  const r = rpc('initialize', {});
  assert.strictEqual(r.result.protocolVersion, '2024-11-05');
  assert.strictEqual(r.result.serverInfo.name, 'TaskToAgent');
  assert.ok(r.result.capabilities.tools, '应声明 tools 能力');
  assert.ok(r.result.instructions.length > 0, '应带协作说明');
});

test('tools/list 列出全部 22 个工具', () => {
  const tools = rpc('tools/list', {}).result.tools;
  assert.strictEqual(tools.length, Object.keys(TOOLS).length);
  assert.ok(tools.length >= 22, `实际 ${tools.length} 个`);
});

test('tools/list 每个工具都带四个显式 boolean hint', () => {
  const hints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
  for (const t of rpc('tools/list', {}).result.tools) {
    assert.ok(t.annotations, `${t.name} 缺少 annotations`);
    for (const h of hints) {
      assert.strictEqual(
        typeof t.annotations[h],
        'boolean',
        `${t.name}.${h} 必须是 boolean，实际 ${typeof t.annotations[h]}`
      );
    }
  }
});

test('hint 语义自洽：只读工具不能同时标成破坏性', () => {
  for (const t of rpc('tools/list', {}).result.tools) {
    const a = t.annotations;
    if (a.readOnlyHint) {
      assert.strictEqual(
        a.destructiveHint,
        false,
        `${t.name} 是只读工具，不能标destructiveHint`
      );
    }
  }
});

test('声明 openWorldHint 的工具应当真的碰外部（当前应全为 false）', () => {
  const ext = rpc('tools/list', {}).result.tools.filter((t) => t.annotations.openWorldHint);
  assert.deepStrictEqual(
    ext.map((t) => t.name),
    [],
    '本服务器不联网，任何工具都不该声明 openWorldHint'
  );
});

test('未知方法返回 -32601', () => {
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'nope/nope' });
  assert.strictEqual(r.error.code, -32601);
});

test('通知类消息不回包', () => {
  assert.strictEqual(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/call 出错时返回 isError 而非抛异常', () => {
  const r = rpcCall('task_show', { id: 999999 });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r).error.code, 'NOT_FOUND');
});

test('未知工具名报错', () => {
  const r = rpcCall('no_such_tool', {});
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r).error.code, 'UNKNOWN_TOOL');
});

/* ----------------------------- 项目 ----------------------------- */

console.log('项目');

test('project_list 初始为空', () => {
  assert.deepStrictEqual(call('project_list'), []);
});

test('project_add 新建看板并成为默认项目', () => {
  const p = call('project_add', { name: 'demo', description: '测试看板' });
  assert.strictEqual(p.name, 'demo');
  assert.ok(p.id > 0);
  assert.strictEqual(call('project_list').length, 1);
});

test('project_add 重名报错', () => {
  assert.throws(() => call('project_add', { name: 'demo' }), /项目已存在/);
});

/* ----------------------------- 任务 ----------------------------- */

console.log('任务');

let taskId = 0;
let depId = 0;

test('task_add 新增任务', () => {
  const t = call('task_add', { title: '写代码', status: 'todo', priority: 'high' });
  assert.ok(t.id > 0);
  assert.strictEqual(t.title, '写代码');
  assert.strictEqual(t.priority, 'high');
  taskId = t.id;
});

test('task_add 带 key 幂等：重复调用返回同一条', () => {
  const a = call('task_add', { title: '带key', key: 'smoke-key-1' });
  const b = call('task_add', { title: '带key', key: 'smoke-key-1' });
  assert.strictEqual(a.id, b.id, '相同 key 不应新建两条');
  depId = b.id;
});

test('task_show 返回详情与项目名', () => {
  const t = call('task_show', { id: taskId });
  assert.strictEqual(t.id, taskId);
  assert.strictEqual(t.project_name, 'demo');
  assert.ok(Array.isArray(t.tracks));
});

test('task_list 列出任务，status 可过滤', () => {
  assert.ok(call('task_list', {}).length >= 2);
  const doing = call('task_list', { status: 'doing' });
  assert.ok(Array.isArray(doing));
});

test('task_search 多关键词 AND 匹配', () => {
  assert.ok(call('task_search', { q: '写代码' }).length >= 1);
  assert.strictEqual(call('task_search', { q: '写代码 不存在词' }).length, 0);
});

test('task_update 改字段', () => {
  const t = call('task_update', { id: taskId, status: 'doing', result: '半成品' });
  assert.strictEqual(t.status, 'doing');
  assert.strictEqual(t.result, '半成品');
});

test('task_update 无可改字段时报错', () => {
  assert.throws(() => call('task_update', { id: taskId }), /没有可更新的字段/);
});

test('task_next 原子认领并置为 doing', () => {
  const t = call('task_next', { project: 'demo' });
  assert.strictEqual(t.status, 'doing');
  assert.ok(t.assignee, '应有认领人');
  assert.ok(t.hint, '应返回协作提示');
});

test('task_next 无可认领任务时报NO_TASK', () => {
  assert.throws(() => call('task_next', { project: 'demo' }), /没有可认领的任务/);
});

test('task_claim 终态任务不可认领', () => {
  // 此时 taskId 已被 task_next 认领走；同 agent 再认领是允许的（幂等续领）
  const t = call('task_claim', { id: taskId });
  assert.ok(t.id, '同agent 重复认领应成功');
  // 已完成的任务不可再认领
  const done = call('task_add', { title: '已完成的任务' });
  call('task_done', { id: done.id });
  assert.throws(
    () => call('task_claim', { id: done.id }),
    (e) => {
      assert.strictEqual(e.code, 'INVALID_STATUS');
      return true;
    }
  );
});

test('MCP 场景强制服务端身份：传入 agent 参数被忽略', () => {
  // 设计如此：MCP 下认领人不采信模型传参，由服务端配置决定（见 mcp.js agentOf）
  const before = call('task_show', { id: depId }).assignee;
  const t = call('task_assign', { id: depId, agent: 'hijacked-name', force: true });
  assert.notStrictEqual(t.assignee, 'hijacked-name', '不应采信传入的 agent');
  assert.strictEqual(t.assignee, before === null ? SERVER_AGENT : t.assignee);
});

test('task_heartbeat 未认领时等价于认领', () => {
  const t = call('task_heartbeat', { id: depId });
  assert.ok(t.assignee, '应完成认领');
});

test('task_log 写入并可读回', () => {
  call('task_log', { id: taskId, content: '第一步做完了' });
  const logs = call('task_logs', { id: taskId });
  assert.ok(logs.some((l) => l.content.includes('第一步做完了')));
});

test('task_done 标记完成并清租约', () => {
  const t = call('task_done', { id: taskId, result: '交付物一份' });
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.lease_until, null);
  assert.ok(call('task_logs', { id: taskId }).some((l) => l.content.includes('交付物一份')));
});

test('task_fail 计数未超max 时回到 todo', () => {
  const t = call('task_fail', { id: depId, error: '环境问题', max: 3 });
  assert.strictEqual(t.status, 'todo');
  assert.strictEqual(t.attempts, 1);
  assert.ok(t.last_error.includes('环境问题'));
});

test('task_fail 超 max 转blocked', () => {
  const t = call('task_fail', { id: depId, error: '又失败', max: 2 });
  assert.strictEqual(t.status, 'blocked');
  assert.strictEqual(t.attempts, 2);
});

test('task_release 回到 todo 并清空认领', () => {
  const t = call('task_release', { id: depId });
  assert.strictEqual(t.status, 'todo');
  assert.strictEqual(t.assignee, null);
});

test('task_assign 纠正认领人（认领人由服务端身份决定）', () => {
  const t = call('task_assign', { id: taskId, agent: 'someone-else', force: true });
  assert.strictEqual(t.assignee, SERVER_AGENT);
});

/* ----------------------------- 依赖 ----------------------------- */

console.log('依赖');

test('task_dep_add 建立依赖并防环', () => {
  const r = call('task_dep_add', { id: taskId, depends_on: depId });
  assert.strictEqual(r.depends_on_id, depId);
  // 反向成环必须被拒（这条 bug 曾让A→B / B→A 同时写入）
  assert.throws(
    () => call('task_dep_add', { id: depId, depends_on: taskId }),
    (e) => {
      assert.strictEqual(e.code, 'INVALID_DEP');
      return true;
    }
  );
  assert.throws(() => call('task_dep_add', { id: taskId, depends_on: taskId }), /循环依赖/);
});

test('task_dep_add 重复依赖报错', () => {
  assert.throws(
    () => call('task_dep_add', { id: taskId, depends_on: depId }),
    (e) => {
      assert.strictEqual(e.code, 'EXISTS');
      return true;
    }
  );
});

test('task_deps 能查到依赖', () => {
  const deps = call('task_deps', { id: taskId });
  assert.strictEqual(deps.length, 1);
  assert.strictEqual(deps[0].id, depId);
});

test('未完成依赖会阻塞 task_ready', () => {
  const ready = call('task_ready', { project: 'demo' });
  assert.ok(!ready.some((r) => r.id === taskId), 'taskId 依赖未完成，不该出现在 ready');
});

test('task_dep_rm 移除依赖后不再阻塞', () => {
  const r = call('task_dep_rm', { id: taskId, depends_on: depId });
  assert.strictEqual(r.depends_on_id, depId);
  assert.strictEqual(call('task_deps', { id: taskId }).length, 0);
});

test('task_dep_rm 移除不存在的依赖报 NOT_FOUND', () => {
  assert.throws(() => call('task_dep_rm', { id: taskId, depends_on: depId }), /依赖不存在/);
});

test('环检测：菱形（无环）不误报', () => {
  const mk = (title) => call('task_add', { title }).id;
  const a = mk('菱形 A');
  const b = mk('菱形 B');
  const c = mk('菱形 C');
  const d = mk('菱形 D');
  for (const [x, y] of [[a, c], [b, c], [a, d], [b, d]]) {
    assert.doesNotThrow(() => call('task_dep_add', { id: x, depends_on: y }), `无环依赖 ${x}->${y} 被误拒`);
  }
});

test('环检测：三跳环被拒（回归：遍历方向曾写反）', () => {
  const mk = (title) => call('task_add', { title }).id;
  const a = mk('环 A');
  const b = mk('环 B');
  const d = mk('环 D');
  // a 依赖 d
  call('task_dep_add', { id: a, depends_on: d });
  // b 依赖 a 合法：a→d，d 没有反向路径，构不成环
  assert.doesNotThrow(() => call('task_dep_add', { id: b, depends_on: a }), 'b→a 无环，应放行');
  // 现在 b→a→d；若再让 d 依赖 b，则 d→b→a→d 成环，必须被拒
  assert.throws(
    () => call('task_dep_add', { id: d, depends_on: b }),
    (e) => {
      assert.strictEqual(e.code, 'INVALID_DEP');
      return true;
    },
    'd→b→a→d 三跳环应被拒'
  );
});

test('task_ready 列出可开工任务', () => {
  const r = call('task_ready', { project: 'demo' });
  assert.ok(Array.isArray(r));
  assert.ok(r.some((x) => x.id === depId));
});

/* ----------------------------- 报告与审计 ----------------------------- */

console.log('报告与审计');

test('task_report 导出 Markdown', () => {
  const r = call('task_report', { project: 'demo' });
  assert.ok(r.markdown.includes('#'), '应是 Markdown 文本');
  assert.ok(r.markdown.length > 50);
});

test('task_report 可限定单个任务', () => {
  const r = call('task_report', { task: taskId });
  assert.ok(r.markdown.length > 0);
});

test('events 记录了写操作流水', () => {
  const evs = call('events', { limit: 100 });
  assert.ok(evs.length > 0);
  const kinds = new Set(evs.map((e) => e.kind));
  assert.ok(kinds.has('project.add'), '应有 project.add');
  assert.ok(kinds.has('task.add'), '应有 task.add');
  assert.ok(kinds.has('task.done'), '应有 task.done');
});

test('events 可按 kind 与 task 过滤', () => {
  const evs = call('events', { kind: 'task.dep.add' });
  assert.ok(evs.length >= 1);
  assert.ok(evs.every((e) => e.kind === 'task.dep.add'));
  assert.ok(call('events', { task: taskId }).every((e) => e.task_id === taskId));
});

/* ----------------------------- 收尾 ----------------------------- */

fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`\n${passed} 项通过, ${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) {
    process.stdout.write(`\n--- ${f.name}\n${f.err.stack}\n`);
  }
  process.exit(1);
}