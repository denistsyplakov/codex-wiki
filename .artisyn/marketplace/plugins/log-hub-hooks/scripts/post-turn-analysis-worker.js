#!/usr/bin/env node
/**
 * Claude Code Hook — T-101 combined Turn-End Cost Advisor / AI Session Attribution worker.
 *
 * Spawned detached by `post-turn-analysis-hook.js` on `Stop` (Design Decision 8) — never run
 * directly by Claude Code itself. Reads its input from argv (it has no stdin pipe, same
 * convention as `prompt-upload-hook.js`):
 *
 *   node post-turn-analysis-worker.js --cwd <cwd> --sessionId <sessionId>
 *     --transcriptPath <path> --repoUrl <repoUrl>
 *
 * Fetches both features' gate info from ONE combined endpoint
 * (`GET /api/v2/post-turn-analysis/config`, Design Decision 33), then runs an "advisor branch"
 * and an "attribution branch" CONCURRENTLY via `Promise.allSettled` (Design Decision 8) — each
 * branch independently decides whether it has anything to do, makes its own `claude -p` call via
 * the shared `callLlmAsync()` (`claude-invoke-async.js`, Design Decision 7) if so, and POSTs its
 * own result to its own endpoint as soon as it settles, never waiting on the other branch.
 *
 * Configure in .artisyn/config/log-hub.json / log-hub.local.json:
 *   serverUrl / apiKey                        — same server this hook already talks to
 *   sendLogsTimeoutMs                         — reused for the combined config GET's own timeout
 *   turnEndCostAdvisorModel                   (default 'sonnet')
 *   turnEndCostAdvisorLlmTimeoutMs             (default 30000)
 *   turnEndCostAdvisorMaxPromptSizeKb          (default 60)
 *   sessionAttributionLlmModel                (default 'haiku')
 *   sessionAttributionLlmTimeoutMs             (default 30000)
 *   sessionAttributionMaxPromptSizeKb          (default 60)
 * (Chunk 14 registers these 6 keys in `env-context.js`'s `CONFIG_DEFAULTS`/`CONFIG_TYPES`; the
 * `||` fallbacks below keep this worker correct in the meantime and afterward alike.)
 */

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const { loadConfig, resolveTelemetryDir } = require('./env-context');
const { getGitContext } = require('./git-context');
const { hookLog, hookLogTo } = require('./hook-log');
const { buildSkillDefinitions } = require('./skill-catalog');
const { callLlmAsync } = require('./claude-invoke-async');
const {
  isBlockedByFailureCap,
  recordFailure,
  recordSuccess,
} = require('./session-attribution-state');

const HOOK_FILE = 'post-turn-analysis-worker.js';

// Per-branch dedicated, independently rotated log files under .artisyn/ai_work_dir/ (each branch's
// own events, kept out of the shared hook.log everything else writes to) — matches the user-facing
// names "analysis" (Turn-End Cost Advisor) and "attribution" (AI Session Attribution) for the two
// T-101 parts. Worker-level events that precede/span both branches (start, config-fetch failure,
// no-repoUrl skip, an uncaught top-level error) stay in the shared hook.log via `hookLog()`.
const ADVISOR_LOG_FILE = 'analysis.log';
const ATTRIBUTION_LOG_FILE = 'attribution.log';

// Marker `claude-invoke-async.js` / `guardrail-hook.js` export into every `claude -p` session they
// spawn — see the guard in main() and the full rationale on HOOK_SERVICE_ENV_VAR in
// post-turn-analysis-hook.js.
const HOOK_SERVICE_ENV_VAR = 'ARTISYN_HOOK_SERVICE';

// Design Decision 6 / 17 — the one payload cap both branches enforce hook-side. Only the
// free-text "user prompts" sample ever shrinks; every fixed field (aggregate numbers, attribute
// definitions, file list) is always included in full.
const DEFAULT_MAX_PROMPT_SIZE_KB = 60;
const DEFAULT_ADVISOR_MODEL = 'sonnet';
const DEFAULT_ATTRIBUTION_MODEL = 'haiku';
const DEFAULT_LLM_TIMEOUT_MS = 30000;

// Part B's changed-file list cap (Design Decision 17's "capped at 200 paths with a
// `+N more files` line").
const MAX_CHANGED_FILES = 200;

// T-104 Chunk 4 (Design Decision 5) — hand-port of `cost.sql.ts`'s `FAST_MODE_MULTIPLIER`. Keep
// in sync with that constant.
const FAST_MODE_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// argv / env parsing
// ---------------------------------------------------------------------------

/**
 * Parse `--cwd`/`--sessionId`/`--transcriptPath`/`--repoUrl` from argv, falling back to
 * `ARTISYN_POST_TURN_ANALYSIS_*` env vars for whichever isn't present in argv — same
 * argv-first/env-fallback convention `prompt-upload-hook.js` already established for
 * cross-version compatibility with an older hook's spawn mechanism.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ cwd: string|null, sessionId: string|null, transcriptPath: string|null, repoUrl: string|null }}
 */
function parseArgs(argv, env) {
  const result = { cwd: null, sessionId: null, transcriptPath: null, repoUrl: null };
  const flagMap = {
    '--cwd': 'cwd',
    '--sessionId': 'sessionId',
    '--transcriptPath': 'transcriptPath',
    '--repoUrl': 'repoUrl',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flagMap[argv[i]];
    if (key && i + 1 < argv.length) {
      result[key] = argv[i + 1];
      i++;
    }
  }
  if (!result.cwd && env && env.ARTISYN_POST_TURN_ANALYSIS_CWD) {
    result.cwd = env.ARTISYN_POST_TURN_ANALYSIS_CWD;
  }
  if (!result.sessionId && env && env.ARTISYN_POST_TURN_ANALYSIS_SESSION_ID) {
    result.sessionId = env.ARTISYN_POST_TURN_ANALYSIS_SESSION_ID;
  }
  if (!result.transcriptPath && env && env.ARTISYN_POST_TURN_ANALYSIS_TRANSCRIPT_PATH) {
    result.transcriptPath = env.ARTISYN_POST_TURN_ANALYSIS_TRANSCRIPT_PATH;
  }
  if (!result.repoUrl && env && env.ARTISYN_POST_TURN_ANALYSIS_REPO_URL) {
    result.repoUrl = env.ARTISYN_POST_TURN_ANALYSIS_REPO_URL;
  }
  return result;
}

/**
 * Resolve the claude executable name for the current platform. Fail-open: returns `'claude'` on
 * any error. Deliberately its own copy, not shared with `guardrail-hook.js`'s identical
 * `resolveClaude()` — every hook helper in this codebase stays copied per script except the one
 * case (`claude-invoke-async.js`) where both call sites already live in the same file.
 * @returns {string}
 */
function resolveClaude() {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('where', ['claude.cmd'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0 && result.stdout.trim()) {
        return 'claude.cmd';
      }
      return 'claude';
    }
    return 'claude';
  } catch {
    return 'claude';
  }
}

// ---------------------------------------------------------------------------
// Minimal JSON-over-HTTP(S) client — GET the combined config, POST each branch's result.
// Fail-open throughout: any network problem resolves `null`, never throws.
// ---------------------------------------------------------------------------

/**
 * @param {'GET'|'POST'} method
 * @param {string} urlStr
 * @param {string} apiKey
 * @param {*} [bodyObj] - JSON-serialisable request body (POST only)
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: * }|null>}
 */
function httpRequestJson(method, urlStr, apiKey, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch {
      resolve(null);
      return;
    }

    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = { 'X-API-Key': apiKey };
    if (bodyStr !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const transport = urlObj.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));

    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Local transcript parsing — context-usage algorithm (Design Decision 3), prompt/turn
// extraction, skill-invocation resolution (Design Decision 35), changed-file collection.
// ---------------------------------------------------------------------------

