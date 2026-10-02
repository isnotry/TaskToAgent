# taskcli —— 本地任务看板

一个 **本地优先** 的任务看板：用 **Node CLI** 快速增删改查，配合 **网页看板** 可视化操作，两者共用同一份 SQLite 数据库。零外部依赖、数据全在本地、可直接被 agent 调用。

## 特性

- **本地存储**：数据存于本地 SQLite 文件（默认 `~/.taskcli/taskcli.db`），不联网、不依赖云端。
- **双端互通**：CLI 与网页看板读写同一份数据库，任一边改动另一边立即可见。
- **项目（看板）隔离**：用 project 区分不同看板，每个看板内是任务记录。
- **七列看板**：灵感区 → 待办 → 进行中 → 阻塞 → 待验收 → 已完成 → 存档，支持面板内直接添加、图标移动。
- **多 agent 协作**：任务可被**原子认领**（`task next` / `task claim`）+ **租约心跳**（`heartbeat`），到期自动回收；支持**依赖 DAG**（B 等 A 完成）与 `ready` 就绪判定；失败自动计数重试，超限转 `blocked` 等人工。
- **独立编号**：每个任务自动获得全局唯一编号（如 `T-QP4E54`），可在 CLI / 网页中引用与检索。
- **模糊搜索**：`taskcli task search <关键词>` 或网页顶部搜索框，跨项目模糊匹配 编号 / 标题 / 内容 / 项目名，多关键词以空格分隔按 AND 组合。
- **Agent 友好**：所有命令支持 `--json`，输出统一为 `{"ok":true,"data":...}` / `{"ok":false,"error":{"code":..,"message":..}}`；批量添加用 `--batch` 从 stdin 读 JSON；破坏性操作需 `--yes`，无 TTY 阻塞；语义化退出码让 agent 无需解析文本即可分支处理。
- **MCP server**：`taskcli mcp` 以 stdio JSON-RPC 暴露 20 个工具，支持 MCP 的 agent 可直接调用，无需拼命令（详见 `AGENT.md`）。
- **自描述引导**：`taskcli agent` 内置完整上手指南（`--json` 出机读版）；`taskcli mcp --print-config` 直接输出 MCP 配置；踩空时输出 `hint` 告诉你下一步；仓库根 `CODEBUDDY.md` / `CLAUDE.md` 供 agent 自动加载。
- **审计与备份**：所有写操作记入 `events`（谁/何时/对哪条任务/做了什么），`taskcli events` 可查；`taskcli db backup` 做快照。
- **零运行时依赖**：存储用 Node 内置 `node:sqlite`，前端构建用 Vite + React + Arco Design，无需 `npm install` 即可通过 `npm run web` 启动（构建产物已提交）。

## 目录结构

```
taskcli/
├── bin/taskcli            # CLI 入口（可执行）
├── src/
│   ├── db.js              # 建库/建表 + 认领/租约/依赖等协作原语（node:sqlite，WAL + busy_timeout）
│   ├── sqlite-guard.js    # node:sqlite 前置检查（Node < 22.13 给友好报错，替代模块堆栈）
│   ├── cli.js             # CLI 全部命令逻辑（含 doctor 环境自检）
│   └── mcp.js             # MCP server（stdio JSON-RPC，零依赖）
├── AGENT.md               # agent 接入约定（MCP 配置 / 标准循环 / 契约 / 规矩）
├── web/
│   ├── server.js          # 零依赖 http 服务：REST API + 托管前端
│   ├── public/dist/       # 前端构建产物（已提交，开箱即用）
│   └── ui/                # 前端源码（Vite + React + Arco）
├── package.json
└── README.md
```

## 快速开始

### 0. 环境要求（必读）

本项目用 Node 内置模块 `node:sqlite` 存储，**要求 Node.js >= 22.13**（22.12 实测报 `ERR_UNKNOWN_BUILTIN_MODULE`，官方文档常写的「22.5+」不准确）。

跑不起来时先执行自检，一次看清问题：

```bash
node bin/taskcli doctor
```

输出示例：

