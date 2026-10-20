'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONFIG = {
  port: Number(process.env.PORT || 8080),
  workspacesDir: process.env.WORKSPACES_DIR || '/workspaces',
  dataDir: process.env.DATA_DIR || '/data',
  maxFixAttempts: Number(process.env.MAX_FIX_ATTEMPTS || 5),
  softDeadlineSec: Number(process.env.SOFT_DEADLINE_SEC || 780),
  runTimeoutSec: Number(process.env.RUN_TIMEOUT_SEC || 120),
  cloneTimeoutSec: Number(process.env.CLONE_TIMEOUT_SEC || 120),
  maxTurns: Number(process.env.MAX_TURNS || 10),
  runAsUid: process.env.RUN_AS_UID ? Number(process.env.RUN_AS_UID) : null,
  runAsGid: process.env.RUN_AS_GID ? Number(process.env.RUN_AS_GID) : null,
  runnerHome: process.env.RUNNER_HOME || (process.env.RUN_AS_UID ? '/home/runner' : os.homedir()),
  defaultPushRepo: process.env.DEFAULT_PUSH_REPO || '',
};

const LIMITS = {
  toolOutputChars: 2500,
  readFileChars: 4000,
  readFileMaxLines: 150,
  listMaxEntries: 200,
  searchMaxLines: 40,
  stateFieldChars: 1500,
  logEntries: 200,
  writeMaxBytes: 200 * 1024,
  bodyMaxBytes: 1024 * 1024,
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '.agent', '__pycache__', '.venv', 'venv', '.pytest_cache', '.next', '.cache']);
const GITHUB_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const TRIVIAL_COMMAND = /^(?:true|:|false|exit\s+0|echo(?:\s+[\s\S]*)?)$/i;
const TEST_FILE = /(?:^|\/)(?:test_.+\.[a-z0-9]+|.+_test\.[a-z0-9]+|.+\.(?:test|spec)\.[a-z0-9]+)$/i;
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)/i;
const TEST_RUNNER = /\b(?:pytest|jest|mocha|vitest|phpunit|rspec|ctest)\b|\bnode\s+--test\b|\bpython(?:3)?\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+(?:-q\s+)?test\b|\bgradle\s+test\b|\bdotnet\s+test\b/i;

const tasksDir = path.join(CONFIG.dataDir, 'tasks');
const reportsDir = path.join(CONFIG.dataDir, 'reports');
const activeFile = path.join(CONFIG.dataDir, 'active.json');
fs.mkdirSync(tasksDir, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(CONFIG.workspacesDir, { recursive: true });

const dropPrivileges = process.getuid && process.getuid() === 0 && CONFIG.runAsUid !== null;

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- helpers ----------

function truncate(text, max, tailShare = 0.75) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const tail = Math.floor(max * tailShare);
  const head = max - tail;
  return `${s.slice(0, head)}\n...[${s.length - max} chars truncated]...\n${s.slice(s.length - tail)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function chownForRunner(p) {
  if (dropPrivileges) fs.chownSync(p, CONFIG.runAsUid, CONFIG.runAsGid ?? CONFIG.runAsUid);
}

function mkdirpForRunner(dir, stopAt) {
  const missing = [];
  let cur = dir;
  while (!fs.existsSync(cur) && cur.startsWith(stopAt)) {
    missing.unshift(cur);
    cur = path.dirname(cur);
  }
  for (const d of missing) {
    fs.mkdirSync(d);
    chownForRunner(d);
  }
}

function runProcess(cmd, args, { cwd, timeoutSec = CONFIG.runTimeoutSec, maxBuffer = 200 * 1024 } = {}) {
  return new Promise((resolve) => {
    const options = {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: CONFIG.runnerHome,
        LANG: 'C.UTF-8',
        CI: '1',
        TERM: 'dumb',
        GIT_TERMINAL_PROMPT: '0',
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    };
    if (dropPrivileges) {
      options.uid = CONFIG.runAsUid;
      options.gid = CONFIG.runAsGid ?? CONFIG.runAsUid;
    }
    let output = '';
    let timedOut = false;
    const child = spawn(cmd, args, options);
    const append = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > maxBuffer) output = output.slice(output.length - maxBuffer);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        child.kill('SIGKILL');
      }
    }, timeoutSec * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, timedOut, output: output + `\n${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code === null ? (signal ? 137 : 1) : code, timedOut, output });
    });
  });
}

function git(ws, args, timeoutSec = 60) {
  return runProcess('git', args, { cwd: ws, timeoutSec });
}

// ---------- task state ----------