/**
 * Read + parse a transcript JSONL file into an array of event objects, in file order
 * (chronological for the main session transcript). Fail-open: a missing/unreadable file, or any
 * unparseable line, is simply skipped — never thrown.
 * @param {string} transcriptPath
 * @returns {Array<Record<string, *>>}
 */
function readTranscriptEntries(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // malformed line — skip
    }
  }
  return entries;
}

/**
 * Port of `log-parser.ts`'s `sumCtxTokens()` (Design Decision 3).
 * @param {{ input_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }|undefined} usage
 * @returns {number|null}
 */
function sumCtxTokens(usage) {
  if (!usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Port of `log-parser.ts`'s context-tokens/peak-context-tokens derivation (Design Decision 3):
 * `contextTokens` is the last assistant event's usage sum, UNLESS a later `compact_boundary`
 * system event's `preTokens` overrides it (authoritative when present, same "keep as override"
 * rule the client applies per turn); `peakContextTokens` is the max seen across every assistant
 * usage sum AND every `compact_boundary.preTokens` value in the whole transcript.
 * @param {Array<Record<string, *>>} entries
 * @returns {{ contextTokens: number|null, peakContextTokens: number|null }}
 */
function computeContextUsage(entries) {
  let lastAssistantSum = null;
  let lastAssistantIdx = -1;
  let lastCompactBoundary = null; // { preTokens, idx }
  let peakContextTokens = null;

  entries.forEach((e, idx) => {
    if (e.type === 'assistant' && e.message && e.message.usage) {
      const sum = sumCtxTokens(e.message.usage);
      if (sum !== null) {
        lastAssistantSum = sum;
        lastAssistantIdx = idx;
        peakContextTokens = peakContextTokens === null ? sum : Math.max(peakContextTokens, sum);
      }
    }
    if (
      e.type === 'system' &&
      e.subtype === 'compact_boundary' &&
      e.compactMetadata &&
      typeof e.compactMetadata.preTokens === 'number'
    ) {
      const val = e.compactMetadata.preTokens;
      lastCompactBoundary = { preTokens: val, idx };
      peakContextTokens = peakContextTokens === null ? val : Math.max(peakContextTokens, val);
    }
  });

  let contextTokens = lastAssistantSum;
  if (lastCompactBoundary && lastCompactBoundary.idx > lastAssistantIdx) {
    contextTokens = lastCompactBoundary.preTokens;
  }

  return { contextTokens, peakContextTokens };
}

/**
 * Port of `log-parser.ts`'s `isQualifyingUserEvent` (root-session scope only — this worker never
 * sees subagent transcripts, so the `isSubagent` branch is omitted).
 * @param {Record<string, *>} e
 * @returns {boolean}
 */
function isQualifyingUserEvent(e) {
  if (e.type !== 'user') return false;
  if (e.isSidechain === true) return false;
  if (e.isMeta === true) return false;
  const toolUseResult = e.toolUseResult;
  if (toolUseResult && typeof toolUseResult === 'object' && toolUseResult.agentId != null) {
    return false;
  }
  const content = e.message && e.message.content;
  if (content === undefined || content === null) return false;
  if (typeof content === 'string') {
    if (content.length === 0) return false;
    const trimmed = content.trimStart();
    if (trimmed.startsWith('<command-name>')) return false;
    if (trimmed.startsWith('<task-notification>')) return false;
    if (trimmed.startsWith('<command-message>')) return true;
    return true;
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some((block) => block && block.type === 'text');
}

/**
 * Port of `log-parser.ts`'s `getPromptText()`: reconstructs a slash-command/skill invocation as
 * `<command-name> <command-args>` (e.g. `/task-plan-deep T-101`) when the content uses the
 * `<command-message>` format, otherwise returns the plain string / joined text blocks.
 * @param {Record<string, *>} userEvent
 * @returns {string}
 */
function getPromptText(userEvent) {
  const content = userEvent.message && userEvent.message.content;
  if (!content) return '';
  if (typeof content === 'string') {
    if (content.trimStart().startsWith('<command-message>')) {
      const nameMatch = content.match(/<command-name>([\s\S]*?)<\/command-name>/);
      const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
      const cmdName = nameMatch ? nameMatch[1].trim() : '';
      const args = argsMatch ? argsMatch[1].trim() : '';
      if (cmdName && args) return `${cmdName} ${args}`;
      if (cmdName) return cmdName;
      return args;
    }
    return content;
  }
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * Whether `userEvent`'s content uses the `<command-message>` slash-command/skill shape (Design
 * Decision 35 / requirements' "Shared Infrastructure" section).
 * @param {Record<string, *>} userEvent
 * @returns {boolean}
 */
function isCommandMessagePrompt(userEvent) {
  const content = userEvent.message && userEvent.message.content;
  return typeof content === 'string' && content.trimStart().startsWith('<command-message>');
}

/**
 * Build the ordered list of qualifying user-prompt "turns" for the whole transcript, each
 * correlated (per requirements' "Shared Infrastructure" section: "find the turn's `Skill`
 * tool-call entry to get the invoked skill's name") with the first `Skill` tool-call the
 * assistant makes before the NEXT qualifying user prompt — the same per-turn association
 * `log-parser.ts` uses to attach a `SkillDefinition` to a prompt turn for the session-log UI's
 * skill badges.
 * @param {Array<Record<string, *>>} entries
 * @returns {Array<{ text: string, isCommandMessage: boolean, skillName: string|null }>}
 */
function buildPromptTurns(entries) {
  const turns = [];
  let current = null;

  for (const e of entries) {
    if (isQualifyingUserEvent(e)) {
      current = {
        text: getPromptText(e),
        isCommandMessage: isCommandMessagePrompt(e),
        skillName: null,
      };
      turns.push(current);
      continue;
    }
    if (!current || e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        current.skillName === null &&
        block &&
        block.type === 'tool_use' &&
        block.name === 'Skill' &&
        block.input &&
        typeof block.input.skill === 'string'
      ) {
        current.skillName = block.input.skill;
      }
    }
  }

  return turns;
}

/**
 * Design Decision 35 — find every `Skill` tool-call entry anywhere in the transcript, resolve
 * each invoked name against the shared skill catalog (`skill-catalog.js`'s
 * `buildSkillDefinitions(cwd)`), and return one deduplicated `{name, description}[]`. A name with
 * no catalog match is dropped entirely (the caller falls back to the turn's raw literal text) —
 * only `description` is ever returned, never the skill's full `body`.
 * @param {string} transcriptPath
 * @param {string} cwd
 * @returns {Array<{ name: string, description: string }>}
 */
function resolveSkillInvocations(transcriptPath, cwd) {
  const entries = readTranscriptEntries(transcriptPath);
  const catalog = buildSkillDefinitions(cwd) || [];
  const catalogByName = new Map(catalog.map((s) => [s.name, s.description]));

  const seen = new Set();
  const result = [];
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || block.name !== 'Skill') continue;
      const skillName =
        block.input && typeof block.input.skill === 'string' ? block.input.skill : null;
      if (!skillName || seen.has(skillName)) continue;
      seen.add(skillName);
      if (catalogByName.has(skillName)) {
        result.push({ name: skillName, description: catalogByName.get(skillName) });
      }
      // no catalog match — dropped, per Design Decision 35
    }
  }
  return result;
}

/**
 * Distinct file paths touched by Edit/Write/MultiEdit tool calls anywhere in the transcript, in
 * first-seen order — feeds Part B's "changed-file list capped at 200 paths" (Design Decision 17).
 * @param {Array<Record<string, *>>} entries
 * @returns {string[]}
 */
