'use strict';
// Static checks for the generated workflows + runs every Code node against real sandbox responses.
// Usage: node setup/validate_workflows.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawn } = require('child_process');

const dir = path.join(__dirname, '..', 'workflows');
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const main = load('coding-agent.json');
const ask = load('ask-human.json');
const err = load('error-report.json');

function checkGraph(wf) {
  const names = new Set(wf.nodes.map((n) => n.name));
  assert.strictEqual(names.size, wf.nodes.length, `${wf.name}: duplicate node names`);
  const ids = new Set(wf.nodes.map((n) => n.id));
  assert.strictEqual(ids.size, wf.nodes.length, `${wf.name}: duplicate node ids`);
  const reached = new Set();
  for (const [src, kinds] of Object.entries(wf.connections)) {
    assert.ok(names.has(src), `${wf.name}: unknown source ${src}`);
    for (const outputs of Object.values(kinds)) {
      for (const out of outputs) for (const c of out) {
        assert.ok(names.has(c.node), `${wf.name}: ${src} -> unknown ${c.node}`);
        reached.add(c.node);
        reached.add(src);
      }
    }
  }
  for (const n of wf.nodes) assert.ok(reached.has(n.name), `${wf.name}: node "${n.name}" is not connected`);
  // every $('Node') reference must exist
  const text = JSON.stringify(wf);
  for (const m of text.matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) assert.ok(names.has(m[1]), `${wf.name}: reference to missing node ${m[1]}`);
  console.log(`ok - ${wf.name}: ${wf.nodes.length} nodes, graph and references valid`);
}

[main, ask, err].forEach(checkGraph);

const byName = Object.fromEntries(main.nodes.map((n) => [n.name, n]));
const toolsOf = (agent) => Object.entries(main.connections)
  .filter(([, k]) => (k.ai_tool || []).some((o) => o.some((c) => c.node === agent)))
  .map(([src]) => src)
  .sort();
assert.deepStrictEqual(toolsOf('Coding Agent'), ['ask_human', 'code_reviewer', 'finish', 'list_files', 'read_file', 'run_command', 'search_code', 'show_diff', 'update_state', 'write_file']);
assert.deepStrictEqual(toolsOf('code_reviewer'), ['list_files', 'read_file', 'search_code', 'show_diff'], 'reviewer must be read-only');
assert.strictEqual(main.settings.errorWorkflow, err.id);
assert.strictEqual(main.settings.executionTimeout, 900);
assert.strictEqual(byName.ask_human.parameters.workflowId.value, ask.id);
const model = byName['GPT-4o (GitHub Models)'];
assert.strictEqual(model.parameters.model.value, 'openai/gpt-4o');
assert.strictEqual(model.parameters.responsesApiEnabled, false, 'GitHub Models has no Responses API');
for (const n of [...main.nodes, ...ask.nodes, ...err.nodes]) {
  if (n.type === 'n8n-nodes-base.telegram' && !n.parameters.operation) {
    assert.strictEqual(n.parameters.additionalFields.parse_mode, 'HTML', `${n.name} must use HTML parse mode`);
  }
}
console.log('ok - tools, sub-agent wiring, model and settings');

// ---------- run Code nodes ----------

function runCode(jsCode, { json, items, nodes }) {
  const $ = (name) => {
    assert.ok(nodes[name], `code referenced ${name} without mock`);
    return { first: () => ({ json: nodes[name] }), item: { json: nodes[name] } };
  };
  const $input = { all: () => (items || [{ json }]).map((j) => (j.json ? j : { json: j })) };
  return vm.runInNewContext(`(function(){\n${jsCode}\n})()`, { $json: json, $, $input }, { timeout: 1000 });
}