function taskFile(taskId) {
  return path.join(tasksDir, `${taskId}.json`);
}

function saveState(state) {
  fs.writeFileSync(taskFile(state.taskId), JSON.stringify(state, null, 2));
}

function loadState(taskId) {
  if (!taskId || !TASK_ID.test(taskId) || !fs.existsSync(taskFile(taskId))) return null;
  return JSON.parse(fs.readFileSync(taskFile(taskId), 'utf8'));
}

function activeTaskId() {
  if (!fs.existsSync(activeFile)) return null;
  return JSON.parse(fs.readFileSync(activeFile, 'utf8')).taskId || null;
}

function resolveState(req, body) {
  const taskId = (body && body.taskId) || req.headers['x-task-id'] || activeTaskId();
  const state = loadState(String(taskId || '').trim());
  if (!state) throw new ToolError('NO_TASK', 'No task found. Call /init first.');
  return state;
}

function workspaceOf(state) {
  return path.join(CONFIG.workspacesDir, state.taskId);
}

function secondsLeft(state) {
  return Math.max(0, Math.round(CONFIG.softDeadlineSec - (Date.now() - state.createdAt) / 1000));
}

function fixAttemptsUsed(state) {
  return Math.min(CONFIG.maxFixAttempts, state.fixAttempts);
}

function budget(state) {
  return {
    turn: state.turn,
    maxTurns: CONFIG.maxTurns,
    secondsLeft: secondsLeft(state),
    fixAttemptsUsed: fixAttemptsUsed(state),
    fixAttemptsLeft: CONFIG.maxFixAttempts - fixAttemptsUsed(state),
    limitReached: state.limitReached,
  };
}

function addLog(state, tool, info) {
  state.log.push({ at: nowIso(), tool, info: truncate(String(info).replace(/\s+/g, ' '), 240, 0.3) });
  if (state.log.length > LIMITS.logEntries) state.log.splice(0, state.log.length - LIMITS.logEntries);
}

function isFinished(state) {
  return state.status !== 'running';
}

function guard(state, kind) {
  if (isFinished(state)) {
    throw new ToolError('TASK_FINISHED', `Task already finished with status ${state.status}. Stop calling tools.`);
  }
  if (kind === 'read') return;
  if (state.limitReached) {
    throw new ToolError('LIMIT_REACHED', `Fix-attempt limit (${CONFIG.maxFixAttempts}) reached. Call finish with status FAILED and explain the last error.`);
  }
  if (secondsLeft(state) <= 0) {
    throw new ToolError('DEADLINE', 'Time budget is used up. Call finish with status FAILED and report what is left.');
  }
}

// ---------- path safety ----------

function safePath(ws, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new ToolError('BAD_PATH', 'path is required');
  const cleaned = rel.trim().replace(/^\/+/, '');
  const resolved = path.resolve(ws, cleaned);
  if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
    throw new ToolError('BAD_PATH', 'Path escapes the workspace.');
  }
  const relToWs = path.relative(ws, resolved);
  if (relToWs.split(path.sep)[0] === '.git') throw new ToolError('BAD_PATH', 'The .git folder is off limits.');
  let existing = resolved;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = fs.realpathSync(existing);
  const realWs = fs.realpathSync(ws);
  if (real !== realWs && !real.startsWith(realWs + path.sep)) {
    throw new ToolError('BAD_PATH', 'Path resolves outside the workspace (symlink).');
  }
  return resolved;
}

function listTree(ws, rel = '.', depth = 2) {
  const root = rel === '.' ? ws : safePath(ws, rel);
  if (!fs.existsSync(root)) throw new ToolError('NOT_FOUND', `No such path: ${rel}`);
  const lines = [];
  let truncated = false;
  const walk = (dir, level) => {
    if (truncated) return;
    let entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (lines.length >= LIMITS.listMaxEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      const shown = path.relative(ws, full);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) {
          lines.push(`${shown}/ (skipped)`);
          continue;
        }
        lines.push(`${shown}/`);
        if (level < depth) walk(full, level + 1);
      } else if (e.isFile()) {
        lines.push(`${shown} (${fs.statSync(full).size}b)`);
      }
    }
  };
  walk(root, 1);
  return { entries: lines.join('\n') || '(empty)', truncated };
}

function projectHints(ws) {
  const hints = [];
  const pkgPath = path.join(ws, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      hints.push(`node project; scripts: ${Object.keys(pkg.scripts || {}).join(', ') || 'none'}`);
      if (pkg.scripts && pkg.scripts.test) hints.push(`test script: ${pkg.scripts.test}`);
    } catch (e) {
      hints.push('package.json is not valid JSON');
    }
  }
  for (const f of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    if (fs.existsSync(path.join(ws, f))) hints.push(`python project (${f})`);
  }
  if (!hints.length) hints.push(fs.readdirSync(ws).filter((n) => n !== '.git').length ? 'no known build file' : 'empty workspace');
  return hints;
}