function collectChangedFiles(entries) {
  const seen = new Set();
  const files = [];
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        block.type === 'tool_use' &&
        (block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') &&
        block.input &&
        typeof block.input.file_path === 'string' &&
        !seen.has(block.input.file_path)
      ) {
        seen.add(block.input.file_path);
        files.push(block.input.file_path);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// T-104 FR-B — local aggregate derivation, used when the server's own `aggregate` is absent
// or `hasTelemetry: false` (no `session_stats` row for the root session yet). Every helper
// below is a hand-port (Design Decision 2 — plain JS hook, no shared runtime with the TS
// server) of the exact algorithm the server itself uses to build the same figures, named
// identically to its server counterpart so the two stay easy to diff:
//   - `classifyToolOutcome()`/`isRejectionText()` <- `tool-stats.ts:54-103`
//   - `normaliseFilePath()`/`classifyFile()`/`computeToolResultBytes()` <- `claude-extractor.ts:39-84,1126-1138`
//     (mirrors `extractFileStatsByCategory()`, `claude-extractor.ts:1062-1124`, which does NOT
//     filter `isSidechain` — neither does this port, nor do this file's own pre-existing
//     `computeContextUsage()`/`buildPromptTurns()` ports above)
//   - `readUsageTokens()`/`splitCacheCreationTokens()`/`readServiceTier()` <- `tool-stats.ts:410,467`,
//     `claude-extractor.ts:128`
//   - `computeWorkTime()` <- `claude-extractor.ts:1140-1180`
// ---------------------------------------------------------------------------

/**
 * Claude Code's own rejection/permission-denial sentences, lower-cased. Hand-port of
 * `tool-stats.ts`'s `REJECTION_MARKERS` — keep in sync.
 */
const REJECTION_MARKERS = [
  "doesn't want to proceed with this tool use",
  'doesn’t want to proceed with this tool use',
  "doesn't want to take this action",
  'doesn’t want to take this action',
  'requested permissions to use',
  'operation rejected by user',
  'request interrupted by user',
];

/**
 * Port of `tool-stats.ts`'s `isRejectionText()`.
 * @param {string} text
 * @returns {boolean}
 */
function isRejectionText(text) {
  if (text === '') return false;
  const lower = text.toLowerCase();
  return REJECTION_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Port of `tool-stats.ts`'s `classifyToolOutcome()`.
 * @param {{ isError: boolean|null, text: string, interrupted?: boolean }|null} result
 * @returns {'success'|'failure'|'unresolved'}
 */
function classifyToolOutcome(result) {
  if (result === null) return 'unresolved';
  if (result.interrupted === true) return 'unresolved';
  if (isRejectionText(result.text)) return 'unresolved';
  if (result.isError === true) return 'failure';
  return 'success';
}

/**
 * How much `tool_result` text to scan for a rejection marker. Port of `tool-stats.ts`'s
 * `MAX_RESULT_TEXT_SCAN` — see that file for the perf rationale.
 */
const MAX_RESULT_TEXT_SCAN = 200;

/**
 * Port of `claude-extractor.ts`'s `flattenToolResultText()`.
 * @param {*} content
 * @returns {string}
 */
function flattenToolResultText(content) {
  if (typeof content === 'string') return content.slice(0, MAX_RESULT_TEXT_SCAN);
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) {
    if (!item || typeof item !== 'object' || item.type !== 'text') continue;
    if (typeof item.text !== 'string') continue;
    out += item.text;
    if (out.length >= MAX_RESULT_TEXT_SCAN) break;
  }
  return out.slice(0, MAX_RESULT_TEXT_SCAN);
}

/**
 * Port of `claude-extractor.ts`'s `computeToolResultBytes()` — byte counts here are actually
 * JS string-length counts, same approximation the server itself uses (no `Buffer.byteLength`).
 * @param {*} content
 * @returns {number}
 */
function computeToolResultBytes(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const item of content) {
    if (!item || typeof item !== 'object' || item.type !== 'text') continue;
    if (typeof item.text === 'string') total += item.text.length;
  }
  return total;
}

/**
 * Well-known top-level directory names, used as a normalisation fallback when `repoRoot` is
 * unknown/empty. Port of `claude-extractor.ts`'s `KNOWN_TOP_LEVEL_DIRS` — keep in sync.
 */
const KNOWN_TOP_LEVEL_DIRS = [
  'server',
  'client',
  'doc',
  'hook',
  '.claude',
  'tests',
  'dist',
  '.playwright-work-folder',
];

/**
 * Port of `claude-extractor.ts`'s `normaliseFilePath()`.
 * @param {string} absolutePath
 * @param {string} repoRoot
 * @returns {string}
 */
function normaliseFilePath(absolutePath, repoRoot) {
  let rel = absolutePath;
  if (repoRoot) {
    if (rel.toLowerCase().startsWith(repoRoot.toLowerCase())) {
      rel = rel.slice(repoRoot.length);
    }
  } else {
    const fwd = rel.replace(/\\/g, '/');
    for (const dir of KNOWN_TOP_LEVEL_DIRS) {
      const marker = `/${dir}/`;
      const idx = fwd.indexOf(marker);
      if (idx !== -1) {
        return fwd.slice(idx + 1);
      }
    }
  }
  return rel.replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * Port of `claude-extractor.ts`'s `classifyFile()`. A stale/invalid regex pattern is skipped
 * (never throws), same fail-open rule the server applies.
 * @param {string} relativePath
 * @param {Array<{ name: string, patterns: string[] }>} categories
 * @returns {string}
 */
function classifyFile(relativePath, categories) {
  for (const category of categories) {
    for (const pattern of category.patterns) {
      let regExp;
      try {
        regExp = new RegExp(pattern);
      } catch {
        continue;
      }
      if (regExp.test(relativePath)) return category.name;
    }
  }
  return 'code';
}

/**
 * Port of `tool-stats.ts`'s `readUsageTokens()` — the four token counters from one top-level
 * `message.usage` object.
 * @param {*} usage
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number }}
 */
function readUsageTokens(usage) {
  const asTokenNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  return {
    inputTokens: asTokenNumber(usage.input_tokens),
    outputTokens: asTokenNumber(usage.output_tokens),
    cacheReadTokens: asTokenNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asTokenNumber(usage.cache_creation_input_tokens),
  };
}

/**
 * Port of `claude-extractor.ts`'s `splitCacheCreationTokens()` — splits one `usage` object's
 * cache-creation tokens into the 5m/1h TTL buckets.
 * @param {*} usage
 * @returns {{ write5m: number, write1h: number }}
 */
function splitCacheCreationTokens(usage) {
  const total =
    typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  if (cacheCreation !== null) {
    const write5m =
      typeof cacheCreation.ephemeral_5m_input_tokens === 'number'
        ? cacheCreation.ephemeral_5m_input_tokens
        : 0;
    const write1h =
      typeof cacheCreation.ephemeral_1h_input_tokens === 'number'
        ? cacheCreation.ephemeral_1h_input_tokens
        : 0;
    if (write5m + write1h > 0) return { write5m, write1h };
  }
  return { write5m: total, write1h: 0 };
}

/** Port of `tool-stats.ts`'s `UNKNOWN_SERVICE_TIER`. */
const UNKNOWN_SERVICE_TIER = 'unknown';

/**
 * Port of `tool-stats.ts`'s `readServiceTier()` — bucket name for `usage.service_tier`; absent
 * or blank becomes `'unknown'`. Not consumed by any figure in `TurnEndAdvisorAggregate` today
 * (the cost formula only splits on `usage.speed`), but hand-ported and returned per-tier below
 * for parity with the server's own token-derivation helpers.
 * @param {*} usage
 * @returns {string}
 */
function readServiceTier(usage) {
  const tier = usage && typeof usage.service_tier === 'string' ? usage.service_tier : null;
  return tier === null || tier === '' ? UNKNOWN_SERVICE_TIER : tier;
}

/**
 * Port of `claude-extractor.ts`'s `computeWorkTime()`.
 * @param {Map<string, number>} promptMap - promptId -> earliest qualifying user event timestamp
 * @param {number[]} assistantTimestamps
 * @returns {number}
 */
function computeWorkTime(promptMap, assistantTimestamps) {
  if (promptMap.size === 0) return 0;

  const prompts = [...promptMap.values()].sort((a, b) => a - b);
  const sortedAssistantTs = [...assistantTimestamps].sort((a, b) => a - b);

  let totalMs = 0;

  for (let i = 0; i < prompts.length; i++) {
    const promptTs = prompts[i];
    const nextPromptTs = i + 1 < prompts.length ? prompts[i + 1] : null;

    let maxAssistantTs = null;
    for (const ts of sortedAssistantTs) {
      if (ts <= promptTs) continue;
      if (nextPromptTs !== null && ts > nextPromptTs) continue;
      if (maxAssistantTs === null || ts > maxAssistantTs) maxAssistantTs = ts;
    }

    if (maxAssistantTs !== null) totalMs += maxAssistantTs - promptTs;
  }

  return totalMs;
}

/**
 * Derives `workTimeMs` (Design Decision 4's per-session scope) from qualifying-user-event and
 * assistant-event timestamps collected from `entries` — the same `promptId -> earliest
 * timestamp` map plus assistant-timestamp array `computeWorkTime()` expects, built the same way
 * `claude-extractor.ts`'s own assistant/user walk builds them.
 * @param {Array<Record<string, *>>} entries
 * @returns {number}
 */
function deriveWorkTimeMs(entries) {
  const promptMap = new Map();
  const assistantTimestamps = [];

  for (const e of entries) {
    if (e.type === 'assistant') {
      const ts = Date.parse(e.timestamp);
      if (!isNaN(ts)) assistantTimestamps.push(ts);
    }
    if (isQualifyingUserEvent(e) && typeof e.promptId === 'string') {
      const ts = Date.parse(e.timestamp);
      if (!isNaN(ts)) {
        const existing = promptMap.get(e.promptId);
        if (existing === undefined || ts < existing) promptMap.set(e.promptId, ts);
      }
    }
  }

  return computeWorkTime(promptMap, assistantTimestamps);
}

/**
 * Derives per-tool `{ toolName, calls, failures }` rows (`TurnEndAdvisorToolUsage[]`): pairs
 * every `tool_use` block with its `tool_result` by `tool_use_id` (first result wins, same
 * "compacted transcript can repeat a block" rule `claude-extractor.ts` applies) and classifies
 * each via {@link classifyToolOutcome}. `calls` counts every `tool_use` block regardless of
 * whether a matching result was found; `failures` counts only the `'failure'` outcome — a
 * `'unresolved'` call (missing/rejected/interrupted) is neither.
 * @param {Array<Record<string, *>>} entries
 * @returns {Array<{ toolName: string, calls: number, failures: number }>}
 */
function deriveToolUsage(entries) {
  const pendingCalls = [];
  const toolResults = new Map();

  for (const e of entries) {
    if (e.type === 'assistant') {
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            pendingCalls.push({
              id: typeof block.id === 'string' ? block.id : null,
              name: block.name,
            });
          }
        }
      }
    }

    if (e.type === 'user') {
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        const toolUseResult =
          e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : null;
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
          if (toolUseId !== null && !toolResults.has(toolUseId)) {
            toolResults.set(toolUseId, {
              isError: typeof block.is_error === 'boolean' ? block.is_error : null,
              text: flattenToolResultText(block.content),
              interrupted: toolUseResult ? toolUseResult.interrupted === true : false,
            });
          }
        }
      }
    }
  }

  const rows = new Map();
  for (const call of pendingCalls) {
    const result = call.id !== null ? (toolResults.get(call.id) ?? null) : null;
    const outcome = classifyToolOutcome(result);

    let row = rows.get(call.name);
    if (row === undefined) {
      row = { toolName: call.name, calls: 0, failures: 0 };
      rows.set(call.name, row);
    }
    row.calls += 1;
    if (outcome === 'failure') row.failures += 1;
  }

  return [...rows.values()];
}

