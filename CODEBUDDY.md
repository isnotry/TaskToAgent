# 任务协作约定（在本仓库干活前请先读）

本仓库的任务不走聊天记忆，统一放在本地看板 **taskcli**（SQLite，CLI / 网页 / MCP 三入口同一份数据）。

## 第一次上手：先跑这一条

```bash
node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli agent
```

它会打印最小循环、要点、退出码、MCP 配置。**开始前先执行它**，不要凭猜的命令操作。

命令跑不起来（尤其是 `No such built-in module: node:sqlite`）时，先跑 `node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli doctor`：它一次报清 Node 版本（需 >= 22.13）、数据库路径与完整性、网页服务是否在跑、前端产物是否齐全。本机可用 Node：`/Users/kingsir/.workbuddy/binaries/node/versions/22.22.2-5/bin/node`。

## 四条最重要的规矩

0. **身份不用填**：认领人由服务端配置决定（`taskcli config set agent workbuddy`、`taskcli config alias codebuddy workbuddy`），填错也会被自动纠正。
1. **先把任务做完，做完再问。** 执行中途不要停下来询问：拿不准的点按最佳判断做，用 `task log` 记一笔；收尾时统一写进 `task done --result` 的「待确认：…」，人一次性答复。
2. **过程 ≠ 任务**：过程写 `task log <id> "..."`，结论写 `task done <id> --result "..."`。不要把执行过程拆成一堆待办任务。
3. **交付要落地**：干完跑 `taskcli report --project <看板> --out ~/Desktop`，导出一份 Markdown（产出 + 执行日志 + 依赖）给人看。

## 标准循环（背下这四条即可）

```bash
CLI="node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli"

$CLI project list --json                                  # 1. 看有哪些看板
$CLI task next --project <看板> --agent <你的名字> --json  # 2. 取任务（自动移到「进行中」并锁给你）
$CLI task log <id> "做了什么"                              # 3. 过程留痕（长任务还要 heartbeat）
$CLI task done <id> --result "产出说明"                    # 4. 完成；失败用 task fail <id> --error "原因"
```

## 硬性规矩

- **不要用 `task update <id> --status doing` 手动移状态**，那会绕过认领、和其他 agent 撞车。开始做请用 `task next` 或 `task start <id> --agent <你的名字>`。
- 认领后长任务要 `task heartbeat <id> --lease 30m` 续租，默认租约 30 分钟，超时任务会被回收回待办。
- 退出码 `2`=暂无任务（正常结束即可），`3`=被别人抢了（换一条）。
- 建任务用 `--key <幂等键>`，重试不会重复创建。
- 不确定任务 id 就先 `task ready` / `task search <关键词>` 查，别猜。

## 更省事的接入

支持 MCP 的 agent 直接配 MCP，不用拼命令：

```bash
node /Users/kingsir/Documents/AI/projects/taskcli/bin/taskcli mcp --print-config
```

完整约定见 [AGENT.md](./AGENT.md)，人类文档见 [README.md](./README.md)。
