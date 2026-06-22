# Installing the Telemetry Hook

## 1. Copy hook files

Copy the `.claude/telemetry_tool/` directory into your project's `.claude/` folder:

```
your-project/
└── .claude/
    └── telemetry_tool/
        ├── telemetry-hook.js
        ├── guardrail-hook.js
        ├── send-logs-hook.js
        ├── env-context.js
        ├── git-context.js
        ├── write-telemetry.js
        ├── hook-log.js
        └── version.json
```

## 2. Wire hooks in `.claude/settings.json`

Add the hooks to your project's `.claude/settings.json`. Create the file if it doesn't exist.

**Telemetry hook** (records prompts, warns if opened outside project root):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/telemetry-hook.js')\"",
            "statusMessage": "Recording prompt..."
          }
        ]
      }
    ]
  }
}
```

> **Project-root check:** on every prompt submission the hook compares the session `cwd` against
> the git repo root. If they differ (e.g. Claude Code was opened inside `client/` or `dist/`
> instead of the project root) it writes to stderr and exits with code 2 (blocking):
>
> ```
> You opened claude not in project root, close and reopen in: <git-root>
> ```
>
> The prompt is blocked until the user restarts Claude Code from the correct directory.

**Log upload hook** (uploads collected JSONL files to the server on session end):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/send-logs-hook.js')\"",
            "statusMessage": "Uploading logs..."
          }
        ]
      }
    ]
  }
}
```

**Guardrail hook** (restricts file access and bash commands — add alongside telemetry):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }]
      },
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }]
      },
      {
        "matcher": "Edit",
        "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }]
      },
      {
        "matcher": "Glob",
        "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking bash command..." }]
      }
    ]
  }
}
```

> **Note:** Hook commands use `git rev-parse --show-toplevel` to locate the repo root at runtime, so they work correctly regardless of which subdirectory Claude Code is opened in and on any OS (Mac, Linux, Windows). Git must be installed and the project must be a git repository.

## 3. Requirements

- Node.js >= 18 (no `npm install` needed — hooks use only Node.js built-ins)

---

## Configuration

All configuration lives in `.claude/telemetry_tool/.env` inside your project. Create the file if it doesn't exist.

If a `.claude/telemetry_tool/.env.local` file exists, it is loaded after `.env` and its values override the base file. Use `.env.local` for sensitive values (API keys, tokens) — it should be added to `.gitignore` and never committed.

### Telemetry directory

Where JSONL event files are written (one file per session):

```env
TELEMETRY_DIR=.ai_work_dir/telemetry
```

Accepts a path relative to the project root or an absolute path.
Default: `<project-root>/.ai_work_dir/telemetry`

### Context labels

Attach arbitrary key-value metadata to every event:

```env
CTX_PROJECT=my-project
CTX_ENV=production
CTX_TEAM=backend
```

Produces `"context": { "project": "my-project", "env": "production", "team": "backend" }` on every record.

### JSON format

Output is always compact single-line JSON (one record per line, JSONL).

```env
JSON_COMPACT=true   # accepted but currently has no effect — output is always compact
```

### Guardrail settings

```env
# Disable guardrail entirely (default: true = enabled)
GUARDRAIL_ENABLED=false

# Block file access outside the project root (default: true)
GUARDRAIL_BLOCK_OUTSIDE_PROJECT=false

# Comma-separated paths (relative to project root) that are always blocked
GUARDRAIL_PROHIBITED_FILES=.env,.env.local,secrets.json
```

### LLM-based guardrail for Bash commands

When enabled, every `Bash` tool call goes through a **two-pass LLM check** before it runs.
Prompts are passed via stdin (not `-p`) to avoid shell-escaping issues on Windows.

**Pass 1 — file discovery:** the LLM lists every file path referenced by the command (scripts
it runs, files it reads, config files, etc.).

**Between passes — hook reads files:** for each discovered path the hook checks:
- If the file is **outside the project root** → block immediately without reading.
- If the file **exceeds `GUARDRAIL_MAX_SCRIPT_SIZE_KB`** → block for safety.
- Otherwise → read the file content and pass it to pass 2.

**Pass 2 — security analysis:** the LLM evaluates the command and all file contents together
against the active security checks (prohibited files, project boundary, network access).

```env
# Enable LLM evaluation of Bash commands (default: false)
GUARDRAIL_LLM_ENABLED=true

