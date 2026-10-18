'use strict';
// Integration tests for the sandbox API. Usage: node test.js [--network]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const withNetwork = process.argv.includes('--network');
const servers = [];
let passed = 0;

async function startServer(port, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      WORKSPACES_DIR: path.join(root, 'ws'),
      DATA_DIR: path.join(root, 'data'),
      RUN_TIMEOUT_SEC: '3',
      MAX_FIX_ATTEMPTS: '5',
      MAX_TURNS: '3',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  servers.push(child);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body = {}, headers = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return r.json();
  };
  const get = async (p) => (await fetch(base + p)).json();
  return { post, get, root };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const s = await startServer(18080);

  await test('health', async () => {
    const h = await s.get('/health');
    assert.strictEqual(h.ok, true);
  });

  let taskId;
  await test('init new project', async () => {
    const r = await s.post('/init', { request: 'Build a sum function with tests', chatId: 123 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.mode, 'new-project');
    assert.ok(r.hints.includes('empty workspace'));
    taskId = r.taskId;
  });

  await test('init rejects non-github repo', async () => {
    const r = await s.post('/init', { request: 'x', repoUrl: 'https://evil.example.com/a/b' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'BAD_REPO');
  });

  await test('path traversal and .git are blocked', async () => {
    let r = await s.post('/tools/read_file', { path: '../../etc/passwd' });
    assert.strictEqual(r.error, 'BAD_PATH');
    r = await s.post('/tools/write_file', { path: '.git/config', content: 'x' });
    assert.strictEqual(r.error, 'BAD_PATH');
    r = await s.post('/tools/read_file', { path: '/etc/passwd' });
    assert.strictEqual(r.error, 'NOT_FOUND', 'absolute paths are treated as workspace-relative');
  });

  await test('symlink escape is blocked', async () => {
    const ws = path.join(s.root, 'ws', taskId);
    fs.symlinkSync('/etc', path.join(ws, 'link'));
    const r = await s.post('/tools/read_file', { path: 'link/passwd' });
    assert.strictEqual(r.error, 'BAD_PATH');
    fs.unlinkSync(path.join(ws, 'link'));
  });

  await test('turn 1 starts with empty working state', async () => {
    const r = await s.post('/turn', {});
    assert.strictEqual(r.stop, false);
    assert.strictEqual(r.budget.turn, 1);
    assert.strictEqual(r.workingState.plan, '(no plan yet)');
  });

  await test('write, read, list, search', async () => {
    let r = await s.post('/tools/write_file', { path: 'src/sum.js', content: 'module.exports = (a, b) => a - b;\n' });
    assert.strictEqual(r.action, 'created');
    r = await s.post('/tools/write_file', {
      path: 'test/sum.test.js',
      content: "const sum = require('../src/sum');\nif (sum(2, 3) !== 5) { console.error('expected 5 got ' + sum(2, 3)); process.exit(1); }\nconsole.log('pass');\n",
    });
    r = await s.post('/tools/read_file', { path: 'src/sum.js' });
    assert.ok(r.content.startsWith('1| module.exports'));
    r = await s.post('/tools/list_files', {});
    assert.ok(r.entries.includes('src/sum.js'));
    r = await s.post('/tools/search', { pattern: 'module\\.exports' });
    assert.ok(r.matches.includes('src/sum.js:1:'), r.matches);
  });

  await test('finish DONE is refused without a passing test', async () => {
    const r = await s.post('/tools/finish', { status: 'DONE', summary: 'done' });
    assert.strictEqual(r.error, 'NOT_VERIFIED');
  });

  await test('failing test is recorded, setup failures are not counted', async () => {
    let r = await s.post('/tools/run', { command: 'exit 3', purpose: 'setup' });
    assert.strictEqual(r.exitCode, 3);
    assert.strictEqual(r.budget.fixAttemptsUsed, 0);
    r = await s.post('/tools/run', { command: 'node test/sum.test.js', purpose: 'test' });
    assert.strictEqual(r.exitCode, 1);
    assert.ok(r.output.includes('expected 5 got -1'));
    assert.strictEqual(r.budget.fixAttemptsUsed, 0);
  });

  await test('fix then passing test allows DONE; writes after test force a re-run', async () => {
    await s.post('/tools/write_file', { path: 'src/sum.js', content: 'module.exports = (a, b) => a + b;\n' });
    let r = await s.post('/tools/run', { command: 'node test/sum.test.js', purpose: 'test' });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.budget.fixAttemptsUsed, 1, 'the successful re-run after a failure is a fix attempt');
    await s.post('/tools/write_file', { path: 'README.md', content: '# sum\n' });
    r = await s.post('/tools/finish', { status: 'DONE', summary: 'x' });
    assert.strictEqual(r.error, 'NOT_VERIFIED');
    r = await s.post('/tools/run', { command: 'node test/sum.test.js', purpose: 'test' });
    await s.post('/tools/update_state', { plan: '1. write sum 2. test', notes: 'uses plain node asserts' });
    r = await s.post('/tools/finish', { status: 'DONE', summary: 'Added sum with a test.', lessons: '- plain node test works\n- run node test/sum.test.js' });
    assert.strictEqual(r.accepted, true, JSON.stringify(r));
  });

  await test('tools refuse work after finish; turn stops', async () => {
    let r = await s.post('/tools/write_file', { path: 'x.js', content: '' });
    assert.strictEqual(r.error, 'TASK_FINISHED');
    r = await s.post('/turn', { agentOutput: 'finished' });
    assert.strictEqual(r.stop, true);
    assert.strictEqual(r.status, 'DONE');
  });

  await test('report has markdown, changes, lessons', async () => {
    const r = await s.post('/report', {});
    assert.strictEqual(r.status, 'DONE');
    assert.strictEqual(r.hasChanges, true);
    assert.strictEqual(r.canPush, true);
    assert.deepStrictEqual(r.lessons, ['plain node test works', 'run node test/sum.test.js']);
    assert.ok(r.markdown.includes('# Coding Agent Report'));
    assert.ok(r.markdown.includes('src/sum.js'));
    assert.ok(fs.existsSync(path.join(s.root, 'ws', taskId, '.agent', 'REPORT.md')));
    assert.ok(!r.filesChanged.some((f) => f.includes('.agent')), 'report folder is git-excluded');
  });

  await test('push requires a token', async () => {
    const r = await s.post('/push', {});
    assert.strictEqual(r.error, 'NO_TOKEN');
  });

  await test('fix-attempt limit: 6th failed run sets LIMIT_REACHED', async () => {
    await s.post('/init', { request: 'limit test' });
    let r;
    for (let i = 1; i <= 6; i += 1) {
      r = await s.post('/tools/run', { command: 'echo fail; exit 1', purpose: 'test' });
    }
    assert.strictEqual(r.budget.limitReached, true);
    assert.strictEqual(r.budget.fixAttemptsUsed, 5);
    assert.ok(r.message.includes('limit reached'));
    r = await s.post('/tools/write_file', { path: 'a.js', content: '' });
    assert.strictEqual(r.error, 'LIMIT_REACHED');
    r = await s.post('/turn', {});
    assert.strictEqual(r.stop, true);
    assert.strictEqual(r.status, 'LIMIT_REACHED');
    r = await s.post('/report', {});
    assert.ok(r.markdown.includes('Fix attempts | 5 / 5'));
  });

  await test('command timeout kills the process', async () => {
    await s.post('/init', { request: 'timeout test' });
    const started = Date.now();
    const r = await s.post('/tools/run', { command: 'sleep 30', purpose: 'run' });
    assert.strictEqual(r.timedOut, true);
    assert.ok(Date.now() - started < 10000);
  });

  await test('max turns stops the loop', async () => {
    await s.post('/init', { request: 'turns test' });
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await s.post('/turn', {})).stop, false);
    const r = await s.post('/turn', {});
    assert.strictEqual(r.stop, true);
    assert.strictEqual(r.status, 'MAX_TURNS');
  });

  await test('error report closes a running task', async () => {
    await s.post('/init', { request: 'error test', chatId: 55 });
    const r = await s.post('/report', { error: 'Execution timed out' });
    assert.strictEqual(r.status, 'ERROR');
    assert.strictEqual(r.chatId, '55');
    assert.ok(r.markdown.includes('Execution timed out'));
  });

  const d = await startServer(18081, { SOFT_DEADLINE_SEC: '1' });
  await test('deadline blocks writes and stops the turn loop', async () => {
    await d.post('/init', { request: 'deadline test' });
    await new Promise((r) => setTimeout(r, 1500));
    let r = await d.post('/tools/write_file', { path: 'a.js', content: '' });
    assert.strictEqual(r.error, 'DEADLINE');
    r = await d.post('/tools/finish', { status: 'FAILED', summary: 'ran out of time' });
    assert.strictEqual(r.accepted, true);
    r = await d.post('/turn', {});
    assert.strictEqual(r.stop, true);
  });

  if (withNetwork) {
    await test('init clones an existing GitHub repo', async () => {
      const r = await s.post('/init', { request: 'inspect repo', repoUrl: 'https://github.com/ghafooridev/n8n_test_code' });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.mode, 'existing-codebase');
      assert.ok(r.tree.length > 0);
      console.log(r.tree);
    });
  }

  console.log(`\n${passed} tests passed`);
}

main()
  .catch((err) => {
    console.error('FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => servers.forEach((c) => c.kill()));
