'use strict';

/**
 * 内置「agent 上手指南」。
 *
 * 目的：让任何一个刚接触本仓库的 agent，只要能执行到 t2a（哪怕是别人告诉它
 * `node <repo>/bin/t2a agent`），就能立刻知道该怎么取任务、怎么推进状态，
 * 而不需要先找到并读完 AGENT.md / README。
 *
 * 同时导出结构化版本，供 --json 消费（agent 之间传递指令时更好解析）。
 */

const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'bin', 't2a');

// 最小可用循环：按顺序执行即可完成一个任务
const LOOP = [
  {
    step: 1,
    do: '选看板',
    cmd: 't2a project list --json',
    note: '没有看板就 t2a project add "<名称>"',
  },
  {
    step: 2,
    do: '取任务（自动从「待办」移到「进行中」并锁给你）',
    cmd: 't2a task next --project <看板> --agent <你的名字> --json',
    note: '成功即表示该任务已是 doing 且归你；退出码 2=暂无任务，3=被别人抢走（换一条）',
  },
  {
    step: 3,
    do: '干活并留痕',
    cmd: 't2a task log <id> "做了什么"',
    note: '长任务记得 t2a task heartbeat <id> --agent <名字> --lease 30m',
  },
  {
    step: 4,
    do: '收尾（把产出写进 result，不是写成新任务）',
    cmd: 't2a task done <id> --result "产出说明"',
    note: '失败用 t2a task fail <id> --error "原因"（自动重试，超 3 次转 blocked 等人工）',
  },
  {
    step: 5,
    do: '交付（把过程和产物汇总成一份文档给人看）',
    cmd: 't2a report --project <看板> --out <目录>',
    note: '只要产出摘要用 --deliverables；--task <id> 只导单条；不带 --out 则打印到终端',
  },
];

/** 开工即提醒：自主做到底，别中途停下问 */
const AUTONOMY_RULE =
  '把这条任务做到底再问人：执行过程中不要中途停下来询问；拿不准的点先按最佳判断做并在 task log 里记一笔，最后统一写进 task done --result 的「待确认：…」，人看完一次性答复。';

const RULES = [
  AUTONOMY_RULE,
  '**身份要写对**：用 `--agent <你的名字>` 或环境变量 `T2A_AGENT` 设置真实身份（例如 `workbuddy`），否则看板上显示的认领人会是默认值，人分不清是谁做的。写错了用 `t2a task assign <id> --agent <名字> --force` 纠正。',
  '**过程写日志、结果写产出，都不要建成任务**：执行过程用 `task log <id> "..."`；结论/交付物写进 `task done <id> --result "..."`；最后用 `t2a report --out <目录>` 导出一份 Markdown 给人。只有「下一步还要做的事」才值得新建任务。',
  '**不要**用 `task update <id> --status doing` 手动移状态——那会绕过认领，多个 agent 会撞车；用 `task next` / `task start`。',
  '取到任务后必须定期 `heartbeat`（默认租约 30 分钟），否则会被系统判定中断并回收回待办。',
  '建任务时用 `--key <幂等键>`，重试不会重复创建。',
  '有依赖顺序时用 `task dep add <本任务> --on <前置任务>`，前置 done 后本任务才会出现在 `task next` 里。',
  '不要凭记忆猜 id，用 `task ready` / `task search <关键词>` 先查。',
  '内容较长时用 `--content="..."` 形式传参，避免被 shell 分词截断。',
];

const EXIT_CODES = {
  '0': '成功',
  '1': '业务错误（不存在、依赖未就绪等）',
  '2': '没有可执行的任务（正常情况，退出即可）',
  '3': '认领冲突（已被别的 agent 持有）',
  '4': '用法错误（参数写错了）',
  '5': '需要 --yes 确认',
};

const GUIDE_JSON = {
  entry: ENTRY,
  run: `node "${ENTRY}" <命令>`,
  mcp: {
    start: `node "${ENTRY}" mcp`,
    printConfig: `node "${ENTRY}" mcp --print-config`,
    protocol: '2024-11-05',
    toolCount: 20,
  },
  loop: LOOP,
  rules: RULES,
  exitCodes: EXIT_CODES,
  errors: {
    NO_TASK: '当前没有可认领的任务，换看板或稍后再试',
    CONFLICT: '任务已被别的 agent 认领，换一条',
    DEP_NOT_READY: '前置依赖还没完成，先做前置任务',
    NOT_FOUND: 'id 不存在，先 task list / task search 确认',
    USAGE: '参数写错，执行 t2a <资源> --help 看用法',
    CONFIRM_REQUIRED: '破坏性操作需要追加 --yes',
  },
};

const GUIDE_TEXT = `TaskToAgent（命令 t2a）· agent 上手指南（60 秒）

入口：node "${ENTRY}" <命令>
（若已 npm link，可直接用 t2a；旧名 taskcli 仍可照常使用）

一、最小循环
${LOOP.map(
  (s) => `${s.step}. ${s.do}
   ${s.cmd}
   ${s.note}`
).join('\n')}

二、要点
${RULES.map((r) => `- ${r}`).join('\n')}

三、退出码
${Object.entries(EXIT_CODES)
  .map(([k, v]) => `  ${k}  ${v}`)
  .join('\n')}

四、MCP（推荐，省去拼命令）
  启动：node "${ENTRY}" mcp
  配置：node "${ENTRY}" mcp --print-config   # 直接输出 mcpServers 片段

完整约定见仓库 AGENT.md；人类说明见 README.md。
`;

// 给 MCP 客户端的 server instructions：握手即注入模型上下文，不必等它去读文档
const INSTRUCTIONS = [
  '任务协作：所有任务先自己做完，做完后一次性询问，不要中途停下来问。',
  '拿不准的点按最佳判断先做，用 task_log 记一笔，收尾时统一写进 task_done 的 result 里「待确认：…」。',
  '开工用 task_next（自动认领并置为进行中）；不要用 task_update 手动改状态。',
  '执行过程写 task_log，结论/交付物写 task_done 的 result，不要把过程建成新任务。',
  '交付：做完调 task_report 生成 Markdown 报告给人。',
  '身份用 T2A_AGENT（如 workbuddy）；长任务记得 task_heartbeat 续租。',
].join('\n');

module.exports = {
  GUIDE_TEXT,
  GUIDE_JSON,
  ENTRY,
  REPO,
  LOOP,
  RULES,
  EXIT_CODES,
  AUTONOMY_RULE,
  INSTRUCTIONS,
};