# Claude model to use for LLM checks (default: haiku)
GUARDRAIL_LLM_MODEL=haiku

# Timeout for each LLM call in milliseconds (default: 10000)
GUARDRAIL_LLM_TIMEOUT_MS=10000

# Max size in KB for script files read during LLM analysis — larger files are blocked (default: 10)
GUARDRAIL_MAX_SCRIPT_SIZE_KB=100

# Block network requests in Bash commands (default: false)
GUARDRAIL_BLOCK_NETWORK=true
```

> **Note — `WebFetch` and `WebSearch` are not blockable via hooks.**
> Claude Code does not fire `PreToolUse` events for its built-in network tools, so
> `GUARDRAIL_BLOCK_NETWORK` only covers `Bash` commands (e.g. `curl`, `wget`).
> To prevent Claude from using `WebFetch` or `WebSearch` entirely, deny them in
> `.claude/settings.json` using the permissions system:
>
> ```json
> {
>   "permissions": {
>     "deny": ["WebFetch", "WebSearch"]
>   }
> }
> ```

The LLM check is **fail-open**: if the `claude` binary is not found, times out, exits non-zero,
or returns unparseable output, the bash command is allowed through and a warning is written to
stderr. No telemetry is written on LLM failure.

The LLM call is skipped entirely when no active checks apply (no prohibited files,
`GUARDRAIL_BLOCK_OUTSIDE_PROJECT=false`, and `GUARDRAIL_BLOCK_NETWORK=false`).

**Windows path formats:** the project boundary is communicated to the LLM in all three
equivalent formats — Windows (`D:\foo`), Git Bash (`/d/foo`), and WSL (`/mnt/d/foo`) — so
paths expressed in any of these styles are correctly recognised as inside or outside the
project root. The same normalisation applies to static checks (Read/Write/Edit/Glob).

**Project root:** the guardrail uses the **git repo root** (via `git rev-parse --show-toplevel`)
as the project boundary, not the session's working directory. This means sessions opened in a
subdirectory (e.g. `hook/`) enforce the same top-level repo boundary as the root session.
If the project is not a git repo, the session `cwd` is used as a fallback.

### Log upload settings

Used by `send-logs-hook.js` (fires on `Stop`). If `SERVER_URL` or `API_KEY` is empty, the hook
exits silently without uploading anything.

`.env`:
```env
# Base URL of the artisyn-log-hub server
SERVER_URL=https://your-server

