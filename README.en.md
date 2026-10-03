# Local Task Board · TaskToAgent

**English** | [简体中文](README.md)

![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![no build](https://img.shields.io/badge/build-none-blue)
![data stays local](https://img.shields.io/badge/data-local--only-orange)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> Humans and agents write on the same local board: work flows through seven columns, and you can see at a glance who claimed what, how far it got, and where it is stuck.

![UI screenshot](https://cdn.jsdelivr.net/gh/isnotry/TaskToAgent@main/docs/screenshot.png)

---

## What it is

A **local-first** task board. The `t2a` command line handles quick create / update / delete, a web board handles visual work, and both read and write the same SQLite file. **Zero external dependencies** — no network, no login, your data never leaves your machine. It is designed so AI agents can plug into the same mechanism: claim a task, renew the lease, write progress, hand back a result — all through structured interfaces.

## Features

- **Zero external dependencies** —— Node built-ins only; runs without `npm install` because the build output is committed.
- **Local storage** —— Data lives in a local SQLite file (default `~/.t2a/t2a.db`); no network calls, no cloud service.
- **Two frontends, one database** —— CLI and web board read the same file; a change on either side shows up on the other immediately.
- **Seven columns** —— idea → todo → doing → blocked → review → done → archive, with in-panel add and drag.
- **Atomic claim** —— `task next` claims via a single `UPDATE ... WHERE`, so two agents racing never take the same task.
- **Lease heartbeat** —— A claim carries a 30-minute lease by default; long jobs call `heartbeat` to renew. An expired lease is reclaimed back to todo with a system log entry.
- **Dependency DAG** —— Tasks can declare dependencies (B waits for A), with automatic cycle detection; `ready` lists only actionable tasks.
- **Structured output** —— Every command takes `--json` and returns `{"ok":true,"data":...}`; semantic exit codes let an agent branch without parsing text.
- **MCP server** —— `t2a mcp` exposes 22 tools over stdio JSON-RPC, so MCP-capable agents call them directly instead of assembling shell commands.
- **Audit and backup** —— Every write is recorded in the `events` stream; `t2a db backup` takes a self-contained snapshot.

## Quick start

### Requirements

Storage uses Node's built-in `node:sqlite`, which requires **Node.js >= 22.13** (22.12 fails with `ERR_UNKNOWN_BUILTIN_MODULE`). Self-check first if anything misbehaves:

```bash
node bin/t2a doctor
```

### Run it locally

```bash
# Web board (defaults to http://127.0.0.1:3979)
npm run web

# Command line
node bin/t2a help
```

## CLI reference

**Boards and tasks**

| Command | Description |
|---|---|
| `t2a project list` | List boards (with task counts) |
| `t2a project add <name> [--desc <text>]` | Create a board |
| `t2a task add <title> --project <name> [--content] [--status] [--priority]` | Add a task |
| `t2a task add --project <name> --batch` | Add many tasks from stdin (an agent's best friend) |
| `t2a task list [--project] [--status]` | List tasks |
| `t2a task search <keyword>` | Fuzzy search (code / title / content / board; multiple keywords are AND) |
| `t2a task update <id> [--title] [--content] [--status]` | Update a task |
| `t2a task remove <id> --yes` | Delete (`--yes` is required and never blocks without a TTY) |
| `t2a report [--project P] [--out <file>]` | Export tasks + logs + results as Markdown |

**Agent coordination**

| Command | Description |
|---|---|
| `t2a task next [--project P] [--lease 30m]` | Take the next actionable task and claim it atomically |
| `t2a task start <id>` | "Start on this one" = claim + move to doing |
| `t2a task claim <id> [--agent A]` | Claim a specific task; returns `CONFLICT` (exit 3) if held |
| `t2a task heartbeat <id> [--lease 30m]` | Renew the lease; equivalent to `claim` when unclaimed |
| `t2a task release <id>` | Give the task back to todo |
| `t2a task done <id> --result "what you produced"` | Mark done and record the result |
| `t2a task fail <id> --error "why" [--max 3]` | Count a failure; retries until the cap, then moves to `blocked` |
| `t2a task dep add <id> --on <other-id>` | Declare a dependency (cycle-safe) |
| `t2a task ready [--project P]` | List actionable tasks without claiming |

**Audit and maintenance**

| Command | Description |
|---|---|
| `t2a doctor` | Environment check: Node version / database / web service / front-end build |
| `t2a events [--kind] [--task] [--actor] [--limit 50]` | Audit stream, newest first |
| `t2a db backup [--out <dir>]` | Snapshot the database |
| `t2a agent [--json]` | Print the built-in onboarding guide (`--json` for machine reading) |
| `t2a mcp` | Run as an MCP server (stdio JSON-RPC) |

## Status values and exit codes

Each board column maps to one `status` value:

| status | Column | Meaning |
|---|---|---|
| `idea` | idea | Not thought through yet, just captured |
| `todo` | todo | Queued, not started |
| `doing` | doing | Claimed and in progress |
| `blocked` | blocked | Stuck, waiting on a human or an external condition |
| `review` | review | Done, waiting for a human to accept |
| `done` | done | Accepted |
| `archive` | archive | Filed away, out of sight |

Exit codes are there for agents — **branch on them without parsing text**:

| Code | Meaning | Suggested action |
|---|---|---|
| `0` | Success | Continue |
| `1` | Business error | Read `error.code` and decide |
| `2` | No task available | End this round normally |
| `3` | Claim conflict | Pick another task |
| `4` | Usage error | Fix the command |
| `5` | Missing `--yes` | Add the confirmation flag |

Common `code` values: `NO_TASK` `CONFLICT` `DEP_NOT_READY` `NOT_FOUND` `USAGE` `CONFIRM_REQUIRED` `INVALID_DEP` `EXISTS`.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `T2A_DB` | Database file path | `~/.t2a/t2a.db` |
| `T2A_PROJECT` | Default board (saves `--project`) | none / first project |
| `T2A_AGENT` | Default agent identity | `agent` |
| `T2A_PORT` | Web server port | `3979` |
| `T2A_HOST` | Web server bind address | `127.0.0.1` (local only) |

> `TASKCLI_*` is the historical naming (the project was formerly `taskcli`); it is still recognised but ranks below `T2A_*`, so old scripts keep working.

## Agent integration

MCP-capable clients can register the server directly, no shell assembly needed:

```bash
node bin/t2a mcp --print-config
```

Protocol `2024-11-05`, stdio JSON-RPC, 22 tools: `project_list/add`, `task_list/show/search/add/update`, `task_next/claim/heartbeat/release/done/fail`, `task_log/logs`, `task_deps/dep_add/dep_rm`, `task_ready`, `task_assign`, `task_report`, `events`. See [AGENT.md](AGENT.md) for the full contract.

Without MCP, the CLI works just as well — one standard loop:

```bash
export T2A_AGENT=codebuddy
t2a task next --json            # take a task (claims it and moves to doing)
t2a task log 12 "traced it to src/db.js:88"
t2a task heartbeat 12 --lease 30m
t2a task done 12 --result "fixed, tests added"
```

**Agent identity comes from server-side config**, not from whatever name the agent reports; mistakes are corrected automatically:

```bash
t2a config set agent workbuddy
t2a config alias codebuddy workbuddy
```

## Data and privacy

Data stays on your machine, nothing is uploaded, and the page ships no third-party analytics. What is stored where:

| Location | Contents | Note |
|---|---|---|
| `~/.t2a/t2a.db` | Boards, tasks, logs, audit events | Default path; override with `T2A_DB` |
| `~/.t2a/config.json` | Default agent identity and aliases | Mode 600 |

`.db` files are in `.gitignore`, so they cannot be committed by accident. Give each agent its own file to isolate workloads: `T2A_DB=/path/to/agent.db t2a task list`.

The web server binds to `127.0.0.1` by default. To reach it from the LAN, use `T2A_HOST=0.0.0.0 npm run web` — note there is **no authentication whatsoever**, so only do that on a trusted network.

## Project layout

```text
TaskToAgent/
├── bin/t2a            # CLI entry point (executable)
├── src/
│   ├── brand.js       # Brand and path resolution (T2A_* wins, TASKCLI_* honoured)
│   ├── config.js      # Default agent identity and alias correction
│   ├── db.js          # Schema plus claim / lease / dependency primitives (node:sqlite)
│   ├── report.js      # Task and project reports, deliverable rollup
│   ├── agent-guide.js # Built-in onboarding guide for agents
│   ├── sqlite-guard.js# Node version precheck (friendly error instead of a module stack)
│   ├── cli.js         # All CLI command logic
│   └── mcp.js         # MCP server (stdio JSON-RPC, zero dependencies)
├── AGENT.md           # Agent integration contract (MCP config / standard loop / rules)
├── web/
│   ├── server.js      # Zero-dependency http server: REST API + static hosting
│   ├── dist/          # Front-end build output (committed, works out of the box)
│   └── ui/            # Front-end source (Vite + React + Arco Design)
├── docs/              # README images
└── package.json
```

## Development notes

Backend changes are plain edits under `src/` — no build step. Front-end changes need a rebuild, and the output must be committed:

```bash
cd web/ui && npm install && npm run build
```

The build lands in `web/dist` and is **committed to the repository**, so anyone who clones can run `npm run web` without installing front-end dependencies.

## Browser support

The web board is a built modern-browser app and needs a browser with `fetch` and CSS Grid (any current Chrome / Edge / Firefox / Safari). The CLI and MCP server need no browser at all. The layout is responsive; on narrow screens the seven columns scroll horizontally.

## License

[MIT](LICENSE) © 2026 isnotry
