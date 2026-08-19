'use strict';
/**
 * Shared utility — resolve the current session's own log files.
 *
 * Extracted from `prompt-upload-hook.js` so the two narrow-scope upload paths share one
 * implementation:
 *   - `prompt-upload-hook.js`  — the throttled background upload on `UserPromptSubmit`
 *   - `send-logs-hook.js`      — the `SessionEnd` flush (the session's last chance to ship
 *                                its own files; the full multi-session scan stays on
 *                                `Stop`/`Interrupt`)
 *
 * Scope is deliberately two files:
 *   artisyn — <telemetryDir>/<sessionId>.jsonl
 *   claude  — ~/.claude/projects/<slug>/<sessionId>.jsonl
 *
 * `claude-subagent` and `claude-otel` are out of scope here: sub-agent files are discovered by a
 * directory scan that only the full `Stop` run performs, and otel chunk files are collected
 * unfiltered by any session's `Stop` run (every file in the otel dir belongs to this project), so
 * they are not at risk of being stranded by one session ending.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { getGitRoot } = require('./git-context');

/**
 * Resolve exactly the current session's own candidate files — the artisyn telemetry file and
 * the current session's claude transcript file — mirroring send-logs-hook.js's §2.2 project-slug
 * resolution, without the subagent/workflow scan.
 * @param {string|null} cwd
 * @param {string} sessionId
 * @param {string} telemetryDir
 * @returns {{ namespace: 'artisyn'|'claude', filePath: string, size: number }[]}
 */
function collectScopedFiles(cwd, sessionId, telemetryDir) {
  const files = [];

  const artisynPath = path.join(telemetryDir, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(artisynPath);
    if (stat.isFile() && stat.size > 0) {
      files.push({ namespace: 'artisyn', filePath: artisynPath, size: stat.size });
    }
  } catch {
    // artisyn file not present yet — nothing to upload for this namespace
  }

  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    const subdirs = fs
      .readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    // Same slug-matching convention as send-logs-hook.js's §2.2: the exact root-project
    // slug, or any slug prefixed by it (subdirectory projects), falling back to a scan by
    // current session id when neither matches anything.
    const gitRoot = getGitRoot(cwd || process.cwd());
    const gitRootSlug = gitRoot.replace(/[^a-zA-Z0-9-]/g, '-');

    const projectSlugDirs = [];
    for (const subdir of subdirs) {
      const name = subdir.name;
      if (name === gitRootSlug || name.startsWith(gitRootSlug + '-')) {
        projectSlugDirs.push(path.join(claudeProjectsDir, name));
      }
    }

    if (projectSlugDirs.length === 0) {
      for (const subdir of subdirs) {
        const candidate = path.join(claudeProjectsDir, subdir.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          projectSlugDirs.push(path.join(claudeProjectsDir, subdir.name));
          break;
        }
      }
    }

    for (const projectSlugDir of projectSlugDirs) {
      const claudeFilePath = path.join(projectSlugDir, `${sessionId}.jsonl`);
      try {
        const stat = fs.statSync(claudeFilePath);
        if (stat.isFile() && stat.size > 0) {
          files.push({ namespace: 'claude', filePath: claudeFilePath, size: stat.size });
          break; // exactly one claude transcript file for this session id
        }
      } catch {
        // not under this slug dir — try the next candidate
      }
    }
  } catch {
    // ~/.claude/projects absent — nothing to do for the claude namespace
  }

  return files;
}

module.exports = {
  collectScopedFiles,
};