async function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-validate-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'sandbox', 'server.js')], {
    env: { ...process.env, PORT: '18090', WORKSPACES_DIR: path.join(root, 'ws'), DATA_DIR: path.join(root, 'data'), ALLOW_SHUTDOWN: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.on('error', () => {});
  await new Promise((r) => child.stdout.once('data', r));
  const post = async (p, body) => (await fetch(`http://127.0.0.1:18090${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    await fn(post);
  } finally {
    try {
      await fetch('http://127.0.0.1:18090/shutdown', { method: 'POST' });
    } catch (e) {
      // The process may already be gone.
    }
    child.on('error', () => {});
    try {
      child.kill();
    } catch (e) {
      // See sandbox/test.js: cleanup must not fail the run.
    }
    if (child.stdout) child.stdout.destroy();
    if (child.stderr) child.stderr.destroy();
    child.unref();
  }
}

(async () => {
  const parseJs = byName['Parse request'].parameters.jsCode;
  let out = runCode(parseJs, { json: { message: { chat: { id: 42 }, text: 'In https://github.com/ghafooridev/n8n_test_code. add multiply to helper.js' } } });
  assert.strictEqual(out[0].json.repoUrl, 'https://github.com/ghafooridev/n8n_test_code');
  assert.strictEqual(out[0].json.mode, 'existing-codebase');
  assert.strictEqual(out[0].json.chatId, '42');
  assert.strictEqual(out[0].json.isTask, true);
  const parsedNew = runCode(parseJs, { json: { message: { chat: { id: 42 }, text: 'Build a todo CLI in Node with tests' } } })[0].json;
  assert.strictEqual(parsedNew.mode, 'new-project');
  assert.strictEqual(parsedNew.project, 'general');
  assert.strictEqual(runCode(parseJs, { json: { message: { chat: { id: 1 }, text: '/start' } } })[0].json.isTask, false);
  console.log('ok - Parse request');

  const pickJs = byName['Pick memory'].parameters.jsCode;
  out = runCode(pickJs, { items: [{}], nodes: { 'Parse request': parsedNew } });
  assert.strictEqual(out[0].json.memoryText, '(no memory yet)');
  out = runCode(pickJs, {
    items: Array.from({ length: 12 }, (_, i) => ({ id: 12 - i, project: 'general', kind: 'lesson', note: `lesson ${i}` })),
    nodes: { 'Parse request': parsedNew },
  });
  assert.strictEqual(out[0].json.memoryCount, 8, 'memory is capped');
  out = runCode(pickJs, {
    items: [
      { id: 3, project: 'general', kind: 'lesson', note: 'x'.repeat(800) },
      { id: 2, project: 'general', kind: 'lesson', note: 'y'.repeat(800) },
      { id: 1, project: 'general', kind: 'lesson', note: 'z'.repeat(800) },
    ],
    nodes: { 'Parse request': parsedNew },
  });
  assert.ok(out[0].json.memoryText.length <= 1200, `memory text is ${out[0].json.memoryText.length} chars`);
  assert.ok(out[0].json.memoryCount < 3, 'long notes stop before the character cap');
  console.log('ok - Pick memory (empty + capped at 8 notes and 1200 chars)');

  await withSandbox(async (post) => {
    const init = await post('/init', { taskId: parsedNew.taskId, request: parsedNew.text, chatId: parsedNew.chatId, project: 'general' });
    assert.strictEqual(init.ok, true);
    const turn = await post('/turn', { taskId: parsedNew.taskId, agentOutput: '', agentError: '' });
    const prompt = runCode(byName['Build prompt'].parameters.jsCode, {
      json: turn,
      nodes: { 'Parse request': parsedNew, 'Init workspace': init, 'Pick memory': { memoryText: '- [general, lesson] use node --test' } },
    })[0].json.prompt;
    assert.ok(prompt.includes('TASK FROM THE USER:\nBuild a todo CLI'));
    assert.ok(prompt.includes('WORKSPACE AT START'));
    assert.ok(prompt.includes('use node --test'));
    assert.ok(prompt.includes('BUDGET: turn 1/10'));
    assert.ok(prompt.length < 3000, `first-turn prompt is small (${prompt.length} chars)`);
    console.log(`ok - Build prompt (turn 1, ${prompt.length} chars)\n---\n${prompt}\n---`);

    await post('/tools/write_file', { path: 'test/app.test.js', content: "console.log('pass');\n" });
    const ran = await post('/tools/run', { command: 'node test/app.test.js', purpose: 'test' });
    assert.strictEqual(ran.exitCode, 0, ran.output || ran.message);
    const finished = await post('/tools/finish', { status: 'DONE', summary: 'Tests passed.', lessons: 'node test/app.test.js is the project test command' });
    assert.strictEqual(finished.ok, true, JSON.stringify(finished));
    const t2 = await post('/turn', { taskId: parsedNew.taskId, agentOutput: 'done' });
    assert.strictEqual(t2.stop, true);
    const report = await post('/report', { taskId: parsedNew.taskId, stopReason: t2.reason });
    const rows = runCode(byName['Memory rows'].parameters.jsCode, { json: report }).map((r) => r.json);
    assert.deepStrictEqual(rows.map((r) => r.kind), ['lesson', 'task']);
    assert.ok(rows.every((r) => r.project === 'general' && r.task_id === parsedNew.taskId));
    assert.ok(!/[<>&]/.test(report.caption), 'caption is safe for Telegram HTML');
    console.log('ok - Memory rows from a real report');
  });

  console.log('\nall workflow checks passed');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
}).finally(() => {
  process.exit(process.exitCode || 0);
});