```
taskcli doctor   Node=v22.22.2  DB=/Users/kingsir/.taskcli/taskcli.db

✔ Node 版本   v22.22.2（需要 >= 22.13，因内置模块 node:sqlite）
✔ 数据库文件  /Users/kingsir/.taskcli/taskcli.db（76.0 KB）
✔ 数据可读    7 张表，1 个看板 / 3 个任务
✔ 网页服务    http://127.0.0.1:3979（运行中）
✔ 前端产物    /Users/kingsir/Documents/AI/projects/taskcli/web/dist/index.html

✔ 全部正常
```

### 1. CLI（独立运行，无需 server）

```bash
# 用托管 Node 直接调用
/Users/kingsir/.workbuddy/binaries/node/versions/22.22.2-5/bin/node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli <命令>

# 或注册全局命令后直接用 taskcli
cd /Users/kingsir/Documents/AI/projects/taskcli
/Users/kingsir/.workbuddy/binaries/node/versions/22.22.2-5/bin/npm link
taskcli help
```

### 2. 网页看板

```bash
cd /Users/kingsir/Documents/AI/projects/taskcli
npm run web
# 浏览器打开 http://localhost:3979
```

## CLI 命令

查看帮助：`taskcli help` / `taskcli project --help` / `taskcli task --help`

**项目（看板）**
| 命令 | 说明 |
|---|---|
| `taskcli project list` | 列出所有看板（含任务数） |
| `taskcli project add <名称> [--desc <描述>]` | 新建看板 |
| `taskcli project rename <id\|名称> <新名称>` | 改名 |
| `taskcli project remove <id\|名称> --yes` | 删除（连带删除其下任务） |

**任务（记录）**
| 命令 | 说明 |
|---|---|
| `taskcli task list [--project <名称>] [--status <s>]` | 列出记录 |
| `taskcli task add <标题> --project <名称> [--content <内容>] [--status <s>] [--priority low\|normal\|high]` | 加一条 |
| `taskcli task add --project <名称> --batch` | 从 stdin 批量加多条 |
| `taskcli task update <id> [--title] [--content] [--status] [--priority] [--project]` | 改 |
| `taskcli task remove <id> --yes` | 删 |
| `taskcli task show <id>` | 看单条详情 |
| `taskcli task search <关键词>` | 模糊搜索（编号/标题/内容/项目，空格分隔多关键词为 AND） |
| `taskcli task log <id> <内容>` | 写一条执行日志（也可用 `--content=...`） |
| `taskcli task logs <id>` | 查看执行日志 |

**Agent 联动（认领 / 租约 / 结果 / 依赖）**
| 命令 | 说明 |
|---|---|
| `taskcli task next [--project P] [--agent A] [--lease 30m] [--status todo]` | 取下一个**依赖已就绪且无人认领**的任务并原子认领（含日志一起返回） |
| `taskcli task start <id> [--agent A] [--lease 30m]` | 「开始做这条」= 认领 + 置为进行中（推荐给 agent 的直觉入口） |
| `taskcli task claim <id> [--agent A] [--lease 30m]` | 认领指定任务（`start` 的同义写法）；已被别人持有则返回 `CONFLICT`（退出码 3） |
| `taskcli task heartbeat <id> [--agent A] [--lease 30m]` | 续租；未认领时等价于 claim。长任务请定期调用 |
| `taskcli task release <id> [--agent A]` | 放弃任务，回到待办 |
| `taskcli task done <id> [--result "产出"] [--agent A]` | 标记完成并留存产出 |
| `taskcli task fail <id> [--error "原因"] [--max 3] [--no-retry]` | 失败计数；未达上限回 `todo` 重试，超限转 `blocked` |
| `taskcli task dep add <id> --on <依赖id>` | 设置依赖：本任务等被依赖任务 `done` 后才可认领（自动防环） |
| `taskcli task dep list\|rm <id> [--on <依赖id>]` | 查看 / 移除依赖 |
| `taskcli task ready [--project P]` | 列出可开工任务（只观察，不认领） |