/**
 * Derives `{ categoryName, fileCount, byteCount }[]` (`TurnEndAdvisorFileUsage[]`) by mirroring
 * `claude-extractor.ts`'s `extractFileStatsByCategory()` exactly: only `Read` tool calls count,
 * `repoRoot` is always `''` (matching every server call site of `extractFileStatsByCategory()`,
 * which never passes a real repo root either — normalisation always falls back to the
 * `KNOWN_TOP_LEVEL_DIRS` scan), and byte counts come from the matching `tool_result`'s flattened
 * text content via {@link computeToolResultBytes}.
 * @param {Array<Record<string, *>>} entries
 * @param {Array<{ name: string, patterns: string[] }>} fileCategories
 * @returns {Array<{ categoryName: string, fileCount: number, byteCount: number }>}
 */
function deriveFileUsage(entries, fileCategories) {
  const result = {};
  const readToolCalls = new Map();

  for (const e of entries) {
    if (e.type === 'assistant') {
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== 'tool_use' || block.name !== 'Read') continue;
          const toolId = typeof block.id === 'string' ? block.id : null;
          const input = block.input && typeof block.input === 'object' ? block.input : null;
          if (toolId === null || input === null) continue;
          const filePath = typeof input.file_path === 'string' ? input.file_path : null;
          if (filePath === null) continue;

          const relative = normaliseFilePath(filePath, '');
          const category = classifyFile(relative, fileCategories);
          readToolCalls.set(toolId, { category });

          const entry = result[category] ?? { fileCount: 0, byteCount: 0 };
          entry.fileCount += 1;
          result[category] = entry;
        }
      }
    }

    if (e.type === 'user') {
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
          if (toolUseId === null || !readToolCalls.has(toolUseId)) continue;

          const bytes = computeToolResultBytes(block.content);
          const info = readToolCalls.get(toolUseId);
          const entry = result[info.category] ?? { fileCount: 0, byteCount: 0 };
          entry.byteCount += bytes;
          result[info.category] = entry;
        }
      }
    }
  }

  return Object.entries(result).map(([categoryName, v]) => ({
    categoryName,
    fileCount: v.fileCount,
    byteCount: v.byteCount,
  }));
}

/**
 * Sums token totals across deduped assistant messages (same message-id dedup rule
 * `claude-extractor.ts`'s `extractClaudeStats()` applies — one API response can be split
 * across several transcript lines, each repeating the same `message.usage`). Returns the raw
 * sums Chunk 4's cost lookup needs (Design Decision 5's formula) plus a per-service-tier
 * breakdown (parity hand-port of `readServiceTier()`, unused by the cost formula itself, which
 * only splits on `usage.speed`).
 * @param {Array<Record<string, *>>} entries
 * @returns {{
 *   inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *   cacheWrite5mTokens: number, cacheWrite1hTokens: number, cacheWriteTokens: number,
 *   webSearchRequests: number, inputTokensFast: number, outputTokensFast: number,
 *   tokenByServiceTier: Record<string, { input: number, output: number, cacheRead: number, cacheCreation: number, cacheWrite5m: number, cacheWrite1h: number }>
 * }}
 */
function deriveTokenTotals(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  let webSearchRequests = 0;
  let inputTokensFast = 0;
  let outputTokensFast = 0;
  const tokenByServiceTier = {};
  const usageCountedForMessageId = new Set();

  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const message = e.message;
    if (!message || typeof message !== 'object') continue;
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;

    const usageKey = typeof message.id === 'string' ? message.id : (typeof e.uuid === 'string' ? e.uuid : null);
    if (usageKey !== null) {
      if (usageCountedForMessageId.has(usageKey)) continue;
      usageCountedForMessageId.add(usageKey);
    }

    const fields = readUsageTokens(usage);
    inputTokens += fields.inputTokens;
    outputTokens += fields.outputTokens;
    cacheReadTokens += fields.cacheReadTokens;
    const { write5m, write1h } = splitCacheCreationTokens(usage);
    cacheWrite5mTokens += write5m;
    cacheWrite1hTokens += write1h;

    const serverToolUse =
      usage.server_tool_use && typeof usage.server_tool_use === 'object'
        ? usage.server_tool_use
        : null;
    if (serverToolUse !== null) {
      webSearchRequests +=
        typeof serverToolUse.web_search_requests === 'number' ? serverToolUse.web_search_requests : 0;
    }

    if (usage.speed === 'fast') {
      inputTokensFast += fields.inputTokens;
      outputTokensFast += fields.outputTokens;
    }

    const tier = readServiceTier(usage);
    const bucket = tokenByServiceTier[tier] ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    };
    bucket.input += fields.inputTokens;
    bucket.output += fields.outputTokens;
    bucket.cacheRead += fields.cacheReadTokens;
    bucket.cacheCreation += fields.cacheCreationTokens;
    bucket.cacheWrite5m += write5m;
    bucket.cacheWrite1h += write1h;
    tokenByServiceTier[tier] = bucket;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheWriteTokens: cacheWrite5mTokens + cacheWrite1hTokens,
    webSearchRequests,
    inputTokensFast,
    outputTokensFast,
    tokenByServiceTier,
  };
}

