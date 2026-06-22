#!/usr/bin/env node
/**
 * Claude Code Hook — Stop / Interrupt events
 * Uploads collected JSONL telemetry files to the artisyn-log-hub server.
 *
 * Collects three namespaces:
 *   artisyn         — files from TELEMETRY_DIR (default <cwd>/.ai_work_dir/telemetry)
 *   claude          — files from ~/.claude/projects/<slug>/<session>.jsonl
 *   claude-subagent — files from ~/.claude/projects/<slug>/<session>/subagents/<agent-id>.jsonl
 *
 * Manifest (<telemetry_dir>/.claude-logs.sent) tracks already-uploaded files
 * by size so unchanged files are skipped on subsequent runs.
 *
 * Configure in .claude/telemetry_tool/.env:
 *   SERVER_URL=https://...
 *   API_KEY=...
 *   SEND_LOGS_TIMEOUT_MS=10000   (optional, default 10000)
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const { loadEnvWithLocal, resolveTelemetryDir } = require('./env-context');
const { getGitRoot } = require('./git-context');
const { hookLog } = require('./hook-log');

const HOOK_FILE = 'send-logs-hook.js';

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

/** @param {string} manifestPath @returns {Map<string, number>} */
function readManifest(manifestPath) {
  const map = new Map();
  try {
    const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.lastIndexOf(' ');
      if (spaceIdx === -1) continue;
      const key = trimmed.slice(0, spaceIdx);
      const sizeStr = trimmed.slice(spaceIdx + 1);
      const size = parseInt(sizeStr, 10);
      if (!key || isNaN(size)) continue;
      map.set(key, size);
    }
  } catch {
    // file missing or unreadable — start fresh
  }
  return map;
}

/**
 * Rewrite the manifest file from the current map.
 * @param {string} telemetryDir
 * @param {string} manifestPath
 * @param {Map<string, number>} map
 */
function writeManifest(telemetryDir, manifestPath, map, sessionId, cwd) {
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    let content = '';
    for (const [key, size] of map) {
      content += `${key} ${size}\n`;
    }
    fs.writeFileSync(manifestPath, content, 'utf8');
  } catch (err) {
    const msg = `failed to write manifest: ${err.message}`;
    process.stderr.write(`send-logs-hook: ${msg}\n`);
    hookLog(HOOK_FILE, sessionId, 'error', msg, cwd);
  }
}

// ---------------------------------------------------------------------------
// HTTP upload
// ---------------------------------------------------------------------------

/**
 * Upload a JSONL file to the server.
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} namespace
 * @param {string} sessionId
 * @param {Buffer} body
 * @param {number} timeoutMs
 * @param {string|null} [parentSessionId]
 * @returns {Promise<{ success: boolean, reason: string|null }>}
 */
function uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId) {
  return new Promise((resolve) => {
    let urlStr = `${serverUrl}/api/v1/logs?type=${encodeURIComponent(namespace)}&sessionId=${encodeURIComponent(sessionId)}`;
    if (parentSessionId) {
      urlStr += `&parentSessionId=${encodeURIComponent(parentSessionId)}`;
    }
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (err) {
      const msg = `invalid SERVER_URL: ${err.message}`;
      process.stderr.write(`send-logs-hook: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      resolve({ success: false, reason: msg });
      return;
    }

    const transport = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'X-API-Key': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(options, (res) => {
      // Consume response body to free socket
      res.resume();
      if (res.statusCode === 201) {
        resolve({ success: true, reason: null });
      } else {
        const msg = `upload failed for ${namespace}/${sessionId}: HTTP ${res.statusCode}`;
        process.stderr.write(`send-logs-hook: ${msg}\n`);
        hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
        resolve({ success: false, reason: `HTTP ${res.statusCode}` });
      }
    });

    req.setTimeout(timeoutMs, () => {
      const msg = `upload timeout for ${namespace}/${sessionId}`;
      process.stderr.write(`send-logs-hook: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      req.destroy();
      resolve({ success: false, reason: 'timeout' });
    });

    req.on('error', (err) => {
      const msg = `network error for ${namespace}/${sessionId}: ${err.message}`;
      process.stderr.write(`send-logs-hook: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      resolve({ success: false, reason: `network error: ${err.message}` });
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CLAUDE.md context helpers
// ---------------------------------------------------------------------------

/**
 * Scan the project directory for CLAUDE.md / CLAUDE.local.md files and return
 * their sizes.  Looks in cwd, common sub-directories, and up to one parent dir.
 * @param {string|null} cwd
 * @returns {{ totalBytes: number, files: { path: string, bytes: number }[] }|null}
 */
function buildClaudeMdContext(cwd) {
  if (!cwd) return null;

  const candidates = new Set();
  const roots = [cwd, path.dirname(cwd)];
  const subs = ['', 'client', 'server', 'hook'];
  for (const root of roots) {
    for (const sub of subs) {
      const dir = sub ? path.join(root, sub) : root;
      candidates.add(path.join(dir, 'CLAUDE.md'));
      candidates.add(path.join(dir, 'CLAUDE.local.md'));
    }
  }

  const found = [];
  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size > 0) {
        found.push({ path: filePath, bytes: stat.size });
      }
    } catch {
      // file absent
    }
  }

  if (found.length === 0) return null;

  const totalBytes = found.reduce((s, f) => s + f.bytes, 0);
  return { totalBytes, files: found };
}

// ---------------------------------------------------------------------------
// File collection helpers
// ---------------------------------------------------------------------------

/**
 * List non-empty *.jsonl files in a directory (top-level only).
 * @param {string} dir
 * @returns {{ name: string, size: number }[]}
 */
function listJsonlFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => {
        try {
          const stat = fs.statSync(path.join(dir, e.name));
          return { name: e.name, size: stat.size };
        } catch {
          return null;
        }
      })
      .filter((f) => f !== null && f.size > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Read stdin
  let input = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(process.stdin.fd, 'utf8');
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      // malformed or empty stdin
    }
  }

  const hookEvent = input.hook_event_name;
  if (hookEvent !== 'Stop' && hookEvent !== 'Interrupt') process.exit(0);

  const cwd = input.cwd || null;
  const hookSessionId = input.session_id || null;

  hookLog(HOOK_FILE, hookSessionId, 'activate', `${hookEvent} event received`, cwd);

  const envVars = loadEnvWithLocal(path.join(__dirname, '.env'));
  const serverUrl = (envVars.SERVER_URL || '').trim().replace(/\/$/, '');
  const apiKey = (envVars.API_KEY || '').trim();
  const timeoutMs = parseInt(envVars.SEND_LOGS_TIMEOUT_MS || '10000', 10) || 10000;

  if (!serverUrl || !apiKey) process.exit(0);

  const telemetryDir = resolveTelemetryDir(cwd, envVars);
  const manifestPath = path.join(telemetryDir, '.claude-logs.sent');

  // Load manifest
  const manifest = readManifest(manifestPath);

  // -------------------------------------------------------------------------
  // §2.1 Artisyn files
  // -------------------------------------------------------------------------
  /** @type {{ namespace: string, sessionId: string, filePath: string, size: number, isCurrentSession: boolean }[]} */
  const filesToProcess = [];

  if (fs.existsSync(telemetryDir)) {
    const artisynFiles = listJsonlFiles(telemetryDir);
    for (const { name, size } of artisynFiles) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      filesToProcess.push({
        namespace: 'artisyn',
        sessionId,
        filePath: path.join(telemetryDir, name),
        size,
        isCurrentSession: hookSessionId !== null && sessionId === hookSessionId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // §2.2 Claude files
  // -------------------------------------------------------------------------
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (fs.existsSync(claudeProjectsDir)) {
    // Find all project slug dirs that belong to this git repo.
    // Claude Code names project dirs by slugifying the CWD path
    // (every non-alphanumeric-non-hyphen char → '-'). We collect:
    //   • the exact root-project slug
    //   • any slug that starts with root-slug + '-' (subdirectory projects, e.g. root/dist)
    // Fallback: locate by current session ID when the slug match finds nothing.
    const projectSlugDirs = [];
    try {
      const subdirs = fs
        .readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());

      const gitRoot = getGitRoot(cwd || process.cwd());
      const gitRootSlug = gitRoot.replace(/[^a-zA-Z0-9-]/g, '-');

      for (const subdir of subdirs) {
        const name = subdir.name;
        if (name === gitRootSlug || name.startsWith(gitRootSlug + '-')) {
          projectSlugDirs.push(path.join(claudeProjectsDir, name));
        }
      }

      // Fallback: search by current session ID
      if (projectSlugDirs.length === 0 && hookSessionId) {
        for (const subdir of subdirs) {
          const candidate = path.join(claudeProjectsDir, subdir.name, `${hookSessionId}.jsonl`);
          if (fs.existsSync(candidate)) {
            projectSlugDirs.push(path.join(claudeProjectsDir, subdir.name));
            break;
          }
        }
      }
    } catch {
      // skip
    }

    for (const projectSlugDir of projectSlugDirs) {
      // Main session files
      const claudeFiles = listJsonlFiles(projectSlugDir);
      for (const { name, size } of claudeFiles) {
        const sessionId = name.slice(0, -'.jsonl'.length);
        filesToProcess.push({
          namespace: 'claude',
          sessionId,
          filePath: path.join(projectSlugDir, name),
          size,
          isCurrentSession: hookSessionId !== null && sessionId === hookSessionId,
        });
      }

      // Subagent files: <projectSlugDir>/<session-id>/subagents/<agent-id>.jsonl
      let sessionDirs;
      try {
        sessionDirs = fs
          .readdirSync(projectSlugDir, { withFileTypes: true })
          .filter((e) => e.isDirectory());
      } catch {
        sessionDirs = [];
      }

      for (const sessionDir of sessionDirs) {
        const subagentsDir = path.join(projectSlugDir, sessionDir.name, 'subagents');
        if (!fs.existsSync(subagentsDir)) continue;
        const subagentFiles = listJsonlFiles(subagentsDir);
        for (const { name, size } of subagentFiles) {
          const agentId = name.slice(0, -'.jsonl'.length);
          filesToProcess.push({
            namespace: 'claude-subagent',
            sessionId: agentId,
            filePath: path.join(subagentsDir, name),
            size,
            // parent session dir name matches current hook session
            isCurrentSession: hookSessionId !== null && sessionDir.name === hookSessionId,
            manifestKey: `claude-subagent/${sessionDir.name}/${name}`,
            parentSessionId: sessionDir.name,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Upload loop
  // -------------------------------------------------------------------------
  let uploadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const { namespace, sessionId, filePath, size, isCurrentSession, manifestKey: mkOverride, parentSessionId } of filesToProcess) {
    const manifestKey = mkOverride ?? `${namespace}/${path.basename(filePath)}`;

    // Skip logic (only for non-current-session files)
    if (!isCurrentSession) {
      const recorded = manifest.get(manifestKey);
      if (recorded !== undefined && recorded === size) {
        skippedCount++;
        continue; // already uploaded at this exact size
      }
    }

    // Read file content
    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch (err) {
      process.stderr.write(`send-logs-hook: cannot read ${filePath}: ${err.message}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'fail', `${manifestKey}: cannot read file: ${err.message}`, cwd);
      failedCount++;
      continue;
    }

    // For all claude/subagent sessions, prepend a system-context event with CLAUDE.md sizes
    if (namespace === 'claude' || namespace === 'claude-subagent') {
      const claudeMdCtx = buildClaudeMdContext(cwd);
      if (claudeMdCtx) {
        const contextLine = JSON.stringify({ type: 'system-context', claudeMd: claudeMdCtx }) + '\n';
        body = Buffer.concat([Buffer.from(contextLine, 'utf8'), body]);
      }
    }

    const { success, reason } = await uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId || null);

    if (success) {
      // Don't record current-session files in the manifest: Claude Code appends
      // turn_duration to the JSONL after the Stop hook fires, so the file will
      // grow. Omitting the manifest entry ensures the next Stop re-uploads the
      // file and picks up those late-written events.
      if (!isCurrentSession) {
        manifest.set(manifestKey, size);
        writeManifest(telemetryDir, manifestPath, manifest, hookSessionId, cwd);
      }
      uploadedCount++;
    } else {
      hookLog(HOOK_FILE, hookSessionId, 'fail', `${manifestKey}: ${reason}`, cwd);
      failedCount++;
    }
  }

  hookLog(HOOK_FILE, hookSessionId, 'result',
    `done: uploaded=${uploadedCount} skipped=${skippedCount} failed=${failedCount} total=${filesToProcess.length}`,
    cwd);
  process.exit(0);
}

main().catch((err) => {
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.stderr.write(`send-logs-hook error: ${err.message}\n`);
  process.exit(0);
});