function blankState({ taskId, request, repoUrl, chatId, project }) {
  return {
    taskId,
    chatId: chatId ? String(chatId) : '',
    request: truncate(request, 4000, 0.2),
    repoUrl: repoUrl || '',
    mode: repoUrl ? 'existing-codebase' : 'new-project',
    project: String(project || repoUrl || 'general'),
    createdAt: Date.now(),
    status: 'running',
    stopReason: '',
    turn: 0,
    failedRuns: 0,
    fixAttempts: 0,
    limitReached: false,
    baseCommit: '',
    plan: '',
    notes: '',
    nextStep: '',
    lastRun: null,
    lastSetup: null,
    lastWriteAt: 0,
    filesWritten: [],
    final: null,
    log: [],
  };
}

function isTestLike(rel) {
  return TEST_FILE.test(rel) || TEST_DIR.test(rel);
}

function findTestFiles(ws, limit = 20) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= limit || depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(ws, full);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && isTestLike(rel)) found.push(rel);
    }
  };
  if (fs.existsSync(ws)) walk(ws, 0);
  return found;
}

function commandReferencesTest(ws, command) {
  for (let token of String(command).split(/\s+/)) {
    token = token.replace(/^['"]|['"]$/g, '').replace(/[;,]+$/g, '');
    if (!token || token.startsWith('-')) continue;
    const abs = path.resolve(ws, token);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (isTestLike(path.relative(ws, abs))) return true;
  }
  return false;
}

function npmTestScript(ws, command) {
  if (!/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(command)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
    const script = pkg.scripts && pkg.scripts.test ? String(pkg.scripts.test).trim() : '';
    return script || false;
  } catch (e) {
    return false;
  }
}

// DONE requires a real test run: a trivial `true` / `echo` is not evidence, and the
// command (or the package.json test script it invokes) must execute a test file or a known runner.
function explainTestEvidence(ws, command) {
  const flat = String(command || '').trim().replace(/\s+/g, ' ');
  if (!flat || TRIVIAL_COMMAND.test(flat)) return 'The command does not run a test suite.';
  const script = npmTestScript(ws, flat);
  if (script === false) return 'package.json has no test script, so this npm/yarn/pnpm test command is not evidence.';
  const effective = script || flat;
  if (TRIVIAL_COMMAND.test(effective)) return 'The test script does not run tests.';
  if (commandReferencesTest(ws, effective)) return null;
  if (TEST_RUNNER.test(effective) && findTestFiles(ws).length) return null;
  return 'No test file or test runner was executed. Run the project tests, for example npm test, pytest, or node --test.';
}

async function workspaceSnapshot(state) {
  const ws = workspaceOf(state);
  if (!fs.existsSync(ws)) {
    return { diff: { stat: '(no workspace)', files: [], patch: '' }, tree: '(workspace was not created)' };
  }
  let tree = '(unreadable)';
  try {
    tree = listTree(ws, '.', 3).entries;
  } catch (e) {
    tree = String(e.message || e);
  }
  let diff = { stat: '(no git repository)', files: [], patch: '' };
  if (fs.existsSync(path.join(ws, '.git'))) {
    try {
      diff = await collectDiff(state, 6000);
    } catch (e) {
      diff = { stat: `Could not read diff: ${e.message}`, files: [], patch: '' };
    }
  }
  return { diff, tree };
}

function reportFields(state, markdown, durationSec, diff) {
  const final = state.final || {};
  const summaryLine = (final.summary || state.stopReason || '').split('\n')[0];
  return {
    taskId: state.taskId,
    chatId: state.chatId,
    project: state.project,
    mode: state.mode,
    status: state.status,
    stopReason: state.stopReason,
    summary: final.summary || '',
    lessons: final.lessons || [],
    hasChanges: diff.files.length > 0,
    filesChanged: diff.files,
    fixAttemptsUsed: fixAttemptsUsed(state),
    turns: state.turn,
    durationSec,
    canPush: state.status === 'DONE' && diff.files.length > 0,
    caption: truncate(`Task ${state.taskId}: ${state.status}. ${summaryLine}`.replace(/[<>&*_`[\]]/g, ''), 900, 0.1),
    markdown,
  };
}

async function writeReport(state) {
  const { diff, tree } = await workspaceSnapshot(state);
  const { markdown, durationSec } = buildReport(state, diff, tree);
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, `${state.taskId}.md`), markdown);
  const ws = workspaceOf(state);
  if (fs.existsSync(ws)) {
    try {
      const agentDir = path.join(ws, '.agent');
      mkdirpForRunner(agentDir, ws);
      fs.writeFileSync(path.join(agentDir, 'REPORT.md'), markdown);
    } catch (e) {
      addLog(state, 'report', `workspace copy failed: ${e.message}`);
      saveState(state);
    }
  }
  return reportFields(state, markdown, durationSec, diff);
}

async function failTask(state, status, reason) {
  state.status = status;
  state.stopReason = truncate(String(reason || status), 1500, 0.4);
  addLog(state, 'stop', `${status}: ${state.stopReason}`);
  saveState(state);
  const report = await writeReport(state);
  return { ok: false, error: status, message: state.stopReason, ...report };
}

// ---------- handlers ----------

async function handleInit(body) {
  const request = String(body.request || '').trim();
  if (!request) throw new ToolError('BAD_REQUEST', 'request is required');
  let taskId = String(body.taskId || '').trim();
  if (!TASK_ID.test(taskId)) taskId = `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const repoUrl = String(body.repoUrl || '').trim();
  const state = blankState({ taskId, request, repoUrl, chatId: body.chatId, project: body.project });

  if (repoUrl && !GITHUB_URL.test(repoUrl)) {
    return failTask(state, 'BAD_REPO', 'Only https://github.com/<owner>/<repo> URLs are allowed.');
  }

  const ws = workspaceOf(state);
  if (fs.existsSync(ws)) {
    return failTask(state, 'INIT_FAILED', `Task ${taskId} already exists.`);
  }
  fs.mkdirSync(ws);
  chownForRunner(ws);

  let head = '';
  if (repoUrl) {
    const clone = await git(ws, ['clone', '--depth', '50', repoUrl, '.'], CONFIG.cloneTimeoutSec);
    if (clone.exitCode !== 0) {
      return failTask(state, 'CLONE_FAILED', truncate(clone.output || 'git clone failed', 1500, 0.7));
    }
  } else {
    const init = await git(ws, ['init', '-q', '-b', 'main']);
    if (init.exitCode !== 0) return failTask(state, 'INIT_FAILED', truncate(init.output || 'git init failed', 1500, 0.7));
  }
  const email = await git(ws, ['config', 'user.email', 'agent@sandbox.local']);
  const name = await git(ws, ['config', 'user.name', 'Coding Agent']);
  if (email.exitCode !== 0 || name.exitCode !== 0) {
    return failTask(state, 'INIT_FAILED', truncate(email.output || name.output || 'git config failed', 1500, 0.7));
  }
  if (!repoUrl) {
    const base = await git(ws, ['commit', '-q', '--allow-empty', '-m', 'base: empty workspace']);
    if (base.exitCode !== 0) return failTask(state, 'INIT_FAILED', truncate(base.output || 'git commit failed', 1500, 0.7));
  }
  const rev = await git(ws, ['rev-parse', 'HEAD']);
  if (rev.exitCode !== 0) return failTask(state, 'INIT_FAILED', truncate(rev.output || 'git rev-parse failed', 1500, 0.7));
  head = rev.output.trim();
  fs.appendFileSync(path.join(ws, '.git', 'info', 'exclude'), '\nnode_modules/\n.agent/\n__pycache__/\n.venv/\n*.pyc\n.pytest_cache/\n');

  const prevId = activeTaskId();
  const prev = loadState(prevId);
  if (prev && prev.status === 'running') {
    prev.status = 'ABANDONED';
    prev.stopReason = `Replaced by task ${taskId}`;
    addLog(prev, 'stop', prev.stopReason);
    saveState(prev);
    await writeReport(prev);
  }

  state.baseCommit = head;
  addLog(state, 'init', repoUrl ? `cloned ${repoUrl}` : 'empty workspace');
  saveState(state);
  fs.writeFileSync(activeFile, JSON.stringify({ taskId }));

  return {
    ok: true,
    taskId,
    mode: state.mode,
    project: state.project,
    hints: projectHints(ws),
    tree: listTree(ws, '.', 2).entries,
    budget: budget(state),
  };
}

function workingState(state) {
  const last = state.lastRun;
  return {
    plan: state.plan || '(no plan yet)',
    notes: state.notes || '(none)',
    nextStep: state.nextStep || '(not set)',
    filesWritten: state.filesWritten.slice(-20),
    lastRun: last
      ? { command: last.command, purpose: last.purpose, exitCode: last.exitCode, timedOut: last.timedOut, outputTail: truncate(last.output, 800, 0.9) }
      : null,
  };
}

function handleTurn(req, body) {
  const state = resolveState(req, body);
  if (state.turn > 0) {
    if (body.agentError) addLog(state, 'agent-error', body.agentError);
    else if (body.agentOutput) addLog(state, 'agent-turn-end', body.agentOutput);
  }
  let stop = false;
  let reason = '';
  if (state.final) {
    stop = true;
    reason = `Agent finished with status ${state.final.status}`;
  } else if (isFinished(state)) {
    stop = true;
    reason = state.stopReason || `Task status ${state.status}`;
  } else if (state.limitReached) {
    stop = true;
    state.status = 'LIMIT_REACHED';
    reason = `Stopped: ${CONFIG.maxFixAttempts} fix attempts used and the last run still failed.`;
  } else if (secondsLeft(state) <= 0) {
    stop = true;
    state.status = 'DEADLINE';
    reason = `Stopped: time budget of ${CONFIG.softDeadlineSec}s used up.`;
  } else if (state.turn >= CONFIG.maxTurns) {
    stop = true;
    state.status = 'MAX_TURNS';
    reason = `Stopped: ${CONFIG.maxTurns} agent turns used without calling finish.`;
  } else {
    state.turn += 1;
  }
  if (stop && !state.stopReason) state.stopReason = reason;
  saveState(state);
  return {
    ok: true,
    stop,
    reason: stop ? state.stopReason : '',
    status: state.status,
    taskId: state.taskId,
    chatId: state.chatId,
    mode: state.mode,
    budget: budget(state),
    workingState: workingState(state),
    recentActions: state.log.slice(-8).map((l) => `${l.tool}: ${l.info}`),
  };
}

async function toolListFiles(state, body) {
  guard(state, 'read');
  const depth = Math.min(4, Math.max(1, Number(body.depth) || 2));
  const rel = String(body.path || '.').trim() || '.';
  const res = listTree(workspaceOf(state), rel, depth);
  addLog(state, 'list_files', `${rel} depth ${depth}`);
  return { path: rel, ...res };
}

async function toolReadFile(state, body) {
  guard(state, 'read');
  const ws = workspaceOf(state);
  const file = safePath(ws, body.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ToolError('NOT_FOUND', `No such file: ${body.path}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = Math.max(1, Number(body.startLine) || 1);
  const requestedEnd = Number(body.endLine) || start + LIMITS.readFileMaxLines - 1;
  const end = Math.min(lines.length, requestedEnd, start + LIMITS.readFileMaxLines - 1);
  const content = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}| ${l}`)
    .join('\n');
  addLog(state, 'read_file', `${body.path} ${start}-${end}`);
  return {
    path: body.path,
    totalLines: lines.length,
    startLine: start,
    endLine: end,
    more: end < lines.length ? `File continues. Read from line ${end + 1} if needed.` : '',
    content: truncate(content, LIMITS.readFileChars, 0.25),
  };
}

async function toolSearch(state, body) {
  guard(state, 'read');
  const pattern = String(body.pattern || '');
  if (!pattern) throw new ToolError('BAD_REQUEST', 'pattern is required');
  const ws = workspaceOf(state);
  const rel = String(body.path || '.').trim() || '.';
  const target = rel === '.' ? ws : safePath(ws, rel);
  const args = ['-rnIE', '--max-count=5'];
  for (const d of SKIP_DIRS) args.push(`--exclude-dir=${d}`);
  args.push('--', pattern, target);
  const res = await runProcess('grep', args, { cwd: ws, timeoutSec: 20 });
  const lines = res.output
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.startsWith(ws) ? l.slice(ws.length + 1) : l))
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}...` : l));
  addLog(state, 'search', `${pattern} in ${rel}: ${lines.length} hits`);
  return {
    pattern,
    matches: lines.slice(0, LIMITS.searchMaxLines).join('\n') || '(no matches)',
    totalMatches: lines.length,
    truncated: lines.length > LIMITS.searchMaxLines,
  };
}

async function toolWriteFile(state, body) {
  guard(state, 'write');
  const ws = workspaceOf(state);
  const file = safePath(ws, body.path);
  const content = typeof body.content === 'string' ? body.content : '';
  if (Buffer.byteLength(content) > LIMITS.writeMaxBytes) throw new ToolError('TOO_LARGE', 'File content is larger than 200KB.');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw new ToolError('BAD_PATH', 'Path is a directory.');
  mkdirpForRunner(path.dirname(file), ws);
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, content);
  chownForRunner(file);
  const rel = path.relative(ws, file);
  state.lastWriteAt = Date.now();
  if (!state.filesWritten.includes(rel)) state.filesWritten.push(rel);
  addLog(state, 'write_file', `${existed ? 'edited' : 'created'} ${rel} (${content.split('\n').length} lines)`);
  return { path: rel, action: existed ? 'edited' : 'created', lines: content.split('\n').length, bytes: Buffer.byteLength(content) };
}

async function toolRun(state, body) {
  guard(state, 'write');
  const command = String(body.command || '').trim();
  if (!command) throw new ToolError('BAD_REQUEST', 'command is required');
  const purpose = ['setup', 'run', 'test'].includes(body.purpose) ? body.purpose : 'run';
  const timeoutSec = Math.min(CONFIG.runTimeoutSec, Math.max(5, Math.ceil(secondsLeft(state))));
  const started = Date.now();
  const res = await runProcess('bash', ['-lc', command], { cwd: workspaceOf(state), timeoutSec });
  const record = {
    command: truncate(command, 300),
    purpose,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    output: truncate(res.output, LIMITS.toolOutputChars, 0.8),
    at: Date.now(),
    durationMs: Date.now() - started,
  };
  let message = res.exitCode === 0 ? 'Command succeeded.' : 'Command failed. Read the output, find the cause, fix it, then run again.';
  if (res.timedOut) message = `Command timed out after ${timeoutSec}s. Avoid servers or watch modes; run tests in a single pass.`;
  if (purpose === 'setup') state.lastSetup = record;
  else state.lastRun = record;
  // The first failed command records the error. Every later failure counts as a repair
  // attempt, including commands labeled setup. A passing install does not count.
  if (res.exitCode !== 0) {
    if (state.failedRuns > 0) state.fixAttempts += 1;
    state.failedRuns += 1;
    if (state.fixAttempts >= CONFIG.maxFixAttempts) {
      state.limitReached = true;
      message = `Fix-attempt limit reached (${CONFIG.maxFixAttempts}). Do not change more code. Call finish with status FAILED.`;
    }
  }
  addLog(state, `run:${purpose}`, `exit ${res.exitCode}${res.timedOut ? ' (timeout)' : ''}: ${command}`);
  return {
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    purpose,
    durationMs: record.durationMs,
    output: record.output || '(no output)',
    message,
  };
}

async function collectDiff(state, maxPatch = 3000) {
  const ws = workspaceOf(state);
  await git(ws, ['add', '-A']);
  const stat = await git(ws, ['diff', '--cached', '--stat', state.baseCommit]);
  const names = await git(ws, ['diff', '--cached', '--name-status', state.baseCommit]);
  const patch = await git(ws, ['diff', '--cached', state.baseCommit]);
  return {
    stat: stat.output.trim() || '(no changes)',
    files: names.output.trim().split('\n').filter(Boolean),
    patch: truncate(patch.output, maxPatch, 0.3),
  };
}

async function toolDiff(state) {
  guard(state, 'read');
  const d = await collectDiff(state);
  addLog(state, 'diff', `${d.files.length} files changed`);
  return d;
}

async function toolUpdateState(state, body) {
  guard(state, 'read');
  const changed = [];
  for (const [key, field] of [['plan', 'plan'], ['notes', 'notes'], ['next_step', 'nextStep']]) {
    if (typeof body[key] === 'string' && body[key].trim()) {
      state[field] = truncate(body[key].trim(), LIMITS.stateFieldChars, 0.5);
      changed.push(key);
    }
  }
  addLog(state, 'update_state', changed.join(', ') || 'nothing');
  return { saved: changed, workingState: workingState(state) };
}

async function toolFinish(state, body) {
  guard(state, 'read');
  const status = String(body.status || '').toUpperCase();
  if (!['DONE', 'FAILED', 'BLOCKED'].includes(status)) throw new ToolError('BAD_REQUEST', 'status must be DONE, FAILED or BLOCKED');
  const summary = String(body.summary || '').trim();
  if (!summary) throw new ToolError('BAD_REQUEST', 'summary is required');
  if (status === 'DONE') {
    const last = state.lastRun;
    if (!last || last.purpose !== 'test') {
      throw new ToolError('NOT_VERIFIED', 'Cannot finish as DONE: no test run yet. Run the tests with run_command purpose=test first.');
    }
    if (last.exitCode !== 0) {
      throw new ToolError('NOT_VERIFIED', 'Cannot finish as DONE: the last test run failed. Fix it or finish as FAILED.');
    }
    if (state.lastWriteAt > last.at) {
      throw new ToolError('NOT_VERIFIED', 'Cannot finish as DONE: files changed after the last test run. Run the tests again.');
    }
    const evidence = explainTestEvidence(workspaceOf(state), last.command);
    if (evidence) throw new ToolError('NOT_VERIFIED', `Cannot finish as DONE: ${evidence}`);
  }
  const lessons = String(body.lessons || '')
    .split('\n')
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => truncate(l, 300, 0.2));
  state.final = {
    status,
    summary: truncate(summary, 2000, 0.3),
    lessons,
    testCommand: truncate(String(body.test_command || (state.lastRun && state.lastRun.command) || ''), 300),
  };
  state.status = status;
  state.stopReason = `Agent finished with status ${status}`;
  addLog(state, 'finish', `${status}: ${summary}`);
  return { accepted: true, status, message: 'Task closed. Reply with one short sentence and stop.' };
}

function buildReport(state, diff, wsTree) {
  const durationSec = Math.round((Date.now() - state.createdAt) / 1000);
  const final = state.final || {};
  const last = state.lastRun;
  const lines = [];
  lines.push('# Coding Agent Report', '');
  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Task ID | \`${state.taskId}\` |`);
  lines.push(`| Mode | ${state.mode} |`);
  if (state.repoUrl) lines.push(`| Repository | ${state.repoUrl} |`);
  lines.push(`| Status | **${state.status}** |`);
  lines.push(`| Stop reason | ${state.stopReason || '-'} |`);
  lines.push(`| Started | ${new Date(state.createdAt).toISOString()} |`);
  lines.push(`| Duration | ${durationSec}s (budget ${CONFIG.softDeadlineSec}s soft, 900s hard) |`);
  lines.push(`| Agent turns | ${state.turn} / ${CONFIG.maxTurns} |`);
  lines.push(`| Fix attempts | ${fixAttemptsUsed(state)} / ${CONFIG.maxFixAttempts} |`);
  lines.push('');
  lines.push('## Request', '', '```text', state.request, '```', '');
  lines.push('## Summary', '', final.summary || '_The agent did not call finish. See the stop reason and action log._', '');
  lines.push('## Plan', '', state.plan || '_No plan recorded._', '');
  if (state.notes) lines.push('## Working notes', '', state.notes, '');
  lines.push('## Verification', '');
  if (last) {
    lines.push(`- Command: \`${last.command}\``);
    lines.push(`- Purpose: ${last.purpose}`);
    lines.push(`- Exit code: ${last.exitCode}${last.timedOut ? ' (timed out)' : ''}`);
    lines.push('', '```text', truncate(last.output, 1500, 0.8) || '(no output)', '```', '');
  } else {
    lines.push('_No code was run._', '');
  }
  lines.push('## Files changed', '', '```text', diff.stat, '```', '');
  if (final.lessons && final.lessons.length) {
    lines.push('## Lessons saved to memory', '');
    for (const l of final.lessons) lines.push(`- ${l}`);
    lines.push('');
  }
  lines.push('## Action log', '');
  for (const l of state.log.slice(-40)) lines.push(`- \`${l.at.slice(11, 19)}\` **${l.tool}** ${l.info.replace(/\|/g, '/')}`);
  lines.push('');
  lines.push('## Workspace tree', '', '```text', wsTree, '```', '');
  lines.push('## Diff (truncated)', '', '```diff', diff.patch || '(none)', '```', '');
  return { markdown: lines.join('\n'), durationSec };
}

function tryResolve(req, body) {
  const explicit = (body && body.taskId) || req.headers['x-task-id'];
  // An error report with no task id belongs to the running task only.
  // A finished task must keep its own report.
  if (!explicit && body && (body.error || body.stopReason)) {
    const active = loadState(activeTaskId());
    if (active && active.status === 'running') return active;
    if (!active) return null;
    if (body.error) return null;
  }
  try {
    return resolveState(req, body);
  } catch (e) {
    return null;
  }
}

async function handleReport(req, body) {
  let state = tryResolve(req, body);
  if (!state) {
    const reason = body.error || body.stopReason;
    if (!reason) throw new ToolError('NO_TASK', 'No task found. Call /init first.');
    state = blankState({
      taskId: `err${Date.now().toString(36)}`,
      request: '(no workspace was created for this run)',
      chatId: body.chatId,
      project: 'general',
    });
    state.status = 'ERROR';
    state.stopReason = truncate(String(reason), 1500, 0.4);
    addLog(state, 'error', state.stopReason);
    saveState(state);
    return { ok: true, ...await writeReport(state) };
  }
  if (body.error && state.status === 'running') {
    state.status = 'ERROR';
    state.stopReason = truncate(`Workflow error: ${body.error}`, 1500, 0.4);
    addLog(state, 'error', body.error);
  } else if (body.stopReason && !state.stopReason) {
    state.stopReason = String(body.stopReason);
  }
  if (state.status === 'running') {
    state.status = 'STOPPED';
    state.stopReason = state.stopReason || 'Workflow ended without a final status.';
  }
  saveState(state);
  return { ok: true, ...await writeReport(state) };
}

async function handlePush(req, body) {
  const state = resolveState(req, body);
  const token = String(req.headers['x-git-token'] || '');
  if (!token) throw new ToolError('NO_TOKEN', 'Missing X-Git-Token header.');
  if (state.status !== 'DONE') throw new ToolError('NOT_DONE', `Only DONE tasks can be pushed (status ${state.status}).`);
  const target = state.repoUrl || CONFIG.defaultPushRepo;
  const m = GITHUB_URL.exec(target);
  if (!m) throw new ToolError('BAD_REPO', 'No valid push target repository configured.');
  const ws = workspaceOf(state);
  const branch = `agent/${state.taskId}`;
  await git(ws, ['add', '-A']);
  const commit = await git(ws, ['commit', '-q', '-m', `agent(${state.taskId}): ${(state.final.summary || 'changes').split('\n')[0].slice(0, 120)}`]);
  if (commit.exitCode !== 0 && !/nothing to commit/.test(commit.output)) throw new ToolError('COMMIT_FAILED', truncate(commit.output, 1000));
  const remote = `https://x-access-token:${token}@github.com/${m[1]}/${m[2]}.git`;
  const push = await git(ws, ['-c', 'credential.helper=', 'push', remote, `HEAD:refs/heads/${branch}`], 120);
  const output = push.output.split(token).join('***');
  addLog(state, 'push', `exit ${push.exitCode} -> ${m[1]}/${m[2]} ${branch}`);
  saveState(state);
  if (push.exitCode !== 0) throw new ToolError('PUSH_FAILED', truncate(output, 1500));
  return { ok: true, pushed: true, branch, url: `https://github.com/${m[1]}/${m[2]}/tree/${branch}`, output: truncate(output, 800) };
}

function handleState(req, url) {
  const taskId = url.searchParams.get('taskId') || req.headers['x-task-id'] || activeTaskId();
  const state = loadState(taskId);
  if (!state) throw new ToolError('NO_TASK', 'No task found.');
  return { ok: true, ...state, log: state.log.slice(-30), budget: budget(state) };
}

const TOOLS = {
  list_files: toolListFiles,
  read_file: toolReadFile,
  search: toolSearch,
  write_file: toolWriteFile,
  run: toolRun,
  diff: toolDiff,
  update_state: toolUpdateState,
  finish: toolFinish,
};

// ---------- http ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyMaxBytes) {
        reject(new ToolError('TOO_LARGE', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new ToolError('BAD_JSON', 'Body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://sandbox');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, activeTask: activeTaskId() });
    if (process.env.ALLOW_SHUTDOWN === '1' && req.method === 'POST' && url.pathname === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, handleState(req, url));
    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'NOT_FOUND' });

    const body = await readBody(req);
    if (url.pathname === '/init') return send(res, 200, await handleInit(body));
    if (url.pathname === '/turn') return send(res, 200, handleTurn(req, body));
    if (url.pathname === '/report') return send(res, 200, await handleReport(req, body));
    if (url.pathname === '/push') return send(res, 200, await handlePush(req, body));

    const toolMatch = /^\/tools\/([a-z_]+)$/.exec(url.pathname);
    if (toolMatch && TOOLS[toolMatch[1]]) {
      const state = resolveState(req, body);
      let result;
      try {
        result = await TOOLS[toolMatch[1]](state, body);
      } finally {
        saveState(state);
      }
      return send(res, 200, { ok: true, ...result, budget: budget(state) });
    }
    return send(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (err) {
    if (err instanceof ToolError) {
      // Expected errors return 200 so the agent (or workflow) reads the message instead of the HTTP node throwing.
      return send(res, 200, { ok: false, error: err.code, message: err.message });
    }
    console.error(err);
    return send(res, 500, { ok: false, error: 'INTERNAL', message: err.message });
  }
});

if (require.main === module) {
  server.listen(CONFIG.port, () => {
    console.log(`sandbox listening on ${CONFIG.port} (drop privileges: ${dropPrivileges})`);
  });
}

module.exports = { server, CONFIG };