/**
 * Last assistant event's `message.model` anywhere in `entries` (Chunk 3 item 1) — scanned
 * back-to-front so the most recent model wins when a session switched models mid-way.
 * @param {Array<Record<string, *>>} entries
 * @returns {string|null}
 */
function deriveLastAssistantModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === 'assistant' && e.message && typeof e.message.model === 'string' && e.message.model) {
      return e.message.model;
    }
  }
  return null;
}

/**
 * T-104 FR-B core: derives a local stand-in for the server's `TurnEndAdvisorAggregate` straight
 * from this session's own transcript, for use when the server's own aggregate is absent or
 * `hasTelemetry: false`. `turnCount`/`promptCount` are equal (Design Decision 4 — the hook has
 * no subtree visibility, so the tree-wide `promptCount` cannot be derived locally; the real
 * tree-wide sum appears once the server ingests this transcript). `tokens` carries the raw sums
 * {@link deriveTokenTotals} produced — Chunk 4 turns those into `sessionCostUsd` (Design
 * Decision 5) and `contextWindow` via `GET /api/v1/model-pricing`; this function itself derives
 * neither, since both need data (pricing rates) it doesn't have.
 * @param {Array<Record<string, *>>} entries
 * @param {{ fileCategories: Array<{ name: string, patterns: string[] }> }} ctx
 * @returns {{
 *   turnCount: number, promptCount: number, model: string|null, workTimeMs: number,
 *   toolUsage: Array<{ toolName: string, calls: number, failures: number }>,
 *   fileUsage: Array<{ categoryName: string, fileCount: number, byteCount: number }>,
 *   tokens: ReturnType<typeof deriveTokenTotals>
 * }}
 */
function deriveLocalAggregate(entries, ctx) {
  const turnCount = buildPromptTurns(entries).length;

  return {
    turnCount,
    promptCount: turnCount,
    model: deriveLastAssistantModel(entries),
    workTimeMs: deriveWorkTimeMs(entries),
    toolUsage: deriveToolUsage(entries),
    fileUsage: deriveFileUsage(entries, (ctx && ctx.fileCategories) || []),
    tokens: deriveTokenTotals(entries),
  };
}

/**
 * T-104 Chunk 4 — `GET /api/v1/model-pricing` (public since Chunk 1 — no session exists yet for
 * a session-scoped key/cookie to authenticate with; its `X-API-Key` header is harmless against
 * the now-unguarded endpoint). Fail-open like every other `httpRequestJson()` call site in this
 * file: any network/timeout/non-200/unparseable-body problem resolves `null`, never throws.
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, { priceIn:number, priceOut:number, priceCacheR:number, priceCacheW5m:number, priceCacheW1h:number, priceWebSearch:number, charsPerToken:number|null, contextLength:number|null }>|null>}
 */
async function fetchModelPricing(serverUrl, apiKey, timeoutMs) {
  const resp = await httpRequestJson(
    'GET',
    `${serverUrl}/api/v1/model-pricing`,
    apiKey,
    undefined,
    timeoutMs,
  );
  if (!resp || resp.status !== 200 || !resp.body || typeof resp.body !== 'object') return null;
  return resp.body;
}

/**
 * Hand-port of `cost.sql.ts`'s `computeSessionCost()` (Design Decision 5) — same formula, same
 * `FAST_MODE_MULTIPLIER` fast-token surcharge, restricted to the fields
 * {@link deriveTokenTotals}/the `GET /api/v1/model-pricing` response actually provide (both
 * already plain numbers here, unlike the server's `NumericLike` DB-row inputs, so no `num()`
 * coercion helper is needed).
 * @param {ReturnType<typeof deriveTokenTotals>} tokens
 * @param {{ priceIn:number, priceOut:number, priceCacheR:number, priceCacheW5m:number, priceCacheW1h:number, priceWebSearch:number }} rates
 * @returns {number}
 */
function computeLocalSessionCost(tokens, rates) {
  const fastSurcharge = FAST_MODE_MULTIPLIER - 1;
  const input = tokens.inputTokens + tokens.inputTokensFast * fastSurcharge;
  const output = tokens.outputTokens + tokens.outputTokensFast * fastSurcharge;
  return (
    (input / 1_000_000) * rates.priceIn +
    (output / 1_000_000) * rates.priceOut +
    (tokens.cacheReadTokens / 1_000_000) * rates.priceCacheR +
    (tokens.cacheWrite5mTokens / 1_000_000) * rates.priceCacheW5m +
    (tokens.cacheWrite1hTokens / 1_000_000) * rates.priceCacheW1h +
    tokens.webSearchRequests * rates.priceWebSearch
  );
}

/**
 * T-104 Chunk 4 — completes {@link deriveLocalAggregate}'s output with `sessionCostUsd`
 * (Design Decision 5) and `contextWindow`, both needing a live `GET /api/v1/model-pricing` rates
 * lookup the hook cannot derive from the transcript alone. Never substitutes `0` for an
 * unreachable/unpriced model (Design Decision 3) — on any failure both fields resolve `null` and
 * the specific reason is logged to `analysis.log`, distinct from `advisorBranch()`'s other skip
 * reasons. `contextWindow` is `null` in exactly the same case as a missing/unpriced model — there
 * is no separate failure mode for it once pricing rates are found.
 * @param {ReturnType<typeof deriveLocalAggregate>} local
 * @param {{ serverUrl: string, apiKey: string, config: Record<string, *>, sessionId: string, cwd: string }} ctx
 * @returns {Promise<{ sessionCostUsd: number|null, contextWindow: number|null }>}
 */
