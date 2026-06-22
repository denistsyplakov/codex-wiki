'use strict';
const fs = require('fs');
const path = require('path');
const { getGitRoot } = require('./git-context');

const _hookVersion = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
    return JSON.parse(raw).version || null;
  } catch { return null; }
})();

/**
 * Append a structured log entry to <project-root>/.ai_work_dir/hook.log
 *
 * @param {string}      hookFile  - calling script filename (e.g. 'telemetry-hook.js')
 * @param {string|null} sessionId - Claude Code session_id (or null)
 * @param {'activate'|'result'|'error'} event - log event type
 * @param {string}      message   - human-readable message
 * @param {string|null} cwd       - project working directory (falls back to process.cwd())
 */
function hookLog(hookFile, sessionId, event, message, cwd) {
  try {
    const base = cwd || process.cwd();
    const dir = path.join(getGitRoot(base), '.ai_work_dir');
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const sid = sessionId || '-';
    const versionTag = (event === 'activate' && _hookVersion) ? ` [hook v${_hookVersion}]` : '';
    const line = `${timestamp} [${hookFile}] [${sid}] [${event}] ${message}${versionTag}\n`;
    fs.appendFileSync(path.join(dir, 'hook.log'), line);
  } catch {
    // logging must never cause hook failures
  }
}

module.exports = { hookLog };