**产物导出**
| 命令 | 说明 |
|---|---|
| `taskcli report [--project P] [--task <id>] [--out <文件\|目录>] [--deliverables] [--no-logs]` | 把任务 + 执行日志 + 产物 + 依赖汇总成 Markdown；`--out` 落盘，不带则打印到终端 |
| `taskcli task assign <id> --agent <名称> [--force]` | 指定 / 纠正认领人（agent 身份填错时用它改，不动状态） |

> agent 协作约定：**先把任务做完，做完再问**（不要在执行中途停下来询问；不确定的点用 `task log` 记下，收尾统一写进 `task done --result` 的「待确认：…」）。**过程**写 `task log`，**结果**写 `task done --result`，**交付**用 `taskcli report`；不要把执行过程拆成一堆待办任务。

**入门 / 自描述**
| 命令 | 说明 |
|---|---|
| `taskcli agent [--json]` | 打印内置上手指南（最小循环 + 要点 + 退出码），给新 agent / 新同事用 |
| `taskcli mcp --print-config` | 输出可直接粘贴到 MCP 客户端的 `mcpServers` 配置 |

**审计与维护**
| 命令 | 说明 |
|---|---|
| `taskcli doctor` | 环境自检：Node 版本 / 数据库文件 / 表结构与数据 / 网页服务 / 前端产物 |
| `taskcli events [--kind <类型>] [--task <id>] [--actor <名称>] [--limit 50]` | 审计流水（新的在前） |
| `taskcli db backup [--out <目录>] [--name <文件名>]` | 数据库快照（先 `wal_checkpoint(TRUNCATE)` 再复制，保证自包含） |
| `taskcli db path` | 打印当前数据库文件路径 |
| `taskcli mcp` | 以 MCP server 模式运行（stdio JSON-RPC） |

事件类型：`project.add` `project.remove` · `task.add` `task.update` `task.remove` · `task.claim` `task.heartbeat` `task.reclaim` `task.release` · `task.done` `task.fail` · `task.log` · `task.dep.add` `task.dep.rm` · `db.backup`

状态（status）：`idea`(灵感区) \| `todo`(待办) \| `doing`(进行中) \| `blocked`(阻塞，等人工/外部) \| `review`(待验收) \| `done`(已完成) \| `archive`(存档)
优先级（priority）：`low`(低) \| `normal`(普通) \| `high`(高)
租约（lease）：`30m` / `2h` / `90s` / 毫秒数，默认 `30m`；到期未续租的任务会被自动回收回待办并留下系统日志

### 示例

```bash
# 建看板
taskcli project add "Web重构" --desc "2026 官网改版"

# 加一条任务到「待办」
taskcli task add "搭建组件库" --project Web重构 --content "基于 Arco" --status todo --priority high

# 批量加多条（agent 最常用）
echo '[{"title":"登录页","content":"OAuth","status":"doing"},{"title":"埋点"},{"title":"灵感：做个定时提醒","status":"idea"}]' \
  | taskcli task add --project Web重构 --batch

# 把 id=3 的任务移到「已完成」
taskcli task update 3 --status done

# JSON 输出（便于脚本/agent 解析）
taskcli task list --project Web重构 --json

# 删除需显式 --yes（防误删，无 TTY 阻塞）
taskcli task remove 3 --yes

# 模糊搜索：单关键词
taskcli task search "组件库"
# 多关键词 AND（同时包含「周报」与「汇总」）
taskcli task search "周报 汇总"
# 也可直接按编号搜
taskcli task search "T-QP4E54"
```

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `TASKCLI_DB` | 指定数据库文件路径 | `~/.taskcli/taskcli.db` |
| `TASKCLI_PROJECT` | 默认看板（省去每条 `--project`） | 无 / 首个项目 |
| `TASKCLI_AGENT` | 默认 agent 身份（省去每条 `--agent`） | `agent` |
| `TASKCLI_PORT` | 网页服务端口 | `3979` |
| `TASKCLI_HOST` | 网页服务监听地址 | `127.0.0.1`（仅本机） |

## 给 Agent 的要点

### 一次标准工作循环