async function priceLocalAggregate(local, ctx) {
  const timeoutMs = ctx.config.sendLogsTimeoutMs || 10000;
  const pricing = await fetchModelPricing(ctx.serverUrl, ctx.apiKey, timeoutMs);
  if (!pricing) {
    hookLogTo(
      ADVISOR_LOG_FILE,
      HOOK_FILE,
      ctx.sessionId,
      'result',
      'advisor: local sessionCostUsd/contextWindow unavailable — GET /api/v1/model-pricing failed',
      ctx.cwd,
    );
    return { sessionCostUsd: null, contextWindow: null };
  }

  const rates = local.model ? pricing[local.model] : undefined;
  if (!rates) {
    hookLogTo(
      ADVISOR_LOG_FILE,
      HOOK_FILE,
      ctx.sessionId,
      'result',
      `advisor: local sessionCostUsd/contextWindow unavailable — model '${local.model ?? 'unknown'}' not in model-pricing response`,
      ctx.cwd,
    );
    return { sessionCostUsd: null, contextWindow: null };
  }

  return {
    sessionCostUsd: computeLocalSessionCost(local.tokens, rates),
    contextWindow: rates.contextLength,
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly / truncation (Design Decision 6 / 17) — fixed fields never truncated; only a
// free-text sample (user prompts) drops from the middle, oldest-inward, first/last kept.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} items - pre-formatted line strings, oldest-first
 * @param {number} maxBytes
 * @param {(omittedCount: number) => string} omittedMarker
 * @returns {string}
 */
function truncateMiddle(items, maxBytes, omittedMarker) {
  if (items.length === 0) return '';
  const joined = items.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= maxBytes) return joined;
  if (items.length === 1) return joined.slice(0, Math.max(maxBytes, 0));

  // Keep first and last; drop inward from just after the first item, oldest-inward, until the
  // remaining text (first + marker + kept middle + last) fits the budget.
  let start = 1;
  const end = items.length - 1; // exclusive
  let omitted = 0;

  while (start < end) {
    const remaining = [items[0]];
    if (omitted > 0) remaining.push(omittedMarker(omitted));
    for (let i = start; i < end; i++) remaining.push(items[i]);
    remaining.push(items[items.length - 1]);
    const text = remaining.join('\n');
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    start++;
    omitted++;
  }

  // Even first + marker + last doesn't fit within budget — last resort, marker + last only.
  const lastResort = [omittedMarker(items.length - 1), items[items.length - 1]].join('\n');
  return lastResort;
}

/**
 * @param {string[]} files
 * @returns {string}
 */
function formatChangedFiles(files) {
  if (files.length === 0) return '(none)';
  if (files.length <= MAX_CHANGED_FILES) return files.join('\n');
  const shown = files.slice(0, MAX_CHANGED_FILES).join('\n');
  return `${shown}\n+${files.length - MAX_CHANGED_FILES} more files`;
}

/**
 * Format one prompt turn's display text, appending its resolved skill's description in
 * parentheses for a `<command-message>`-shaped prompt (requirements' "Shared Infrastructure"
 * section) — e.g. `/task-plan-deep T-101 (Generate a full technical implementation plan...)`.
 * @param {{ text: string, isCommandMessage: boolean, skillName: string|null }} turn
 * @param {Map<string, string>} skillDescriptionsByName
 * @returns {string}
 */
function formatPromptTurnText(turn, skillDescriptionsByName) {
  const oneLine = turn.text.replace(/\s+/g, ' ').trim();
  if (turn.isCommandMessage && turn.skillName && skillDescriptionsByName.has(turn.skillName)) {
    return `${oneLine} (${skillDescriptionsByName.get(turn.skillName)})`;
  }
  return oneLine;
}

// ---------------------------------------------------------------------------
// Advisor branch (Part A, Sonnet by default)
// ---------------------------------------------------------------------------

/**
 * @param {{ toolUsage: Array<{toolName:string,calls:number,failures:number}>, fileUsage: Array<{categoryName:string,fileCount:number,byteCount:number}>, promptCount: number, turnCount: number, workTimeMs: number, sessionCostUsd: number|null, model: string|null, contextWindow: number|null }} aggregate
 *   the server-fetched `TurnEndAdvisorGate.aggregate`, or (Chunk 4) a locally-derived stand-in
 *   built by `advisorBranch()` when `hasTelemetry` is `false` — `sessionCostUsd` is the one field
 *   allowed `null` in either case (Design Decision 3), rendered as `'unknown'` below
 * @param {{ contextTokens: number|null, peakContextTokens: number|null }} contextUsage
 * @param {Array<{ name: string, description: string }>} skillInvocations
 * @param {Array<{ text: string, isCommandMessage: boolean, skillName: string|null }>} promptTurns
 * @param {number} maxBytes
 * @returns {string}
 */
function buildAdvisorPrompt(aggregate, contextUsage, skillInvocations, promptTurns, maxBytes) {
  const skillDescriptionsByName = new Map(skillInvocations.map((s) => [s.name, s.description]));

  const fixedLines = [
    'You are analyzing a completed Claude Code coding session to give the developer a short,',
    'actionable cost/efficiency summary. Respond ONLY with a JSON object of this exact shape',
    '(no markdown, no explanation outside the JSON):',
    '{ "general": string, "costFactors": string[], "harnessAdvice": string[] }',
    '',
    'Where "general" is a 1-2 sentence plain-language summary of what drove this session\'s cost,',
    '"costFactors" is a short bullet list of the concrete things that drove up cost/tokens, and',
    '"harnessAdvice" is a short bullet list of actionable suggestions to reduce cost/tokens next time.',
    '',
    'Session usage summary:',
    `- Turns (this session): ${aggregate.turnCount}`,
    `- Prompts (whole session tree, incl. subagents/workflows): ${aggregate.promptCount}`,
    `- Work time: ${aggregate.workTimeMs} ms`,
    `- Session cost so far: ${aggregate.sessionCostUsd == null ? 'unknown' : `$${aggregate.sessionCostUsd}`}`,
    `- Model: ${aggregate.model ?? 'unknown'}`,
    `- Context window: ${aggregate.contextWindow ?? 'unknown'}`,
    `- Current context usage: ${contextUsage.contextTokens ?? 'unknown'} tokens`,
    `- Peak context usage: ${contextUsage.peakContextTokens ?? 'unknown'} tokens`,
    '',
    'Tool usage:',
    ...(aggregate.toolUsage.length > 0
      ? aggregate.toolUsage.map((t) => `- ${t.toolName}: ${t.calls} calls, ${t.failures} failures`)
      : ['(none)']),
    '',
    'File usage:',
    ...(aggregate.fileUsage.length > 0
      ? aggregate.fileUsage.map(
          (f) => `- ${f.categoryName}: ${f.fileCount} files, ${f.byteCount} bytes`,
        )
      : ['(none)']),
    '',
    'Skills invoked this session:',
    ...(skillInvocations.length > 0
      ? skillInvocations.map((s) => `- ${s.name}: ${s.description}`)
      : ['(none)']),
  ];
  const fixedText = fixedLines.join('\n');
  const fixedBytes = Buffer.byteLength(fixedText, 'utf8');

  // Design Decision 6 — only the free-text prompt sample below shrinks; never the fields above.
  const budgetForPrompts = Math.max(maxBytes - fixedBytes, 1024);
  const promptLines = promptTurns.map(
    (t, i) => `${i + 1}. ${formatPromptTurnText(t, skillDescriptionsByName)}`,
  );
  const promptSample =
    promptLines.length > 0
      ? truncateMiddle(promptLines, budgetForPrompts, (n) => `…(${n} prompts omitted)…`)
      : '(none)';

  return `${fixedText}\n\nUser prompts in this session (may be truncated):\n${promptSample}`;
}

/**
 * @param {{ enabled: boolean, thresholdMet: boolean, minSessionCostUsd: number, aggregate: *, fileCategories: Array<{ name: string, patterns: string[] }> }} gate
 * @param {{ serverUrl: string, apiKey: string, claudeBin: string, config: Record<string, *>, sessionId: string, telemetryDir: string, transcriptPath: string, cwd: string }} ctx
 */
async function advisorBranch(gate, ctx) {
  // T-104 FR-B — four distinct skip reasons (split from one merged log line), checked in the
  // same order FR-B defines its skip boundary:
  if (!gate.enabled) {
    hookLogTo(ADVISOR_LOG_FILE, HOOK_FILE, ctx.sessionId, 'result', 'advisor: skipped (feature off)', ctx.cwd);
    return;
  }
  if (!gate.thresholdMet) {
    hookLogTo(ADVISOR_LOG_FILE, HOOK_FILE, ctx.sessionId, 'result', 'advisor: skipped (session not yet known to server)', ctx.cwd);
    return;
  }
  if (!gate.aggregate) {
    hookLogTo(ADVISOR_LOG_FILE, HOOK_FILE, ctx.sessionId, 'result', 'advisor: skipped (no usable aggregate)', ctx.cwd);
    return;
  }

  const entries = readTranscriptEntries(ctx.transcriptPath);

  // T-104 FR-B (Design Decision 1) — the server had no telemetry for the root session yet
  // (`hasTelemetry: false`, every other `aggregate` field a zero/empty/null placeholder).
  // Derive a local stand-in from this session's own transcript instead; only skip outright when
  // there is no transcript to derive from either.
  let aggregate = gate.aggregate;
  if (!aggregate.hasTelemetry) {
    if (entries.length === 0) {
      hookLogTo(ADVISOR_LOG_FILE, HOOK_FILE, ctx.sessionId, 'result', 'advisor: skipped (no local transcript either)', ctx.cwd);
      return;
    }
    const local = deriveLocalAggregate(entries, { fileCategories: gate.fileCategories || [] });
    const priced = await priceLocalAggregate(local, ctx);
    aggregate = {
      turnCount: local.turnCount,
      promptCount: local.promptCount,
      model: local.model,
      workTimeMs: local.workTimeMs,
      toolUsage: local.toolUsage,
      fileUsage: local.fileUsage,
      sessionCostUsd: priced.sessionCostUsd,
      contextWindow: priced.contextWindow,
      hasTelemetry: false,
    };
  }

  const contextUsage = computeContextUsage(entries);
  const skillInvocations = resolveSkillInvocations(ctx.transcriptPath, ctx.cwd);
  const promptTurns = buildPromptTurns(entries);

  const model = ctx.config.turnEndCostAdvisorModel || DEFAULT_ADVISOR_MODEL;
  const timeoutMs = ctx.config.turnEndCostAdvisorLlmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const maxPromptBytes =
    (ctx.config.turnEndCostAdvisorMaxPromptSizeKb || DEFAULT_MAX_PROMPT_SIZE_KB) * 1024;

  const prompt = buildAdvisorPrompt(aggregate, contextUsage, skillInvocations, promptTurns, maxPromptBytes);

  const startedAt = new Date();
  const llmResult = await callLlmAsync(prompt, model, timeoutMs, ctx.claudeBin);
  const finishedAt = new Date();

  let outcome;
  let summary = null;
  let failureReason = null;

  if (llmResult === null) {
    outcome = 'failed';
    failureReason = 'LLM call timed out or exited non-zero';
  } else {
    try {
      const match = llmResult.text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON object found in LLM response');
      const parsed = JSON.parse(match[0]);
      summary = {
        general: typeof parsed.general === 'string' ? parsed.general : '',
        costFactors: Array.isArray(parsed.costFactors) ? parsed.costFactors.filter((v) => typeof v === 'string') : [],
        harnessAdvice: Array.isArray(parsed.harnessAdvice) ? parsed.harnessAdvice.filter((v) => typeof v === 'string') : [],
      };
      outcome = 'submitted';
    } catch (err) {
      outcome = 'failed';
      failureReason = `LLM response is not valid JSON: ${err.message}`;
    }
  }

  // No `hook_service` marker is written any more (T-105) — see the matching note in
  // `guardrail-hook.js`. `write-telemetry.js` suppresses all telemetry inside a hook-service
  // session, so an evaluation session produces no artisyn file at all and there is nothing left to
  // identify or filter out. This run row already carries `invokingSessionId` for every report that
  // needs it.

  const body = {
    sessionId: ctx.sessionId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    outcome,
    evalSessionId: llmResult ? llmResult.sessionId : null,
    ...(summary ? { summary } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(llmResult
      ? {
          cost: {
            model,
            costUsd: llmResult.costUsd,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            cacheReadTokens: llmResult.cacheReadTokens,
            cacheWriteTokens: llmResult.cacheWriteTokens,
          },
        }
      : {}),
  };

  const resp = await httpRequestJson(
    'POST',
    `${ctx.serverUrl}/api/v2/turn-end-cost-advisor`,
    ctx.apiKey,
    body,
    timeoutMs,
  );
  hookLogTo(
    ADVISOR_LOG_FILE,
    HOOK_FILE,
    ctx.sessionId,
    resp ? 'result' : 'error',
    `advisor: outcome=${outcome} applied=${resp && resp.body ? resp.body.applied : 'unknown'}`,
    ctx.cwd,
  );
}

// ---------------------------------------------------------------------------
// Attribution branch (Part B, Haiku by default)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ key: string, label: string, type: string, prompt: string }>} attributes
 * @param {string[]} changedFiles
 * @param {Array<{ text: string, isCommandMessage: boolean, skillName: string|null }>} promptTurns
 * @param {Array<{ name: string, description: string }>} skillInvocations
 * @param {number} maxBytes
 * @returns {string}
 */
function buildAttributionPrompt(attributes, changedFiles, promptTurns, skillInvocations, maxBytes) {
  const skillDescriptionsByName = new Map(skillInvocations.map((s) => [s.name, s.description]));

  const fixedLines = [
    'You are classifying a completed Claude Code coding session against a fixed set of',
    'attributes. Respond ONLY with a JSON object whose keys are EXACTLY the attribute keys below',
    '(no extra keys, no markdown, no explanation outside the JSON). Use `null` for any attribute',
    'you cannot determine from the information given.',
    '',
    'Attributes:',
    ...attributes.map((a) => `- ${a.key} (${a.type}): ${a.prompt}`),
    '',
    'Files changed in this session (may be truncated):',
    formatChangedFiles(changedFiles),
  ];
  const fixedText = fixedLines.join('\n');
  const fixedBytes = Buffer.byteLength(fixedText, 'utf8');

  const budgetForPrompts = Math.max(maxBytes - fixedBytes, 1024);
  const promptLines = promptTurns.map(
    (t, i) => `${i + 1}. ${formatPromptTurnText(t, skillDescriptionsByName)}`,
  );
  const promptSample =
    promptLines.length > 0
      ? truncateMiddle(promptLines, budgetForPrompts, (n) => `…(${n} prompts omitted)…`)
      : '(none)';

  return `${fixedText}\n\nUser prompts in this session, in order (may be truncated):\n${promptSample}`;
}

/**
 * @param {string} type
 * @param {*} value
 * @returns {boolean}
 */
function valueMatchesType(type, value) {
  if (value === null) return true; // explicit null always passes (Design Decision 15's shape)
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    default:
      return false;
  }
}

/**
 * @param {{ enabled: boolean, attributes: Array<{key:string,label:string,type:string,prompt:string}>, evaluatedWatermark: number|null, evaluationRequired: boolean }} gate
 * @param {{ serverUrl: string, apiKey: string, claudeBin: string, config: Record<string, *>, sessionId: string, telemetryDir: string, transcriptPath: string, cwd: string, promptWatermark: number }} ctx
 */
async function attributionBranch(gate, ctx) {
  if (!gate.evaluationRequired) {
    hookLogTo(ATTRIBUTION_LOG_FILE, HOOK_FILE, ctx.sessionId, 'result', 'attribution: skipped (evaluation not required)', ctx.cwd);
    return;
  }

  // Sorted-key JSON is stable across calls as long as the server returns attributes in a
  // consistent order — good enough as an equality signature for "did the definitions change".
  const definitionsSignature = JSON.stringify(gate.attributes);
  if (isBlockedByFailureCap(ctx.cwd, ctx.sessionId, definitionsSignature)) {
    hookLogTo(ATTRIBUTION_LOG_FILE, HOOK_FILE, ctx.sessionId, 'result', 'attribution: skipped (3 consecutive failures)', ctx.cwd);
    return;
  }

  const entries = readTranscriptEntries(ctx.transcriptPath);
  const changedFiles = collectChangedFiles(entries);
  const skillInvocations = resolveSkillInvocations(ctx.transcriptPath, ctx.cwd);
  const promptTurns = buildPromptTurns(entries);

  const model = ctx.config.sessionAttributionLlmModel || DEFAULT_ATTRIBUTION_MODEL;
  const timeoutMs = ctx.config.sessionAttributionLlmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const maxPromptBytes =
    (ctx.config.sessionAttributionMaxPromptSizeKb || DEFAULT_MAX_PROMPT_SIZE_KB) * 1024;

  const prompt = buildAttributionPrompt(gate.attributes, changedFiles, promptTurns, skillInvocations, maxPromptBytes);

  const startedAt = new Date();
  const llmResult = await callLlmAsync(prompt, model, timeoutMs, ctx.claudeBin);
  const finishedAt = new Date();

  let outcome;
  let values = null;
  let failureReason = null;

  if (llmResult === null) {
    outcome = 'failed';
    failureReason = 'LLM call timed out or exited non-zero';
  } else {
    try {
      const match = llmResult.text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON object found in LLM response');
      const parsed = JSON.parse(match[0]);
      values = {};
      for (const attr of gate.attributes) {
        if (!Object.prototype.hasOwnProperty.call(parsed, attr.key)) continue;
        const rawValue = parsed[attr.key];
        // Type-validation drops a mistyped value while keeping the rest; explicit `null` always
        // passes.
        if (valueMatchesType(attr.type, rawValue)) {
          values[attr.key] = rawValue;
        }
      }
      outcome = 'submitted';
    } catch (err) {
      outcome = 'failed';
      failureReason = `LLM response is not valid JSON: ${err.message}`;
    }
  }

  if (outcome === 'failed') {
    recordFailure(ctx.cwd, ctx.sessionId, ctx.promptWatermark, definitionsSignature);
  } else {
    recordSuccess(ctx.cwd, ctx.sessionId);
  }

  // No `hook_service` marker is written any more (T-105) — see the matching note in
  // `guardrail-hook.js`. The `invoking_session_id` this marker used to carry is already stored as
  // its own column on the run row below, which is where `computeAttributionSpend()` reads it from.

  const body = {
    sessionId: ctx.sessionId,
    promptWatermark: ctx.promptWatermark,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    invokingSessionId: ctx.sessionId,
    outcome,
    ...(values ? { values } : {}),
    evalSessionId: llmResult ? llmResult.sessionId : null,
    ...(failureReason ? { failureReason } : {}),
    ...(llmResult
      ? {
          cost: {
            model,
            costUsd: llmResult.costUsd,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            cacheReadTokens: llmResult.cacheReadTokens,
            cacheWriteTokens: llmResult.cacheWriteTokens,
          },
        }
      : {}),
  };

  const resp = await httpRequestJson(
    'POST',
    `${ctx.serverUrl}/api/v2/session-attribution`,
    ctx.apiKey,
    body,
    timeoutMs,
  );
  hookLogTo(
    ATTRIBUTION_LOG_FILE,
    HOOK_FILE,
    ctx.sessionId,
    resp ? 'result' : 'error',
    `attribution: outcome=${outcome} applied=${resp && resp.body ? resp.body.applied : 'unknown'}`,
    ctx.cwd,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Count `prompt_start` events in this session's OWN artisyn telemetry file — the local watermark
 * source (Design Decision 17's "watermark computed from local artisyn prompt events"), written by
 * `telemetry-hook.js` on every `UserPromptSubmit`. Fail-open: an unreadable/missing file reads as
 * watermark `0`.
 * @param {string} telemetryDir
 * @param {string} sessionId
 * @returns {number}
 */
function computePromptWatermark(telemetryDir, sessionId) {
  try {
    const raw = fs.readFileSync(path.join(telemetryDir, `${sessionId}.jsonl`), 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.event === 'prompt_start') count++;
      } catch {
        // malformed line — skip
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function main() {
  const { cwd, sessionId, transcriptPath, repoUrl: repoUrlArg } = parseArgs(
    process.argv.slice(2),
    process.env,
  );

  if (!sessionId || !transcriptPath) {
    process.exit(0);
  }

  // Defence in depth behind post-turn-analysis-hook.js's own check of the same marker (see
  // HOOK_SERVICE_ENV_VAR there): a `claude -p` session spawned by this worker must never evaluate
  // itself, and this second check also holds when a newer worker is paired with an older trigger
  // script that predates the guard.
  const hookService = (process.env[HOOK_SERVICE_ENV_VAR] || '').trim();
  if (hookService) {
    hookLog(HOOK_FILE, sessionId, 'result',
      `skipped: session is a '${hookService}' hook-service LLM call, not a user turn`, cwd);
    process.exit(0);
  }

  const config = loadConfig(cwd);
  const serverUrl = (config.serverUrl || '').trim().replace(/\/$/, '');
  const apiKey = (config.apiKey || '').trim();
  if (!serverUrl || !apiKey) {
    process.exit(0);
  }

  const repoUrl = repoUrlArg || (getGitContext(cwd) || {}).remote;
  if (!repoUrl) {
    hookLog(HOOK_FILE, sessionId, 'result', 'skipped: no repoUrl resolvable', cwd);
    process.exit(0);
  }

  const telemetryDir = resolveTelemetryDir(cwd, config);
  const claudeBin = resolveClaude();
  const configFetchTimeoutMs = config.sendLogsTimeoutMs || 10000;
  const promptWatermark = computePromptWatermark(telemetryDir, sessionId);

  hookLog(HOOK_FILE, sessionId, 'activate', `post-turn-analysis start (watermark=${promptWatermark})`, cwd);

  const configUrl =
    `${serverUrl}/api/v2/post-turn-analysis/config` +
    `?repoUrl=${encodeURIComponent(repoUrl)}` +
    `&sessionId=${encodeURIComponent(sessionId)}` +
    `&promptWatermark=${encodeURIComponent(String(promptWatermark))}`;

  const configResp = await httpRequestJson('GET', configUrl, apiKey, undefined, configFetchTimeoutMs);
  if (!configResp || configResp.status !== 200 || !configResp.body) {
    hookLog(HOOK_FILE, sessionId, 'error', 'failed to fetch combined post-turn-analysis config — skipping this turn', cwd);
    process.exit(0);
  }

  const { advisor, attribution } = configResp.body;
  const ctx = {
    serverUrl,
    apiKey,
    claudeBin,
    config,
    sessionId,
    telemetryDir,
    transcriptPath,
    cwd,
    promptWatermark,
  };

  // Design Decision 8 — both branches run concurrently; one's failure/skip never blocks or is
  // blocked by the other's, and each POSTs its own result as soon as it settles.
  const results = await Promise.allSettled([
    advisorBranch(advisor, ctx),
    attributionBranch(attribution, ctx),
  ]);

  for (const [idx, result] of results.entries()) {
    if (result.status === 'rejected') {
      const branchName = idx === 0 ? 'advisor' : 'attribution';
      const branchLogFile = idx === 0 ? ADVISOR_LOG_FILE : ATTRIBUTION_LOG_FILE;
      hookLogTo(branchLogFile, HOOK_FILE, sessionId, 'error', `${branchName} branch threw: ${result.reason && result.reason.message}`, cwd);
    }
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    hookLog(HOOK_FILE, null, 'error', err.message, null);
    process.exit(0);
  });
}

module.exports = {
  main,
  parseArgs,
  resolveClaude,
  httpRequestJson,
  readTranscriptEntries,
  sumCtxTokens,
  computeContextUsage,
  isQualifyingUserEvent,
  getPromptText,
  isCommandMessagePrompt,
  buildPromptTurns,
  resolveSkillInvocations,
  collectChangedFiles,
  truncateMiddle,
  formatChangedFiles,
  formatPromptTurnText,
  buildAdvisorPrompt,
  buildAttributionPrompt,
  valueMatchesType,
  computePromptWatermark,
  advisorBranch,
  attributionBranch,
  // T-104 FR-B local aggregate derivation
  isRejectionText,
  classifyToolOutcome,
  flattenToolResultText,
  computeToolResultBytes,
  normaliseFilePath,
  classifyFile,
  readUsageTokens,
  splitCacheCreationTokens,
  readServiceTier,
  computeWorkTime,
  deriveWorkTimeMs,
  deriveToolUsage,
  deriveFileUsage,
  deriveTokenTotals,
  deriveLastAssistantModel,
  deriveLocalAggregate,
  // T-104 Chunk 4 — cost lookup
  fetchModelPricing,
  computeLocalSessionCost,
  priceLocalAggregate,
  FAST_MODE_MULTIPLIER,
};
