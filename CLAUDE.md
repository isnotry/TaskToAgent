# Task collaboration convention (read before working in this repo)

Tasks live in the local board **TaskToAgent** (command `t2a`; SQLite; CLI / web / MCP share one database). Not in chat memory.

> Renamed from `taskcli` on 2026-10-03. The old `taskcli` command still works; use `t2a` for anything new.

## First thing to run

```bash
node /Users/kingsir/Documents/AI/projects/TaskToAgent/bin/t2a agent
```

It prints the minimal loop, rules, exit codes and MCP config. **Run it before starting.**

If a command won't start (especially `No such built-in module: node:sqlite`), run `node /Users/kingsir/Documents/AI/projects/TaskToAgent/bin/t2a doctor` first — it reports Node version (needs >= 22.13), database path/integrity, whether the web server is up, and whether the frontend bundle exists.

## Four rules that matter

0. **Finish the task, then ask.** Don't stop mid-execution to ask. For uncertain points, pick the best judgment, note it with `task log`, and collect everything into `task done --result` under "待确认：…". The human answers once, at the end.
1. **Set your identity**: `--agent <name>` or `T2A_AGENT`. Otherwise everything shows as `agent`. Fix with `t2a task assign <id> --agent <name> --force`.
2. **Progress ≠ tasks**: log progress with `task log <id> "..."`, put conclusions in `task done <id> --result "..."`. Don't turn execution logs into a pile of todo tasks.
3. **Deliver a document**: finish with `t2a report --project <board> --out ~/Desktop` (Markdown with results + logs + deps).

## Minimal loop

```bash
CLI="node /Users/kingsir/Documents/AI/projects/TaskToAgent/bin/t2a"

$CLI project list --json                                  # 1. list boards
$CLI task next --project <board> --agent <your-name> --json # 2. claim (moves to doing, locks it to you)
$CLI task log <id> "what you did"                          # 3. log progress (+ heartbeat for long tasks)
$CLI task done <id> --result "outcome"                     # 4. finish; or task fail <id> --error "reason"
```

## Rules

- **Never** move a task with `task update <id> --status doing` — it bypasses claiming and collides with other agents. Use `task next` or `task start <id> --agent <your-name>`.
- Renew long-running work with `task heartbeat <id> --lease 30m` (lease defaults to 30 min; expired tasks are reclaimed).
- Exit code `2` = nothing to do (just stop), `3` = someone else claimed it (pick another).
- Use `--key <idempotency-key>` when creating tasks so retries don't duplicate.
- Look up ids with `task ready` / `task search <keyword>`; never guess.

## Preferred integration

If your client supports MCP:

```bash
node /Users/kingsir/Documents/AI/projects/TaskToAgent/bin/t2a mcp --print-config
```

Full convention: [AGENT.md](./AGENT.md). Human docs: [README.md](./README.md).