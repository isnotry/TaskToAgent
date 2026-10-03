# AGENT.md —— 如何把 TaskToAgent 当任务后端用（命令 t2a）

面向在本仓库干活的 AI agent / 自动化脚本。任务、状态、日志都落在本地 SQLite（`~/.t2a/t2a.db`），CLI、网页看板、MCP 三条入口共用同一份数据。

## 四条最重要的规矩（先看这个）

0. **身份不用你操心**：认领人由服务端配置决定（`t2a config set agent workbuddy` + `t2a config alias codebuddy workbuddy`），MCP 工具调用里传的名字会被忽略，CLI 传错也会自动纠正。
1. **先把任务做完，做完再问。不要在任务执行中途停下来询问。**
   - 遇到拿不准的点：按最佳判断先做下去，用 `t2a task log <id> "..."` 记一笔假设；
   - 收尾时把所有不确定项统一写进 `t2a task done <id> --result "..."` 的 **「待确认：…」** 段落；
   - 人看完一次性答复，避免来回打断。
2. **过程 ≠ 任务**：执行过程写 `task log <id> "..."`；结论/交付物写进 `task done <id> --result "..."`。**不要把过程拆成一堆待办任务**——只有"下一步还要做的事"才值得建任务。
3. **交付要落地**：干完用 `t2a report --project <看板> --out <目录>` 导出一份 Markdown（含产出 + 完整执行日志 + 依赖）。人看的是这份报告，不是一个一个点开任务。

## 第一次接触：先跑这一条

```bash
node ./bin/t2a agent
```

CLI 内置了完整上手指南（最小循环 + 要点 + 退出码 + MCP 配置），`--json` 出机读版。任何 agent 只要能执行到 CLI，就不需要先找到并读完本文档。

命令报错跑不起来时，先跑 `node ./bin/t2a doctor`——它一次报清 Node 版本（需 >= 22.13，因内置 `node:sqlite`）、数据库路径与完整性、网页服务是否在跑、前端产物是否齐全，不要去猜模块堆栈。

此外：
- 仓库根目录的 `CODEBUDDY.md` / `CLAUDE.md` 会在对应 agent 进入仓库时自动加载，内容就是精简版约定。
- 输出带 `hint` 字段：踩空（没有可认领任务、没认领就改状态…）时会告诉你下一步该执行什么。
- `task start <id> --agent <名称>` 是"开始做这条"的直觉别名（= 认领 + 置为进行中）。

## 三种接入方式，按优先级选

1. **MCP（推荐给支持 MCP 的 agent）**：无需拼命令，直接调工具。
2. **CLI（通用，任何能跑 shell 的 agent）**：`--json` + 语义退出码。
3. **HTTP API**：非 Node 客户端或需要长连接事件流时用（`npm run web` 后）。

## 1) MCP

启动：`node ./bin/t2a mcp`（stdio JSON-RPC 2.0，协议版本 `2024-11-05`）

配置片段（CodeBuddy / Claude Desktop / Cline 等通用格式）：

```json
{
  "mcpServers": {
    "t2a": {
      "command": "node",
      "args": ["./bin/t2a", "mcp"],
      "env": { "T2A_AGENT": "codebuddy" }
    }
  }
}
```

可用工具（20 个）：

| 工具 | 作用 |
|---|---|
| `project_list` / `project_add` | 看板列表 / 新建 |
| `task_list` / `task_show` / `task_search` | 列表 / 详情（含日志）/ 模糊搜索 |
| `task_add` / `task_update` | 新建（支持 `key` 幂等）/ 改字段 |
| `task_next` | **取下一个可做任务并原子认领**（推荐入口） |
| `task_claim` / `task_heartbeat` / `task_release` | 认领 / 续租 / 放弃 |
| `task_done` / `task_fail` | 完成（带 `result`）/ 失败（带 `error`，自动重试） |
| `task_log` / `task_logs` | 写 / 读执行日志 |
| `task_deps` / `task_dep_add` / `task_dep_rm` | 依赖 DAG |
| `task_ready` | 可开工任务（只观察） |
| `events` | 审计流水 |

工具返回 `content[0].text` 为 JSON；失败时 `isError: true` 且文本为 `{"ok":false,"error":{"code":"...","message":"..."}}`。

## 2) CLI

```bash
# 用托管 Node 调用（不依赖全局安装）
NODE=node
CLI=./bin/t2a

$NODE $CLI task next --project "Web重构" --agent codebuddy --json
```

标准循环：

```bash
export T2A_AGENT=codebuddy
t2a task next   --project P            # 取任务（原子认领，自动移到「进行中」）
#   等价直觉写法：t2a task start <id> --project P
t2a task log    12 "正在重构 db.js"     # 过程留痕
t2a task heartbeat 12 --lease 30m     # 长任务续租，别让租约过期
t2a task done   12 --result "已修复"    # 或：t2a task fail 12 --error "编译失败"
```

收尾后导出交付物（这是给人的最终产出）：

```bash
t2a report --project <看板> --out ~/Desktop          # 完整报告（含执行日志）
t2a report --project <看板> --deliverables --out ... # 只要已完成任务的产出汇总
t2a report --task 12                                  # 单条任务（打印到终端）
```

**注意**：不要 `task update 12 --status doing` 手动移状态——那不会认领，别人也能同时抢同一条。开始做请用 `task next` / `task start`。如果确实这样做了，CLI 会返回 `hint` 提示正确姿势；带了 `--agent` 时会自动补认领。

## 契约

- `--json` 成功：`{"ok":true,"data":...}`；失败：`{"ok":false,"error":{"code":...,"message":...}}`（也走 stdout）。
- 退出码：`0` 成功 · `1` 业务错误 · `2` 无可执行任务 · `3` 认领冲突 · `4` 用法错误 · `5` 需要 `--yes`。
- 常见 `code`：`NO_TASK` · `CONFLICT` · `DEP_NOT_READY` · `NOT_FOUND` · `USAGE` · `CONFIRM_REQUIRED` · `INVALID_DEP` · `EXISTS`。

## 规矩

- **必须先 `task_next` / `task_claim` 再动手**，不要直接改状态——否则多 agent 会重复劳动。
- **认领后定期 `heartbeat`**（默认租约 30m），超时任务会被系统回收回待办。
- **用 `--key` / `key` 做幂等**，重试建任务不会产生重复条目。
- **失败用 `task_fail` 而不是默默跳过**，`attempts` 达上限（默认 3）会转 `blocked` 等人工。
- **多任务并行时**，用 `T2A_DB=/path/agent.db` 隔离数据，或在同一库里用不同 `--agent` 名协作（推荐后者，便于统一看板）。
- **不确定就 `task_ready` / `task_search` 先看**，别凭记忆猜任务 id。
- 任务 `content` 较长时用 `--content=...` 或 MCP 参数传，避免被 shell 分词截断。
