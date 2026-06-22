# Install Telemetry Hook

Records Claude Code sessions and uploads them to artisyn-log-hub.

**Requirements:** Node.js ≥ 18, Git.

---

## 1. Copy hook files

Copy `.claude/telemetry_tool/` from this repo into your project's `.claude/` folder.

```
your-project/
└── .claude/
    └── telemetry_tool/
        ├── telemetry-hook.js
        ├── lifecycle-hook.js
        ├── send-logs-hook.js
        ├── guardrail-hook.js
        ├── env-context.js
        ├── git-context.js
        ├── write-telemetry.js
        ├── hook-log.js
        └── version.json
```

---

## 2. Wire hooks in `.claude/settings.json`

Create or edit `.claude/settings.json` in your project:

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
    ],
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
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording tool call..."
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording tool failure..."
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording session start..."
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording session end..."
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording permission request..."
          }
        ]
      }
    ],
    "PermissionDenied": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording permission denial..."
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording subagent start..."
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording subagent stop..."
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording compaction..."
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording compaction..."
          }
        ]
      }
    ],
    "PostToolBatch": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording tool batch..."
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/lifecycle-hook.js')\"",
            "statusMessage": "Recording stop failure..."
          }
        ]
      }
    ]
  }
}
```

**Optional — guardrail hook** (blocks file access outside the project root):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read",  "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }] },
      { "matcher": "Write", "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }] },
      { "matcher": "Edit",  "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }] },
      { "matcher": "Glob",  "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking file access..." }] },
      { "matcher": "Bash",  "hooks": [{ "type": "command", "command": "node -e \"require(require('child_process').execSync('git rev-parse --show-toplevel').toString().trim()+'/.claude/telemetry_tool/guardrail-hook.js')\"", "statusMessage": "Checking bash command..." }] }
    ]
  }
}
```

---

## 3. Configure `.env`

Create `.claude/telemetry_tool/.env`:

```env
SERVER_URL=https://your-server
```

Create `.claude/telemetry_tool/.env.local` (**add to `.gitignore`** — secrets go here):

```env
API_KEY=your-api-key
```

If `SERVER_URL` or `API_KEY` is empty the upload step is silently skipped.

---

## Done

Open Claude Code from your **project root**. Logs are uploaded after each session ends.

- Activity log: `.ai_work_dir/hook.log`
- Raw JSONL files: `.ai_work_dir/telemetry/`

For configuration options, event schemas, and how it works: [HOW_HOOK_WORKS.md](HOW_HOOK_WORKS.md)
