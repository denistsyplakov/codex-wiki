'use strict';
/**
 * Claude Code Hook helper — async `claude -p` invocation (not a hook entry point itself).
 *
 * T-101 Design Decision 7: guardrail's `callLlm()` (`guardrail-hook.js`) is a `spawnSync`-based
 * `--print --no-session-persistence --output-format json` call that blocks the caller until the
 * child exits — fine for guardrail's single synchronous `PreToolUse` check, but incompatible with
 * `post-turn-analysis-worker.js` running its advisor and attribution branches CONCURRENTLY
 * (Design Decision 8, `Promise.allSettled`). `callLlmAsync()` is the same fail-open/JSON-envelope
 * contract in async, spawn-based, Promise-returning form: never throws, resolves `null` on any
 * failure (spawn error, timeout, non-zero exit), and falls back to treating stdout as plain text
 * (no session id / cost) when the envelope isn't valid JSON — exactly like the sync original.
 *
 * This is the ONE helper module genuinely shared between Part A (advisor, Sonnet) and Part B
 * (attribution, Haiku) — every other hook helper in this codebase stays copied per script, but
 * both call sites here live in the same worker file by construction (`post-turn-analysis-worker.js`),
 * so there is no cross-script coupling to avoid.
 *
 * Unlike `callLlm()`, this helper also extracts `total_cost_usd`/`usage` from the envelope: both
 * branches need `costUsd`/token counts for their `POST` bodies' `cost` block, and `model` is
 * already known to the caller (it's the very parameter passed in), so it isn't re-derived here.
 */
const { spawn } = require('child_process');
const { buildProcessMarkerEnv, killProcessTree } = require('./process-marker');

/**
 * Marker exported into every `claude -p` session this helper spawns, and inherited from there by
 * that session's OWN hooks (Claude Code runs hooks as child processes of the CLI, so the whole
 * environment propagates).
 *
 * Without it the classifier/advisor session's `Stop` re-enters `post-turn-analysis-hook.js` and
 * spawns yet another pair of `claude -p` evaluations, which do the same again: one real user turn
 * fans out into an unbounded chain of LLM calls. Measured before this guard: 534 worker runs in 33
 * minutes, 502 of them hook-service sessions whose submissions the server discarded as
 * not-yet-ingested. `guardrail-hook.js`'s `callLlm()` sets the same variable (with its own service
 * name) for the same reason — keep the two in sync.
 */
const HOOK_SERVICE_ENV_VAR = 'ARTISYN_HOOK_SERVICE';
const HOOK_SERVICE_NAME = 'post-turn-analysis';

// Caps how much stdout is buffered from the child, mirroring the response-body caps
// `upload-logs.js` applies on the receiving side — a runaway/looping child must never grow this
// process's memory unbounded. Far larger than any real `--output-format json` envelope needs.
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

/**
 * Parse the `--output-format json` envelope, mirroring `guardrail-hook.js`'s `callLlm()` exactly:
 * on a valid envelope, `result` is the LLM's text and `session_id` is the spawned session id;
 * on anything else (plain text, malformed JSON), the raw stdout is used as-is and the
 * session/cost fields stay at their "unknown" defaults — this is a plain-text FALLBACK, not a
 * failure, so it never resolves `callLlmAsync()` to `null`.
 * @param {string} raw
 * @returns {{ text: string, sessionId: string|null, costUsd: number|null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }}
 */
function parseEnvelope(raw) {
  let text = raw;
  let sessionId = null;
  let costUsd = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.result === 'string') {
      text = parsed.result;
      sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
      costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
      const usage = (parsed && typeof parsed.usage === 'object' && parsed.usage) || {};
      inputTokens = Number(usage.input_tokens) || 0;
      outputTokens = Number(usage.output_tokens) || 0;
      cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
      cacheWriteTokens = Number(usage.cache_creation_input_tokens) || 0;
    }
  } catch {
    // plain-text fallback — session id/cost stay unknown, matching callLlm()'s own contract
  }

  return { text, sessionId, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * Invoke `claude --print` with `prompt` on stdin, async. Fail-open: resolves `null` on a spawn
 * error, a timeout, or a non-zero exit code — the caller is expected to treat `null` exactly like
 * guardrail's callers treat its own `null` return (skip this evaluation attempt, never throw).
 *
 * @param {string} prompt
 * @param {string} model - e.g. `'sonnet'` (advisor) or `'haiku'` (attribution)
 * @param {number} timeoutMs
 * @param {string} claudeBin - resolved claude executable (`'claude'` or `'claude.cmd'` on
 *   Windows) — resolution itself is the caller's job, same division of labor as guardrail's
 *   `resolveClaude()` feeding its own `callLlm()`.
 * @returns {Promise<{ text: string, sessionId: string|null, costUsd: number|null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }|null>}
 */
function callLlmAsync(prompt, model, timeoutMs, claudeBin) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(
        claudeBin,
        ['--model', model, '--print', '--no-session-persistence', '--output-format', 'json'],
        {
          // shell: true on Windows so a `.cmd` shim resolves the same way spawnSync's
          // `shell: process.platform === 'win32'` does in guardrail-hook.js.
          shell: process.platform === 'win32',
          // windowsHide: see the note in git-context.js — this worker is itself launched
          // detached/console-less (spawn-hidden.js), so any console-subsystem grandchild it
          // spawns would otherwise get a visible console allocated for it. Pinned by
          // __tests__/no-visible-window.test.js — do not drop it.
          windowsHide: true,
          // Inherit the caller's environment (spawn's default when `env` is omitted) plus the
          // hook-service marker — see HOOK_SERVICE_ENV_VAR above. Pinned by
          // __tests__/claude-invoke-async.test.js. The ARTISYN_PROC_* markers merged in after it
          // are inert provenance (process-marker.js), never branched on — unlike
          // ARTISYN_HOOK_SERVICE, which is a re-entrancy guard that changes behaviour.
          env: Object.assign(
            {},
            process.env,
            { [HOOK_SERVICE_ENV_VAR]: HOOK_SERVICE_NAME },
            buildProcessMarkerEnv(`claude-invoke:${model}`, { hookFile: 'claude-invoke-async.js' }),
          ),
        }
      );
    } catch {
      settle(null);
      return;
    }

    const timer = setTimeout(() => {
      // killProcessTree, not child.kill(): `shell: true` on Windows makes `child` a `cmd.exe`
      // wrapper whose grandchild is the real `claude` process, so killing the child alone leaves
      // a timed-out LLM call running. Best-effort either way — the 'close'/'error' handlers below
      // still fire.
      killProcessTree(child);
      settle(null);
    }, timeoutMs);
    // Doesn't keep the process alive on its own merit — the child process itself does that,
    // and this timer is always cleared on 'close'/'error'. Explicit unref() is unnecessary here
    // since a live child already holds the event loop open, but costs nothing to be defensive.

    const stdoutChunks = [];
    let stdoutBytes = 0;

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= MAX_STDOUT_BYTES) return;
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.on('error', () => {
      clearTimeout(timer);
      settle(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(null);
        return;
      }
      const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
      settle(parseEnvelope(raw));
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      // a write failure here still resolves via the 'error'/'close' handlers above
    }
  });
}

module.exports = { callLlmAsync };
