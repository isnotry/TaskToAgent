# taskcli —— 本地任务看板

一个 **本地优先** 的任务看板：用 **Node CLI** 快速增删改查，配合 **网页看板** 可视化操作，两者共用同一份 SQLite 数据库。零外部依赖、数据全在本地、可直接被 agent 调用。

## 特性

- **本地存储**：数据存于本地 SQLite 文件（默认 `~/.taskcli/taskcli.db`），不联网、不依赖云端。
- **双端互通**：CLI 与网页看板读写同一份数据库，任一边改动另一边立即可见。
- **项目（看板）隔离**：用 project 区分不同看板，每个看板内是任务记录。
- **五列看板**：灵感区 → 待办 → 进行中 → 已完成 → 存档，支持面板内直接添加、图标移动。
- **独立编号**：每个任务自动获得全局唯一编号（如 `T-QP4E54`），可在 CLI / 网页中引用与检索。
- **模糊搜索**：`taskcli task search <关键词>` 或网页顶部搜索框，跨项目模糊匹配 编号 / 标题 / 内容 / 项目名，多关键词以空格分隔按 AND 组合。
- **Agent 友好**：所有命令支持 `--json` 结构化输出；批量添加用 `--batch` 从 stdin 读 JSON；破坏性操作需 `--yes`，无 TTY 阻塞。
- **零运行时依赖**：存储用 Node 内置 `node:sqlite`，前端构建用 Vite + React + Arco Design，无需 `npm install` 即可通过 `npm run web` 启动（构建产物已提交）。

## 目录结构

```
taskcli/
├── bin/taskcli            # CLI 入口（可执行）
├── src/
│   ├── db.js              # 建库/建表（node:sqlite，WAL + busy_timeout）
│   └── cli.js             # CLI 全部命令逻辑
├── web/
│   ├── server.js          # 零依赖 http 服务：REST API + 托管前端
│   ├── public/dist/       # 前端构建产物（已提交，开箱即用）
│   └── ui/                # 前端源码（Vite + React + Arco）
├── package.json
└── README.md
```

## 快速开始

### 1. CLI（独立运行，无需 server）

```bash
# 用托管 Node 直接调用
/Users/kingsir/.workbuddy/binaries/node/versions/22.22.2/bin/node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli <命令>

# 或注册全局命令后直接用 taskcli
cd /Users/kingsir/Documents/AI/projects/taskcli
/Users/kingsir/.workbuddy/binaries/node/versions/22.22.2/bin/npm link
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

状态（status）：`idea`(灵感区) \| `todo`(待办) \| `doing`(进行中) \| `done`(已完成) \| `archive`(存档)
优先级（priority）：`low`(低) \| `normal`(普通) \| `high`(高)

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
| `TASKCLI_PORT` | 网页服务端口 | `3979` |

## 给 Agent 的要点

- **`--json`**：任何 `list`/`show` 均输出结构化 JSON，直接解析。
- **`--batch`**：一条命令插多条记录，避免反复调用。
- **`--yes` 强制**：`remove` 必须带 `--yes`，被 agent 调用时不会卡在交互确认。
- **DB 隔离**：用 `TASKCLI_DB=/path/to/agent.db` 为每个 agent / 任务隔离数据，互不干扰。

## 技术栈

- 存储：Node 内置 `node:sqlite`（WAL + `busy_timeout=5000`，支持 CLI 与 Web 多进程并发读写）
- 后端：`web/server.js` 用 Node 内置 `http` 提供 REST API + 静态服务（零依赖）
- 前端：`web/ui` 为 Vite + React 18 + `@arco-design/web-react`，构建产物在 `web/dist`

## 数据库 Schema

- `projects`(id, name, description, created_at, updated_at)
- `tasks`(id, project_id, code, title, content, status, priority, position, created_at, updated_at) —— `code` 为全局唯一独立编号（如 `T-QP4E54`），由程序自动生成，旧库升级时自动回填
- `task_tracks`(id, task_id, content, created_at) —— 任务下的子跟踪记录，外键 `ON DELETE CASCADE` 随任务删除
- `meta`(key, value) —— 记录默认项目等
- 删除项目级联删除其下任务（应用层处理）；删除任务级联删除其跟踪记录（数据库外键）

## 备注

- 当前未打 git tag，提交默认不推送（用户偏好）。
- 网页看板需后台常驻 `web/server.js` 进程；如需开机自启可注册 `launchd` / `pm2`。
