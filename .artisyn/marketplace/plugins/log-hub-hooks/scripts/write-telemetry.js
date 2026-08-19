'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Re-entrancy marker set by `claude-invoke-async.js` / `guardrail-hook.js` on every `claude -p`
 * child they spawn. Claude Code runs a session's hooks as child processes of the CLI, so the whole
 * environment propagates: inside one of those evaluation sessions, THIS variable is set.
 *
 * Keep the name in sync with `claude-invoke-async.js`, `guardrail-hook.js`,
 * `post-turn-analysis-hook.js` and `post-turn-analysis-worker.js`, which all read or set it.
 */
const HOOK_SERVICE_ENV_VAR = 'ARTISYN_HOOK_SERVICE';

/**
 * Append one JSON event line to `<telemetryDir>/<session_id>.jsonl`.
 *
 * **Suppressed inside a hook-service session (T-105).** The hook's own `claude -p` evaluation
 * sessions (attribution, advisor, guardrail) run their own full hook set, so each one used to write
 * its own `SessionStart` / `prompt_start` / `SessionEnd` / tool events into the telemetry dir — a
 * complete 1,811-byte session log describing the hook classifying a session, which then became
 * another session to upload and classify. On this machine that was 1,385 of 2,399 artisyn files
 * (57.7%), 2.4 MB of content that shipped as ~785 MB once per-file context prepends were applied.
 *
 * The deliberate one-line `hook_service` marker is NOT written from inside those sessions — it is
 * written by the spawning parent (`post-turn-analysis-worker.js`, `guardrail-hook.js`), which does
 * not carry the variable — so it still lands and the server's
 * `logs.body @> '[{"event":"hook_service"}]'` check keeps identifying these sessions. What is gone
 * is only the evaluation session's own transcript of itself.
 *
 * Fail-open by omission: an older hook that never set the variable simply writes as before.
 *
 * @param {object} event
 * @param {string} telemetryDir
 * @returns {boolean} true when the line was written, false when suppressed
 */
function writeTelemetry(event, telemetryDir) {
  if ((process.env[HOOK_SERVICE_ENV_VAR] || '').trim() !== '') return false;
  fs.mkdirSync(telemetryDir, {recursive: true});
  const sessionId = event.session_id || 'unknown-session';
  const filepath = path.join(telemetryDir, `${sessionId}.jsonl`);
  fs.appendFileSync(filepath, JSON.stringify(event) + '\n', 'utf8');
  return true;
}

module.exports = {writeTelemetry, HOOK_SERVICE_ENV_VAR};