# HTTP request timeout in milliseconds (default: 10000)
# SEND_LOGS_TIMEOUT_MS=10000
```

`.env.local` (gitignored — put secrets here):
```env
# API key sent as the X-API-Key request header
API_KEY=your-api-key
```

The hook uploads three namespaces on every session end:

| Namespace | Source directory | Notes |
|-----------|-----------------|-------|
| `artisyn` | `TELEMETRY_DIR` | Artisyn telemetry JSONL files |
| `claude` | `~/.claude/projects/<slug>/` | Claude Code's own session logs |
| `claude-subagent` | `~/.claude/projects/<slug>/<session>/subagents/` | Sub-agent session logs |

Zero-byte files are skipped. A manifest file (`<TELEMETRY_DIR>/.claude-logs.sent`) records the
byte-size of each successfully uploaded file so that unchanged files are not re-uploaded on
subsequent sessions.

The current session's file is **always uploaded** regardless of the manifest, but its size is
**not written back** to the manifest after upload. This intentional omission handles a race
condition: Claude Code appends the `turn_duration` event to the JSONL file *after* the Stop hook
fires. By not recording the current session's size, the next Stop event (from any session) will
see the file as unrecorded, check its size, and re-upload it — capturing the late-written events.

**Upload endpoints:**

- Primary and artisyn sessions: `POST <SERVER_URL>/api/v1/logs?type=<namespace>&sessionId=<sessionId>`
- Sub-agent sessions: `POST <SERVER_URL>/api/v1/logs?type=claude-subagent&sessionId=<agentId>&parentSessionId=<parentSessionId>`

`parentSessionId` is the name of the directory containing the sub-agent file (i.e. the parent session ID). This lets the server link sub-agent sessions to their parent.

A `201` response is considered success; any other status or network error is logged to stderr
and the hook continues — it always exits 0.

**CLAUDE.md context injection:**

When uploading any `claude` or `claude-subagent` log, the hook reads all `CLAUDE.md` and
`CLAUDE.local.md` files found in the project directory (and common sub-directories: `client/`,
`server/`, `hook/`) and prepends a synthetic `system-context` event to the NDJSON body before
uploading:

```json
{
  "type": "system-context",
  "claudeMd": {
    "totalBytes": 12345,
    "files": [
      { "path": "/project/CLAUDE.md", "bytes": 9800 },
      { "path": "/project/client/CLAUDE.md", "bytes": 2545 }
    ]
  }
}
```

This allows the server-side viewer to estimate how many tokens the CLAUDE.md system prompt
contributes to each session (approximately `totalBytes ÷ 3.5`).

---

## Recorded events

All events are written as JSONL to `<TELEMETRY_DIR>/<session_id>.jsonl`.

### `prompt_start` — fired on every user prompt (`UserPromptSubmit`)

```json
{
  "event": "prompt_start",
  "timestamp": "2025-01-15T10:23:00.000Z",
  "session_id": "abc123",
  "prompt": "fix the login bug",
  "context": { "project": "my-project", "team": "backend" },
  "git": { "repo": "git@github.com:org/repo.git", "branch": "main", "user": "Jane Dev" }
}
```

| Field | Always present | Notes |
|-------|---------------|-------|
| `event` | yes | `"prompt_start"` |
| `timestamp` | yes | ISO 8601 |
| `session_id` | yes | null if unavailable |
| `prompt` | yes | null if unavailable |
| `context` | only if `CTX_*` vars are set | object of lowercased keys |
| `git` | only inside a git repo | null otherwise |

### `prompt_stop` — fired on session end (`Stop`) or interrupted-turn recovery (`UserPromptSubmit`)

`prompt_stop` is written in two situations:

1. **Interrupted turn recovery** — by `telemetry-hook.js` on `UserPromptSubmit`. Before recording
   the new `prompt_start`, the hook reads the current session file and checks whether the last
   work-tracking event is a `prompt_start` with no matching `prompt_stop`. If so, the previous
   turn was interrupted (user pressed Escape) and a `prompt_stop` is appended now to close that
   work period. This ensures interrupted turns contribute their elapsed time to the totals.

2. **Session end** — by `send-logs-hook.js` on `Stop`. Written immediately before the file is
   uploaded. Duplicate trailing stops (e.g. from a crash/restart where Stop fires twice in a row
   after the last `prompt_start`) are deduplicated to keep exactly one trailing stop. Earlier
   `prompt_stop` entries that appear before the last `prompt_start` (from prior interrupts) are
   preserved.

```json
{
  "event": "prompt_stop",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "session_id": "abc123"
}
```

| Field | Always present | Notes |
|-------|---------------|-------|
| `event` | yes | `"prompt_stop"` |
| `timestamp` | yes | ISO 8601 — time the Stop hook fired |
| `session_id` | yes | null if unavailable |

**Work-time calculation:** autonomous work time is derived from `prompt_start` / `prompt_stop`
pairs in the file. Each `prompt_start` opens a segment that ends at the next event (another
`prompt_start` or a `prompt_stop`). Sessions can contain multiple `prompt_stop` entries — one per
interrupted turn plus one for the session end — and all are preserved. Summing all segment
durations gives the total autonomous work time. Sessions without these events (recorded before
this hook version) show 0 work time.

### `guardrail_block` — fired when a tool call is blocked (`PreToolUse`)

**Static block** (Read/Write/Edit/Glob — path checked directly):

```json
{
  "event": "guardrail_block",
  "timestamp": "2025-01-15T10:24:00.000Z",
  "session_id": "abc123",
  "context": { "project": "my-project" },
  "tool_name": "Read",
  "file_path": "../secret/.env",
  "reason": "outside_project",
  "project_dir": "/home/user/my-project"
}
```

**LLM block** (Bash — command evaluated by LLM):

```json
{
  "event": "guardrail_block",
  "timestamp": "2025-01-15T10:24:00.000Z",
  "session_id": "abc123",
  "context": { "project": "my-project" },
  "tool_name": "Bash",
  "reason": "llm_network_access",
  "project_dir": "/home/user/my-project"
}
```

| Field | Notes |
|-------|-------|
| `reason` | Static: `"outside_project"` or `"prohibited_file"`. LLM: `"llm_prohibited_file"`, `"llm_outside_project"`, or `"llm_network_access"`. |
| `tool_name` | Static checks: one of `Read`, `Write`, `Edit`, `Glob`. LLM checks: `Bash`. |
| `file_path` | Present for static blocks only; absent for LLM (Bash) blocks. |

---

## Hook diagnostic log

Every hook writes a plain-text activity log to `<project-root>/.ai_work_dir/hook.log`.
The project root is resolved via `git rev-parse --show-toplevel`, so the log always lands at
the repo root even when Claude Code is opened in a subdirectory.
The directory is created automatically if it does not exist.

Each line is a single log entry in the format:

```
<ISO-timestamp> [<hook-file>] [<session_id>] [<event>] <message>
```

For `activate` events, a `[hook v<version>]` suffix is appended when `version.json` is present in the `telemetry_tool/` directory:

```
<ISO-timestamp> [<hook-file>] [<session_id>] [activate] <message> [hook v1.0.3]
```

| Column | Values |
|--------|--------|
| `hook-file` | `telemetry-hook.js`, `guardrail-hook.js`, or `send-logs-hook.js` |
| `session_id` | Claude Code session ID, or `-` if unavailable |
| `event` | `activate` — hook started processing; `result` — outcome summary; `fail` — per-file upload failure (send-logs-hook only); `error` — unexpected exception |

Example entries:

```
2025-01-15T10:23:00.000Z [telemetry-hook.js] [abc123] [activate] UserPromptSubmit received [hook v1.0.3]
2025-01-15T10:23:00.001Z [telemetry-hook.js] [abc123] [result] telemetry written to /home/user/project/.ai_work_dir/telemetry
2025-01-15T10:24:00.000Z [guardrail-hook.js] [abc123] [activate] PreToolUse tool=Read [hook v1.0.3]
2025-01-15T10:24:00.001Z [guardrail-hook.js] [abc123] [result] blocked tool=Read reason=outside_project path="../secret/.env"
2025-01-15T10:30:00.000Z [send-logs-hook.js] [abc123] [activate] Stop event received [hook v1.0.3]
2025-01-15T10:30:01.200Z [send-logs-hook.js] [abc123] [result] done: uploaded=2 skipped=1 failed=0 total=3
```

This log is separate from telemetry JSONL files and is intended for debugging hook behaviour.
It is safe to delete at any time.

---

## Cleanup

### Hook activity log

```sh
rm .ai_work_dir/hook.log
```

### Telemetry JSONL files

```sh
rm .ai_work_dir/telemetry/*.jsonl
```

Both are regenerated automatically on the next Claude Code session.