```bash
export TASKCLI_AGENT=codebuddy

# 1) 取任务（原子认领，返回任务 + 项目名 + 历史日志）
taskcli task next --project "Web重构" --json          # 退出码 2 = 暂无任务，正常退出即可
# 2) 过程中随时记日志（可选但推荐，便于人复盘）
taskcli task log 12 "定位到问题在 src/db.js:88"
# 3) 长任务定期续租，防止被判定为中断
taskcli task heartbeat 12 --lease 30m
# 4) 收尾：成功 / 失败
taskcli task done 12 --result "已修复并补测试"
taskcli task fail 12 --error "编译报错：xxx"          # 自动重试，超过 --max 次转 blocked
```

### 契约与退出码

- **`--json` 统一结构**：成功 `{"ok":true,"data":...}`；失败 `{"ok":false,"error":{"code":"...","message":"..."}}`（失败也走 stdout，便于解析）。
- **退出码**：`0` 成功 · `1` 业务错误 · `2` 无可执行任务 · `3` 认领冲突 · `4` 用法错误 · `5` 需要 `--yes`。agent 直接按码分支，不必匹配文本。
- **常见 `code`**：`NO_TASK` `CONFLICT` `DEP_NOT_READY` `NOT_FOUND` `USAGE` `CONFIRM_REQUIRED` `INVALID_DEP` `EXISTS`。
- **`--batch`**：一条命令插多条记录，避免反复调用；条目可带 `key` 做幂等。
- **幂等**：`task add --key <幂等键>` 或批量条目里的 `key`，重复调用不会创建重复任务。
- **`--yes` 强制**：`remove` 必须带 `--yes`，被 agent 调用时不会卡在交互确认。
- **DB 隔离**：用 `TASKCLI_DB=/path/to/agent.db` 为每个 agent / 任务隔离数据，互不干扰。
- **并发安全**：认领是单条 `UPDATE ... WHERE` 原子操作，多个 agent 同时 `next` 不会拿到同一条任务。

### 依赖编排

```bash
taskcli task add "实现接口" --project P --json            # 假设 id=1
taskcli task add "写文档"   --project P --json            # 假设 id=2
taskcli task dep add 2 --on 1                             # 文档等接口完成
taskcli task ready --project P                            # 此时只有 1 可开工
taskcli task done 1 --result "接口已上线"
taskcli task ready --project P                            # 1 完成后 2 才出现
```

## agent 身份（名字总被填错）

身份由**服务端配置**决定，不采信 agent 自己传的名字：

```bash
taskcli config set agent workbuddy          # 默认身份（CLI / MCP 都没指定时用它）
taskcli config alias codebuddy workbuddy    # 填错自动纠正：codebuddy → workbuddy
taskcli task assign --from codebuddy --to workbuddy   # 批量纠正已认领的任务
taskcli config                              # 查看当前配置
```

- MCP：身份在启动配置里定（`mcp --print-config` 会写入 `TASKCLI_AGENT`），工具调用里传的 `agent` **一律忽略**；需要允许覆盖时给 server 加环境变量 `TASKCLI_MCP_ALLOW_AGENT_ARG=1`。
- 配置落在 `~/.taskcli/config.json`（可用 `TASKCLI_CONFIG` 覆盖）；优先级：`--agent` > `TASKCLI_AGENT` > 配置 > `agent`，最后统一过一遍别名纠正。
- 纠正发生时会在 `hint` 里说明，并记录 `task.assign` 事件。

## MCP 集成

支持 MCP 的 agent 可直接以工具方式操作看板，无需拼接 shell：

```bash
node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli mcp
# 输出可直接粘贴的客户端配置：追加 --print-config [--agent <名字>]
```

协议 `2024-11-05`，stdio JSON-RPC，暴露 22 个工具：`project_list/add`、`task_list/show/search/add/update`、`task_next/claim/heartbeat/release/done/fail`、`task_log/logs`、`task_deps/dep_add/dep_rm`、`task_ready`、`task_assign`、`task_report`、`events`。客户端配置示例与调用约定见 `AGENT.md`。

## 技术栈

- 存储：Node 内置 `node:sqlite`（WAL + `busy_timeout=5000`，支持 CLI 与 Web 多进程并发读写）
- 后端：`web/server.js` 用 Node 内置 `http` 提供 REST API + 静态服务 + SSE 事件流（零依赖，默认只监听 `127.0.0.1`）
- 前端：`web/ui` 为 Vite + React 18 + `@arco-design/web-react`，构建产物在 `web/dist`

