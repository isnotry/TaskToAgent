# TaskToAgent · 本地任务看板

**简体中文** | [English](README.en.md)

![零依赖](https://img.shields.io/badge/dependencies-0-brightgreen)
![零构建](https://img.shields.io/badge/build-none-blue)
![数据不出本机](https://img.shields.io/badge/data-local--only-orange)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> 人和 agent 写在同一块本地看板上：任务分七列流转，谁认领、做到哪一步、卡在哪里，一眼看清。

![界面截图](https://cdn.jsdelivr.net/gh/isnotry/TaskToAgent@main/docs/screenshot.png)

---

## 它是什么

一个**本地优先**的任务看板，用 `t2a` 命令行快速增删改查，配合网页看板可视化操作，两端读写同一份 SQLite 数据库。**零外部依赖**，不联网、不登录，数据全在你自己机器上。设计目标是让 AI agent 也能用同一套机制接任务：认领、续租、写日志、交付产出，全部有结构化的接口。

## 特性

- **零外部依赖** —— 只用 Node 内置模块，无需 `npm install` 即可启动，构建产物已随仓库提交。
- **本地存储** —— 数据落在本地 SQLite 文件（默认 `~/.t2a/t2a.db`），不联网、不依赖任何云服务。
- **双端互通** —— 命令行与网页看板读写同一份数据库，任一边改动，另一边立即可见。
- **七列看板** —— 灵感区 → 待办 → 进行中 → 阻塞 → 待验收 → 已完成 → 存档，面板内可直接添加、拖动。
- **原子认领** —— `task next` 用单条 `UPDATE ... WHERE` 完成认领，多个 agent 同时抢也不会拿到同一条任务。
- **租约心跳** —— 认领默认带 30 分钟租约，长任务定期 `heartbeat` 续租；到期自动回收回待办并留下系统日志。
- **依赖编排** —— 支持任务依赖 DAG（等 A 完成才能做 B），加边时自动检测环，`ready` 只列出可开工任务。
- **结构化输出** —— 所有命令支持 `--json`，统一返回 `{"ok":true,"data":...}`；语义化退出码让 agent 不解析文本即可分支。
- **MCP server** —— `t2a mcp` 以 stdio JSON-RPC 暴露 22 个工具，支持 MCP 的 agent 可直接调用，不用拼命令。
- **审计与备份** —— 所有写操作记入 `events` 审计流水，`t2a db backup` 做自包含快照。

## 快速开始

### 环境要求

存储用 Node 内置的 `node:sqlite`，**要求 Node.js >= 22.13**（22.12 实测报 `ERR_UNKNOWN_BUILTIN_MODULE`）。跑不起来先自检：

```bash
node bin/t2a doctor
```

### 本地使用

```bash
# 网页看板（默认 http://127.0.0.1:3979）
npm run web

# 命令行
node bin/t2a help
```

## 命令行速查

**看板与任务**

| 命令 | 说明 |
|---|---|
| `t2a project list` | 列出所有看板（含任务数） |
| `t2a project add <名称> [--desc <描述>]` | 新建看板 |
| `t2a task add <标题> --project <名称> [--content] [--status] [--priority]` | 加一条任务 |
| `t2a task add --project <名称> --batch` | 从 stdin 批量加多条（agent 最常用） |
| `t2a task list [--project] [--status]` | 列出任务 |
| `t2a task search <关键词>` | 模糊搜索（编号 / 标题 / 内容 / 项目名，多关键词按 AND） |
| `t2a task update <id> [--title] [--content] [--status]` | 修改 |
| `t2a task remove <id> --yes` | 删除（`--yes` 必填，无 TTY 时不阻塞） |
| `t2a report [--project P] [--out <文件>]` | 把任务 + 日志 + 产出导成 Markdown |

**agent 联动**

| 命令 | 说明 |
|---|---|
| `t2a task next [--project P] [--lease 30m]` | 取下一个可开工任务并原子认领 |
| `t2a task start <id>` | 「开始做这条」= 认领 + 置为进行中 |
| `t2a task claim <id> [--agent A]` | 认领指定任务；被他人持有返回 `CONFLICT`（退出码 3） |
| `t2a task heartbeat <id> [--lease 30m]` | 续租；未认领时等价于 `claim` |
| `t2a task release <id>` | 放弃任务，回到待办 |
| `t2a task done <id> --result "产出"` | 标记完成并留存产出 |
| `t2a task fail <id> --error "原因" [--max 3]` | 失败计数；未达上限回待办重试，超限转 `blocked` |
| `t2a task dep add <id> --on <依赖id>` | 设置依赖（自动防环） |
| `t2a task ready [--project P]` | 列出可开工任务（只观察，不认领） |

**审计与维护**

| 命令 | 说明 |
|---|---|
| `t2a doctor` | 环境自检：Node 版本 / 数据库 / 网页服务 / 前端产物 |
| `t2a events [--kind] [--task] [--actor] [--limit 50]` | 审计流水（新的在前） |
| `t2a db backup [--out <目录>]` | 数据库快照 |
| `t2a agent [--json]` | 打印内置上手指南（`--json` 出机读版） |
| `t2a mcp` | 以 MCP server 模式运行（stdio JSON-RPC） |

## 状态与退出码

看板七个列对应一个 `status` 值：

| status | 看板列 | 含义 |
|---|---|---|
| `idea` | 灵感区 | 还没想清楚，先记下来 |
| `todo` | 待办 | 排上了，未开始 |
| `doing` | 进行中 | 有人认领正在做 |
| `blocked` | 阻塞 | 卡住，等人工或外部条件 |
| `review` | 待验收 | 做完了，等人确认 |
| `done` | 已完成 | 验收通过 |
| `archive` | 存档 | 收起来，不在视野里 |

退出码是给 agent 用的，**不必解析文本即可分支**：

| 退出码 | 含义 | 建议动作 |
|---|---|---|
| `0` | 成功 | 继续 |
| `1` | 业务错误 | 读 `error.code` 决定 |
| `2` | 暂无任务 | 正常结束本轮 |
| `3` | 认领冲突 | 换一条任务 |
| `4` | 用法错误 | 修正命令 |
| `5` | 缺少 `--yes` | 补上确认标志 |

常见 `code`：`NO_TASK` `CONFLICT` `DEP_NOT_READY` `NOT_FOUND` `USAGE` `CONFIRM_REQUIRED` `INVALID_DEP` `EXISTS`。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `T2A_DB` | 指定数据库文件路径 | `~/.t2a/t2a.db` |
| `T2A_PROJECT` | 默认看板（省去 `--project`） | 无 / 首个项目 |
| `T2A_AGENT` | 默认 agent 身份 | `agent` |
| `T2A_PORT` | 网页服务端口 | `3979` |
| `T2A_HOST` | 网页服务监听地址 | `127.0.0.1`（仅本机） |

> `TASKCLI_*` 是历史名称（项目原名 `taskcli`），仍被识别但优先级低于 `T2A_*`，老脚本无需修改。

## agent 接入

支持 MCP 的客户端直接配 server，不用拼 shell：

```bash
node bin/t2a mcp --print-config
```

协议 `2024-11-05`，stdio JSON-RPC，暴露 22 个工具：`project_list/add`、`task_list/show/search/add/update`、`task_next/claim/heartbeat/release/done/fail`、`task_log/logs`、`task_deps/dep_add/dep_rm`、`task_ready`、`task_assign`、`task_report`、`events`。完整约定见 [AGENT.md](AGENT.md)。

不支持 MCP 也可以用 CLI，一次标准循环：

```bash
export T2A_AGENT=codebuddy
t2a task next --json            # 取任务（自动认领 + 置为进行中）
t2a task log 12 "定位到问题在 src/db.js:88"
t2a task heartbeat 12 --lease 30m
t2a task done 12 --result "已修复并补测试"
```

**agent 身份由服务端配置决定**，不采信 agent 自报的名字；填错了会自动纠正：

```bash
t2a config set agent workbuddy
t2a config alias codebuddy workbuddy
```

## 数据与隐私

数据只存在本机，不上传任何地方，页面也没有第三方统计。存储位置与作用：

| 位置 | 内容 | 说明 |
|---|---|---|
| `~/.t2a/t2a.db` | 看板、任务、日志、审计事件 | 默认位置，可用 `T2A_DB` 改 |
| `~/.t2a/config.json` | 默认 agent 身份与别名 | 权限 600 |

`.db` 文件已列入 `.gitignore`，不会被误提交。给每个 agent 单独开一个库即可隔离：`T2A_DB=/path/to/agent.db t2a task list`。

网页服务默认只监听 `127.0.0.1`。确需局域网访问时用 `T2A_HOST=0.0.0.0 npm run web`，**注意没有任何鉴权**，仅在可信网络里这么做。

## 目录结构

```text
TaskToAgent/
├── bin/t2a            # CLI 入口（可执行）
├── src/
│   ├── brand.js       # 品牌与路径解析（T2A_* 优先、TASKCLI_* 兼容）
│   ├── config.js      # 默认 agent 身份 + 错误名自动纠正
│   ├── db.js          # 建表 + 认领/租约/依赖等协作原语（node:sqlite）
│   ├── report.js      # 任务与项目报告、产物汇总
│   ├── agent-guide.js # 内置 agent 上手指南
│   ├── sqlite-guard.js# Node 版本前置检查（给友好报错而非模块堆栈）
│   ├── cli.js         # CLI 全部命令逻辑
│   └── mcp.js         # MCP server（stdio JSON-RPC，零依赖）
├── AGENT.md           # agent 接入约定（MCP 配置 / 标准循环 / 规矩）
├── web/
│   ├── server.js      # 零依赖 http 服务：REST API + 托管前端
│   ├── dist/          # 前端构建产物（已提交，开箱即用）
│   └── ui/            # 前端源码（Vite + React + Arco Design）
├── docs/              # README 配图
└── package.json
```

## 开发说明

改后端直接改 `src/` 下对应文件，无需构建。改前端需要重新构建并提交产物：

```bash
cd web/ui && npm install && npm run build
```

前端产物落在 `web/dist`，**已提交到仓库**，所以别人 clone 下来直接 `npm run web` 就能用，不必装前端依赖。

## 浏览器支持

网页看板是构建后的现代浏览器应用，需要支持 `fetch` 与 CSS Grid 的版本（Chrome / Edge / Firefox / Safari 近两年版本均可）。命令行与 MCP 不依赖浏览器。界面是响应式布局，窄屏下七列可横向滚动。

## 许可

[MIT](LICENSE) © 2026 isnotry