## HTTP API（供 agent 或非 Node 客户端使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表（含任务数） |
| POST/PATCH/DELETE | `/api/projects[/:id]` | 新建 / 重命名 / 删除 |
| GET | `/api/projects/:id/tasks` | 某看板全部任务 |
| GET | `/api/projects/:id/ready` | 可开工任务（依赖就绪 + 无人认领） |
| POST | `/api/projects/:id/tasks` | 新建任务 |
| GET | `/api/search?q=` | 全局模糊搜索（`&project=<id>` 限定范围） |
| POST | `/api/tasks/next` | 取下一个任务并原子认领（body: `project`/`project_id`、`agent`、`lease`、`statuses`） |
| POST | `/api/tasks/:id/claim` | 认领（冲突 409 + `code=CONFLICT`） |
| POST | `/api/tasks/:id/heartbeat` | 续租 |
| POST | `/api/tasks/:id/release` | 释放回待办 |
| POST | `/api/tasks/:id/done` | 完成（body: `result`、`agent`） |
| POST | `/api/tasks/:id/fail` | 失败计数（body: `error`、`max`、`retry`） |
| PATCH | `/api/tasks/:id` | 更新字段（含 `result`、`last_error`） |
| GET/POST/DELETE | `/api/tasks/:id/deps[/:dep]` | 依赖的查看 / 添加 / 删除 |
| GET/POST/DELETE | `/api/tasks/:id/tracks`、`/api/tracks/:id` | 执行日志 |
| GET | `/api/events` | **SSE 事件流**：只有数据变化才推 `changed`（带变更摘要），没变化只发心跳；`?interval=2000` 可调探测间隔 |
| GET | `/api/activity` | 审计事件流水（`?limit=&kind=&task=&actor=`） |

错误响应保留 `error` 字符串并附带 `code`，与 CLI 同一套语义，例如：`{"error":"...","code":"CONFLICT"}`。

## 数据库 Schema

- `projects`(id, name, description, created_at, updated_at)
- `tasks`(id, project_id, code, title, content, status, priority, position, created_at, updated_at, **assignee, claimed_at, lease_until, attempts, last_error, result, external_key**) —— `code` 为全局唯一独立编号（如 `T-QP4E54`），由程序自动生成；`external_key` 为幂等键（唯一索引，空值不参与）；认领相关字段用于多 agent 并发安全
- `task_deps`(task_id, depends_on_id, created_at) —— 任务依赖（DAG），被依赖任务 `done` 后才可认领本任务；加边时自动做环检测
- `task_tracks`(id, task_id, content, created_at) —— 任务下的子跟踪记录（执行日志 / 系统事件，如租约回收），外键 `ON DELETE CASCADE` 随任务删除
- `events`(id, ts, kind, actor, task_id, project_id, detail) —— 审计流水
- `meta`(key, value) —— 记录默认项目等
- 删除项目级联删除其下任务（应用层处理）；删除任务级联删除其跟踪记录（数据库外键）

## 备注

- 当前未打 git tag，提交默认不推送（用户偏好）。
- 网页看板需后台常驻 `web/server.js` 进程；如需开机自启可注册 `launchd` / `pm2`。
- 看板是**事件驱动**刷新，不是定时轮询：服务端每 `1s` 探测一次数据版本号（默认，`TASKCLI_SSE_INTERVAL_MS` 或 `?interval=` 可调 0.3~10s），**只有变化才推 `changed`**；没变化不发事件（仅每 ~15s 一个心跳注释），前端不会发任何请求。
- `changed` 里带增量变更摘要（`kind / task_id / project_id / actor`），看板据此判断：变更涉及当前看板才重新拉任务列表，否则只更新左侧任务数。CLI / MCP / 网页三端的写入都能触发。
- 头部会显示「已同步 时:分:秒」，可直观看到最近一次刷新时间。
- 服务默认只监听 `127.0.0.1`；确需局域网访问时用 `TASKCLI_HOST=0.0.0.0 npm run web`（注意无任何鉴权）。
