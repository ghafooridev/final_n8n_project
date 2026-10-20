"""Builds the n8n workflow JSON files in ../workflows.

Run: python3 setup/build_workflows.py
Edit prompts and Code-node JavaScript here, not in the generated JSON.
"""
import json
import os
from pathlib import Path

# The overrides exist for the offline end-to-end test (mock model, local sandbox).
OUT = Path(os.environ.get("WORKFLOWS_OUT", Path(__file__).resolve().parent.parent / "workflows"))
SANDBOX = os.environ.get("SANDBOX_URL", "http://sandbox:8080")
MODEL_BASE_URL = os.environ.get("MODEL_BASE_URL", "https://models.github.ai/inference")

MAIN_ID = "CodeAgentMain001"
ASK_ID = "CodeAgentAskHum1"
ERR_ID = "CodeAgentErrRep1"

TELEGRAM = {"telegramApi": {"id": "CredTelegram0001", "name": "Telegram bot"}}
MODELS = {"openAiApi": {"id": "CredGhModels0001", "name": "GitHub Models (gpt-4o)"}}
PUSH = {"httpHeaderAuth": {"id": "CredGitPush00001", "name": "GitHub push token"}}


def node(name, type_, version, params, pos, **extra):
    n = {
        "parameters": params,
        "id": "n-" + "".join(c if c.isalnum() else "-" for c in name.lower()),
        "name": name,
        "type": type_,
        "typeVersion": version,
        "position": pos,
    }
    n.update(extra)
    return n


def code(name, js, pos, **extra):
    return node(name, "n8n-nodes-base.code", 2, {"jsCode": js.strip()}, pos, **extra)


def if_node(name, left, operator, pos, right=None):
    cond = {"id": name + "-c", "leftValue": left, "operator": operator}
    if right is not None:
        cond["rightValue"] = right
    return node(
        name,
        "n8n-nodes-base.if",
        2.3,
        {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 3},
                "conditions": [cond],
                "combinator": "and",
            },
            "looseTypeValidation": True,
            "options": {},
        },
        pos,
    )


IS_TRUE = {"type": "boolean", "operation": "true", "singleValue": True}


def http_post(name, path, body_expr, pos, **extra):
    return node(
        name,
        "n8n-nodes-base.httpRequest",
        4.2,
        {
            "method": "POST",
            "url": SANDBOX + path,
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": body_expr,
            "options": {"timeout": 180000},
        },
        pos,
        **extra,
    )


def telegram_text(name, chat_expr, text_expr, pos):
    return node(
        name,
        "n8n-nodes-base.telegram",
        1.2,
        {"chatId": chat_expr, "text": text_expr, "additionalFields": {"appendAttribution": False, "parse_mode": "HTML"}},
        pos,
        webhookId="wh-" + name.lower().replace(" ", "-"),
        credentials=TELEGRAM,
    )


def sandbox_tool(name, endpoint, description, params, pos):
    """HTTP Request tool that the agent calls. params: list of (name, $fromAI expression)."""
    return node(
        name,
        "n8n-nodes-base.httpRequestTool",
        4.2,
        {
            "toolDescription": description,
            "method": "POST",
            "url": f"{SANDBOX}/tools/{endpoint}",
            "sendBody": True,
            "specifyBody": "keypair",
            "bodyParameters": {"parameters": [{"name": k, "value": v} for k, v in params]},
            "options": {"timeout": 150000},
        },
        pos,
    )


def from_ai(key, desc, type_="string", default=None):
    desc = desc.replace("'", "\\'")
    if default is None:
        return f"={{{{ $fromAI('{key}', '{desc}', '{type_}') }}}}"
    d = json.dumps(default) if not isinstance(default, str) else "'" + default + "'"
    return f"={{{{ $fromAI('{key}', '{desc}', '{type_}', {d}) }}}}"


def data_table(name, table, params, pos, **extra):
    p = {"resource": "row", "dataTableId": {"__rl": True, "mode": "name", "value": table}}
    p.update(params)
    return node(name, "n8n-nodes-base.dataTable", 1.1, p, pos, **extra)


def connect(conns, src, dst, out=0, inp=0, kind="main"):
    outputs = conns.setdefault(src, {}).setdefault(kind, [])
    while len(outputs) <= out:
        outputs.append([])
    outputs[out].append({"node": dst, "type": kind, "index": inp})


def workflow(name, wid, nodes, conns, settings):
    return {
        "id": wid,
        "name": name,
        "nodes": nodes,
        "connections": conns,
        "active": False,
        "settings": settings,
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": True},
        "tags": [],
    }


# ---------------------------------------------------------------- prompts

AGENT_SYSTEM = """You are a senior software engineer working as an autonomous coding agent inside an isolated Docker sandbox (Node 20, Python 3 with pytest, git, internet for npm/pip).

You work in short TURNS. Each turn you receive: the task, memory from earlier runs, your budget, your saved state and the last test result. Messages from earlier turns are NOT shown again, so save anything important with update_state before the turn ends.

How to work:
1. Understand the task. Only if it is truly ambiguous, or needs a decision only the user can make, call ask_human once with one short, specific question. Otherwise decide yourself and note the assumption.
2. Explore only what you need: list_files with a small depth, search_code to locate code, then read_file on specific line ranges. Never dump whole folders or huge files.
3. Plan: call update_state with a short numbered plan and the test command before writing code.
4. Implement with write_file (always the FULL file content). In an existing codebase keep changes minimal and follow its style and test setup.
5. Verify for real with run_command. purpose=setup for installs (npm install, pip install), purpose=test for tests. Commands must exit on their own: no servers, no watch mode. New projects must include automated tests and a single test command (npm test or python -m pytest -q).
6. If tests fail: read the output, find the root cause, fix it, run again. You have at most 5 failed repair attempts for the whole task. The first failure is free. Every later failed command counts, including ones labeled setup. A passing install does not count.
7. For non-trivial changes call code_reviewer once before finishing. Fix real issues it reports, then run the tests again.
8. Call finish exactly once. DONE only when the latest test run passed after your last edit and really executed the project's tests (npm test, pytest, node --test, or a test file). The sandbox rejects DONE for a bare "true" or "echo". FAILED if you cannot make it work or a limit is reached. BLOCKED if you need the human and got no answer. The summary must say what changed, which files, and how it was verified. lessons: 1 to 3 short lines useful for future tasks on this project (test command, framework, pitfalls).

Rules:
- About every 5 tool calls, and always before you stop, call update_state with notes (what is done, key facts) and next_step.
- If a tool returns ok:false, read its message and adapt. Never claim you ran or tested something you did not.
- Keep tool inputs small. Do not paste large outputs back into notes."""

REVIEWER_SYSTEM = """You are a strict code reviewer sub-agent. You only have read-only tools.
Call show_diff first, then read only the files you need.
Check: bugs, unhandled edge cases, missing or weak tests, and whether the change really does what was asked.
Reply in plain text, at most 150 words:
VERDICT: PASS or VERDICT: CHANGES_NEEDED
then up to 5 concrete issues, each with file and line and the fix."""

# ---------------------------------------------------------------- code nodes

PARSE_REQUEST_JS = r"""
const msg = $json.message || {};
const text = String(msg.text || '').trim();
const chatId = msg.chat ? String(msg.chat.id) : '';
const match = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
const repoUrl = match ? match[0].replace(/\.git$/, '').replace(/\.$/, '') : '';
const isCommand = text === '' || text.startsWith('/start') || text.startsWith('/help');
return [{
  json: {
    chatId,
    text,
    repoUrl,
    mode: repoUrl ? 'existing-codebase' : 'new-project',
    project: repoUrl || 'general',
    taskId: 't' + Date.now().toString(36),
    isTask: !isCommand,
  },
}];
"""

PICK_MEMORY_JS = r"""
const project = $('Parse request').first().json.project;
const rows = $input.all().map((i) => i.json).filter((r) => r && r.note);
const lines = [];
let size = 0;
for (const r of rows) {
  const scope = r.project === project && project !== 'general' ? 'this repo' : 'general';
  const line = `- [${scope}, ${r.kind || 'note'}] ${r.note}`;
  if (size + line.length > 1200 || lines.length >= 8) break;
  lines.push(line);
  size += line.length;
}
return [{ json: { memoryText: lines.join('\n') || '(no memory yet)', memoryCount: lines.length } }];
"""

BUILD_PROMPT_JS = r"""
const t = $json;
const req = $('Parse request').first().json;
const init = $('Init workspace').first().json;
const memory = $('Pick memory').first().json.memoryText;
const ws = t.workingState || {};
const b = t.budget || {};
const last = ws.lastRun;
const lastRun = last
  ? `command: ${last.command} (purpose ${last.purpose})\nexit code: ${last.exitCode}${last.timedOut ? ' (timed out)' : ''}\noutput tail:\n${last.outputTail}`
  : '(nothing run yet)';
const parts = [
  `TASK FROM THE USER:\n${req.text}`,
  `MODE: ${t.mode}` + (req.repoUrl ? ` (repo cloned from ${req.repoUrl})` : ' (empty workspace: create the project from scratch)'),
];
if (b.turn === 1) parts.push(`WORKSPACE AT START:\n${init.tree}\nHINTS: ${(init.hints || []).join('; ')}`);
parts.push(
  `MEMORY FROM EARLIER RUNS:\n${memory}`,
  `BUDGET: turn ${b.turn}/${b.maxTurns}, ${b.secondsLeft}s left, fix attempts used ${b.fixAttemptsUsed}/${b.fixAttemptsUsed + b.fixAttemptsLeft}`,
  `YOUR SAVED STATE:\nplan: ${ws.plan}\nnotes: ${ws.notes}\nnext step: ${ws.nextStep}\nfiles written: ${(ws.filesWritten || []).join(', ') || 'none'}`,
  `LAST VERIFICATION RUN:\n${lastRun}`,
  `RECENT ACTIONS:\n${(t.recentActions || []).join('\n') || '(none)'}`,
  b.turn === 1
    ? 'Start now: explore what you need, then save a plan with update_state.'
    : 'Continue from your saved state. Do not redo finished steps.'
);
return [{ json: { prompt: parts.join('\n\n'), taskId: t.taskId } }];
"""

LESSON_ROWS_JS = r"""
const r = $json;
const rows = (r.lessons || []).map((note) => ({ project: r.project, kind: 'lesson', note, task_id: r.taskId }));
const summary = String(r.summary || r.stopReason || '').split('\n')[0].slice(0, 280);
rows.push({ project: r.project, kind: 'task', note: `Task ${r.taskId} ended ${r.status}: ${summary}`, task_id: r.taskId });
return rows.map((json) => ({ json }));
"""

NEXT_TURN_BODY = (
    "={{ JSON.stringify({ taskId: $('Parse request').first().json.taskId, "
    "agentOutput: String($json.output || '').slice(0, 400), "
    "agentError: $json.error ? String($json.error.message || $json.error).slice(0, 400) : '' }) }}"
)


# ---------------------------------------------------------------- main workflow

def build_main():
    nodes, c = [], {}
    nodes += [
        node(
            "Telegram Trigger",
            "n8n-nodes-base.telegramTrigger",
            1.2,
            {"updates": ["message"], "additionalFields": {}},
            [-1600, 300],
            webhookId="coding-agent-telegram-trigger",
            credentials=TELEGRAM,
        ),
        code("Parse request", PARSE_REQUEST_JS, [-1380, 300]),
        if_node("Is a task?", "={{ $json.isTask }}", IS_TRUE, [-1160, 300]),
        telegram_text(
            "Send help",
            "={{ $json.chatId }}",
            "Send me a coding task.\n\nNew project: describe what to build, e.g. Build a Node CLI that converts Celsius to Fahrenheit, with tests.\n\nExisting code: include a GitHub URL, e.g. https://github.com/ghafooridev/n8n_test_code add a multiply function to helper.js with tests.",
            [-940, 500],
        ),
        http_post(
            "Init workspace",
            "/init",
            "={{ JSON.stringify({ taskId: $json.taskId, request: $json.text, repoUrl: $json.repoUrl, chatId: $json.chatId, project: $json.project }) }}",
            [-940, 200],
        ),
        if_node("Init ok?", "={{ $json.ok }}", IS_TRUE, [-720, 200]),
        if_node("Has init report?", "={{ !!$json.markdown }}", IS_TRUE, [-500, 520]),
        node(
            "Init failure file",
            "n8n-nodes-base.convertToFile",
            1.1,
            {
                "operation": "toText",
                "sourceProperty": "markdown",
                "binaryPropertyName": "data",
                "options": {"fileName": "={{ 'REPORT-' + $json.taskId + '.md' }}"},
            },
            [-260, 640],
        ),
        node(
            "Send init report",
            "n8n-nodes-base.telegram",
            1.2,
            {
                "operation": "sendDocument",
                "chatId": "={{ $('Init workspace').first().json.chatId }}",
                "binaryData": True,
                "binaryPropertyName": "data",
                "additionalFields": {
                    "caption": "={{ $('Init workspace').first().json.caption }}",
                    "parse_mode": "HTML",
                },
            },
            [-20, 640],
            webhookId="wh-send-init-report",
            credentials=TELEGRAM,
        ),
        telegram_text(
            "Send init error",
            "={{ $('Parse request').first().json.chatId }}",
            "=Could not prepare the sandbox: {{ $json.message }}",
            [-260, 420],
        ),
        telegram_text(
            "Send started",
            "={{ $('Parse request').first().json.chatId }}",
            "=Task {{ $json.taskId }} started ({{ $json.mode }}).\nLimits: 5 fix attempts, 15 minutes. I will send REPORT.md when it ends.",
            [-500, 0],
        ),
        node(
            "Run row",
            "n8n-nodes-base.set",
            3.4,
            {
                "assignments": {
                    "assignments": [
                        {"id": "r1", "name": "task_id", "value": "={{ $json.taskId }}", "type": "string"},
                        {"id": "r2", "name": "execution_id", "value": "={{ $execution.id }}", "type": "string"},
                        {"id": "r3", "name": "chat_id", "value": "={{ $('Parse request').first().json.chatId }}", "type": "string"},
                        {"id": "r4", "name": "request", "value": "={{ $('Parse request').first().json.text }}", "type": "string"},
                        {"id": "r5", "name": "mode", "value": "={{ $json.mode }}", "type": "string"},
                        {"id": "r6", "name": "status", "value": "running", "type": "string"},
                    ]
                },
                "options": {},
            },
            [-500, 200],
        ),
        data_table(
            "Save run start",
            "runs",
            {"operation": "insert", "columns": {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [], "schema": []}, "options": {}},
            [-280, 200],
        ),
        data_table(
            "Load memory",
            "agent_memory",
            {
                "operation": "get",
                "matchType": "anyCondition",
                "filters": {
                    "conditions": [
                        {"keyName": "project", "condition": "eq", "keyValue": "={{ $('Parse request').first().json.project }}"},
                        {"keyName": "project", "condition": "eq", "keyValue": "general"},
                    ]
                },
                "limit": 30,
                "orderBy": True,
                "orderByColumn": "id",
                "orderByDirection": "DESC",
            },
            [-60, 200],
            alwaysOutputData=True,
        ),
        code("Pick memory", PICK_MEMORY_JS, [160, 200]),
        http_post("Next turn", "/turn", NEXT_TURN_BODY, [380, 200]),
        if_node("Stop?", "={{ $json.stop }}", IS_TRUE, [600, 200]),
        code("Build prompt", BUILD_PROMPT_JS, [820, 300]),
        node(
            "Coding Agent",
            "@n8n/n8n-nodes-langchain.agent",
            3.1,
            {
                "promptType": "define",
                "text": "={{ $json.prompt }}",
                "options": {"systemMessage": AGENT_SYSTEM, "maxIterations": 8},
            },
            [1040, 300],
            onError="continueRegularOutput",
        ),
        node(
            "GPT-4o (GitHub Models)",
            "@n8n/n8n-nodes-langchain.lmChatOpenAi",
            1.3,
            {
                "model": {"__rl": True, "mode": "id", "value": "openai/gpt-4o"},
                "responsesApiEnabled": False,
                "options": {
                    "baseURL": MODEL_BASE_URL,
                    "temperature": 0.2,
                    "maxRetries": 6,
                    "timeout": 120000,
                    "maxTokens": 3000,
                },
            },
            [700, 760],
            credentials=MODELS,
        ),
    ]

    tools = [
        sandbox_tool(
            "list_files",
            "list_files",
            "List files and folders in the workspace. Skips node_modules and .git. Use a small depth.",
            [("path", from_ai("path", "Folder relative to the workspace root, . for root", "string", ".")),
             ("depth", from_ai("depth", "How many folder levels to show, 1 to 4", "number", 2))],
            [800, 560],
        ),
        sandbox_tool(
            "read_file",
            "read_file",
            "Read up to 150 lines of a file with line numbers. Use startLine/endLine to read only the part you need.",
            [("path", from_ai("path", "File path relative to the workspace root")),
             ("startLine", from_ai("startLine", "First line to read, 1-based", "number", 1)),
             ("endLine", from_ai("endLine", "Last line to read", "number", 150))],
            [920, 560],
        ),
        sandbox_tool(
            "search_code",
            "search",
            "Search file contents with an extended regex (grep -E). Returns file:line:text matches. Use it to find where things are before reading.",
            [("pattern", from_ai("pattern", "Regex or plain word to search for")),
             ("path", from_ai("path", "Folder to search in, . for everything", "string", "."))],
            [1040, 560],
        ),
        sandbox_tool(
            "write_file",
            "write_file",
            "Create or overwrite a file with its FULL new content. Parent folders are created automatically.",
            [("path", from_ai("path", "File path relative to the workspace root")),
             ("content", from_ai("content", "The complete file content"))],
            [1160, 560],
        ),
        sandbox_tool(
            "run_command",
            "run",
            "Run a shell command in the workspace inside the sandbox (120s timeout). purpose=setup for installs, test for tests, run for anything else. The first failed command is recorded. Every later failure counts toward the 5 repair attempts, including purpose=setup.",
            [("command", from_ai("command", "Shell command, e.g. npm test or python -m pytest -q")),
             ("purpose", from_ai("purpose", "One of: setup, test, run", "string", "run"))],
            [1280, 560],
        ),
        sandbox_tool(
            "show_diff",
            "diff",
            "Show the files changed so far (git diff against the starting point).",
            [("scope", from_ai("scope", "Always the word all", "string", "all"))],
            [1400, 560],
        ),
        sandbox_tool(
            "update_state",
            "update_state",
            "Save your working state for the next turn: plan, notes (facts and progress) and next_step. Only non-empty fields are saved.",
            [("plan", from_ai("plan", "Numbered plan, or empty to keep the current one", "string", "")),
             ("notes", from_ai("notes", "Progress and key facts to remember", "string", "")),
             ("next_step", from_ai("next_step", "The very next action", "string", ""))],
            [1520, 560],
        ),
        sandbox_tool(
            "finish",
            "finish",
            "Close the task. status DONE (latest tests passed), FAILED, or BLOCKED. Call exactly once at the end.",
            [("status", from_ai("status", "DONE, FAILED or BLOCKED")),
             ("summary", from_ai("summary", "What changed, which files, how it was verified, what is left")),
             ("lessons", from_ai("lessons", "1 to 3 short lessons for future tasks, one per line", "string", "")),
             ("test_command", from_ai("test_command", "The command that verifies the project", "string", ""))],
            [1640, 560],
        ),
    ]
    nodes += tools

    nodes.append(
        node(
            "code_reviewer",
            "@n8n/n8n-nodes-langchain.agentTool",
            3,
            {
                "toolDescription": "Sub-agent that reviews the current changes with read-only tools and returns VERDICT: PASS or CHANGES_NEEDED with concrete issues. Use once before finishing non-trivial work.",
                "text": "={{ $fromAI('review_request', 'The goal of the change, the files changed, and anything you are unsure about', 'string') }}",
                "options": {"systemMessage": REVIEWER_SYSTEM, "maxIterations": 6},
            },
            [1760, 560],
        )
    )
    nodes.append(
        node(
            "ask_human",
            "@n8n/n8n-nodes-langchain.toolWorkflow",
            2.2,
            {
                "description": "Ask the human user one question on Telegram and wait up to 5 minutes for the answer. Use only when the task is ambiguous or a decision is risky.",
                "workflowId": {"__rl": True, "mode": "id", "value": ASK_ID},
                "workflowInputs": {
                    "mappingMode": "defineBelow",
                    "value": {"question": from_ai("question", "One short, specific question for the user")},
                    "matchingColumns": [],
                    "schema": [
                        {
                            "id": "question",
                            "displayName": "question",
                            "required": False,
                            "defaultMatch": False,
                            "display": True,
                            "canBeUsedToMatch": True,
                            "type": "string",
                        }
                    ],
                    "attemptToConvertTypes": False,
                    "convertFieldsToString": False,
                },
            },
            [1880, 560],
        )
    )

    # after the loop
    nodes += [
        http_post(
            "Build report",
            "/report",
            "={{ JSON.stringify({ taskId: $json.taskId, stopReason: $json.reason }) }}",
            [820, 0],
        ),
        node(
            "Report to file",
            "n8n-nodes-base.convertToFile",
            1.1,
            {
                "operation": "toText",
                "sourceProperty": "markdown",
                "binaryPropertyName": "data",
                "options": {"fileName": "={{ 'REPORT-' + $json.taskId + '.md' }}"},
            },
            [1040, -200],
        ),
        node(
            "Send report",
            "n8n-nodes-base.telegram",
            1.2,
            {
                "operation": "sendDocument",
                "chatId": "={{ $('Build report').first().json.chatId }}",
                "binaryData": True,
                "binaryPropertyName": "data",
                "additionalFields": {"caption": "={{ $('Build report').first().json.caption }}", "parse_mode": "HTML"},
            },
            [1260, -200],
            webhookId="wh-send-report",
            credentials=TELEGRAM,
        ),
        if_node("Can push?", "={{ $('Build report').first().json.canPush }}", IS_TRUE, [1480, -200]),
        node(
            "Approve push",
            "n8n-nodes-base.telegram",
            1.2,
            {
                "operation": "sendAndWait",
                "chatId": "={{ $('Build report').first().json.chatId }}",
                "message": "=Tests pass for task {{ $('Build report').first().json.taskId }}.\nChanged: {{ $('Build report').first().json.filesChanged.join(', ').slice(0, 600) }}\n\nPush branch agent/{{ $('Build report').first().json.taskId }} to GitHub?",
                "responseType": "approval",
                "approvalOptions": {"values": {"approvalType": "double", "approveLabel": "Push", "disapproveLabel": "Do not push"}},
                "options": {
                    "appendAttribution": False,
                    "limitWaitTime": {"values": {"limitType": "afterTimeInterval", "resumeAmount": 10, "resumeUnit": "minutes"}},
                },
            },
            [1700, -300],
            webhookId="wh-approve-push",
            credentials=TELEGRAM,
        ),
        if_node("Approved?", "={{ String($json.data && $json.data.approved) }}", {"type": "string", "operation": "equals"}, [1920, -300], right="true"),
        node(
            "Push branch",
            "n8n-nodes-base.httpRequest",
            4.2,
            {
                "method": "POST",
                "url": SANDBOX + "/push",
                "authentication": "genericCredentialType",
                "genericAuthType": "httpHeaderAuth",
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify({ taskId: $('Build report').first().json.taskId }) }}",
                "options": {"timeout": 180000},
            },
            [2140, -400],
            credentials=PUSH,
        ),
        telegram_text(
            "Send push result",
            "={{ $('Build report').first().json.chatId }}",
            "={{ $json.ok ? 'Pushed. Branch: ' + $json.url : 'Push failed: ' + String($json.message || '').replace(/[<>&]/g, ' ').slice(0, 800) }}",
            [2360, -400],
        ),
        telegram_text(
            "Send not pushed",
            "={{ $('Build report').first().json.chatId }}",
            "=Not pushed. The files stay in the sandbox workspace {{ $('Build report').first().json.taskId }}.",
            [2140, -200],
        ),
        # executionOrder v1 runs branches top to bottom: memory and run log sit above the
        # report/approval branch so they are saved before the workflow waits for a human.
        code("Memory rows", LESSON_ROWS_JS, [1040, -560]),
        data_table(
            "Save memory",
            "agent_memory",
            {"operation": "insert", "columns": {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [], "schema": []}, "options": {}},
            [1260, -560],
        ),
        node(
            "Run result",
            "n8n-nodes-base.set",
            3.4,
            {
                "assignments": {
                    "assignments": [
                        {"id": "s1", "name": "status", "value": "={{ $json.status }}", "type": "string"},
                        {"id": "s2", "name": "summary", "value": "={{ String($json.summary || $json.stopReason).slice(0, 1000) }}", "type": "string"},
                        {"id": "s3", "name": "fix_attempts", "value": "={{ $json.fixAttemptsUsed }}", "type": "number"},
                        {"id": "s4", "name": "turns", "value": "={{ $json.turns }}", "type": "number"},
                        {"id": "s5", "name": "duration_sec", "value": "={{ $json.durationSec }}", "type": "number"},
                    ]
                },
                "options": {},
            },
            [1040, -400],
        ),
        data_table(
            "Save run result",
            "runs",
            {
                "operation": "update",
                "matchType": "allConditions",
                "filters": {"conditions": [{"keyName": "task_id", "condition": "eq", "keyValue": "={{ $('Build report').first().json.taskId }}"}]},
                "columns": {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [], "schema": []},
                "options": {},
            },
            [1260, -400],
        ),
    ]

    connect(c, "Telegram Trigger", "Parse request")
    connect(c, "Parse request", "Is a task?")
    connect(c, "Is a task?", "Init workspace", 0)
    connect(c, "Is a task?", "Send help", 1)
    connect(c, "Init workspace", "Init ok?")
    connect(c, "Init ok?", "Send started", 0)
    connect(c, "Init ok?", "Run row", 0)
    connect(c, "Init ok?", "Has init report?", 1)
    connect(c, "Has init report?", "Init failure file", 0)
    connect(c, "Has init report?", "Send init error", 1)
    connect(c, "Init failure file", "Send init report")
    connect(c, "Run row", "Save run start")
    connect(c, "Save run start", "Load memory")
    connect(c, "Load memory", "Pick memory")
    connect(c, "Pick memory", "Next turn")
    connect(c, "Next turn", "Stop?")
    connect(c, "Stop?", "Build report", 0)
    connect(c, "Stop?", "Build prompt", 1)
    connect(c, "Build prompt", "Coding Agent")
    connect(c, "Coding Agent", "Next turn")

    connect(c, "Build report", "Report to file")
    connect(c, "Build report", "Memory rows")
    connect(c, "Build report", "Run result")
    connect(c, "Report to file", "Send report")
    connect(c, "Send report", "Can push?")
    connect(c, "Can push?", "Approve push", 0)
    connect(c, "Approve push", "Approved?")
    connect(c, "Approved?", "Push branch", 0)
    connect(c, "Approved?", "Send not pushed", 1)
    connect(c, "Push branch", "Send push result")
    connect(c, "Memory rows", "Save memory")
    connect(c, "Run result", "Save run result")

    for agent in ("Coding Agent", "code_reviewer"):
        connect(c, "GPT-4o (GitHub Models)", agent, kind="ai_languageModel")
    for t in tools:
        connect(c, t["name"], "Coding Agent", kind="ai_tool")
        if t["name"] in ("list_files", "read_file", "search_code", "show_diff"):
            connect(c, t["name"], "code_reviewer", kind="ai_tool")
    connect(c, "code_reviewer", "Coding Agent", kind="ai_tool")
    connect(c, "ask_human", "Coding Agent", kind="ai_tool")

    return workflow(
        "Coding Agent",
        MAIN_ID,
        nodes,
        c,
        {"executionOrder": "v1", "errorWorkflow": ERR_ID, "executionTimeout": 900, "saveManualExecutions": True},
    )


# ---------------------------------------------------------------- ask human

def build_ask_human():
    nodes, c = [], {}
    nodes += [
        node(
            "When called by agent",
            "n8n-nodes-base.executeWorkflowTrigger",
            1.1,
            {"workflowInputs": {"values": [{"name": "question", "type": "string"}]}},
            [0, 0],
        ),
        node("Get task", "n8n-nodes-base.httpRequest", 4.2, {"url": SANDBOX + "/state", "options": {}}, [220, 0]),
        node(
            "Ask on Telegram",
            "n8n-nodes-base.telegram",
            1.2,
            {
                "operation": "sendAndWait",
                "chatId": "={{ $json.chatId }}",
                "message": "=The coding agent needs your input (task {{ $json.taskId }}):\n\n{{ $('When called by agent').first().json.question }}\n\nTap the button and type your answer. You have 5 minutes.",
                "responseType": "freeText",
                "options": {
                    "appendAttribution": False,
                    "limitWaitTime": {"values": {"limitType": "afterTimeInterval", "resumeAmount": 5, "resumeUnit": "minutes"}},
                },
            },
            [440, 0],
            webhookId="wh-ask-human",
            credentials=TELEGRAM,
        ),
        node(
            "Answer",
            "n8n-nodes-base.set",
            3.4,
            {
                "assignments": {
                    "assignments": [
                        {
                            "id": "a1",
                            "name": "answer",
                            "value": "={{ ($json.data && $json.data.text) ? $json.data.text : 'No answer within 5 minutes. Make a reasonable assumption, write it in your notes, and continue.' }}",
                            "type": "string",
                        }
                    ]
                },
                "options": {},
            },
            [660, 0],
        ),
    ]
    connect(c, "When called by agent", "Get task")
    connect(c, "Get task", "Ask on Telegram")
    connect(c, "Ask on Telegram", "Answer")
    return workflow("Coding Agent - Ask Human", ASK_ID, nodes, c, {"executionOrder": "v1", "callerPolicy": "workflowsFromSameOwner"})


# ---------------------------------------------------------------- error report

def build_error_report():
    nodes, c = [], {}
    nodes += [
        node("On workflow error", "n8n-nodes-base.errorTrigger", 1, {}, [0, 0]),
        http_post(
            "Close task",
            "/report",
            "={{ JSON.stringify({ error: String(($json.execution.error && $json.execution.error.message) || 'Unknown error') + ' (last node: ' + ($json.execution.lastNodeExecuted || '?') + ')' }) }}",
            [220, 0],
        ),
        if_node("Has chat?", "={{ $json.ok && !!$json.chatId }}", IS_TRUE, [440, 0]),
        node(
            "Report to file",
            "n8n-nodes-base.convertToFile",
            1.1,
            {
                "operation": "toText",
                "sourceProperty": "markdown",
                "binaryPropertyName": "data",
                "options": {"fileName": "={{ 'REPORT-' + $json.taskId + '.md' }}"},
            },
            [660, 0],
        ),
        node(
            "Send stop report",
            "n8n-nodes-base.telegram",
            1.2,
            {
                "operation": "sendDocument",
                "chatId": "={{ $('Close task').first().json.chatId }}",
                "binaryData": True,
                "binaryPropertyName": "data",
                "additionalFields": {"caption": "={{ 'Stopped. ' + $('Close task').first().json.caption }}", "parse_mode": "HTML"},
            },
            [880, 0],
            webhookId="wh-send-stop-report",
            credentials=TELEGRAM,
        ),
    ]
    connect(c, "On workflow error", "Close task")
    connect(c, "Close task", "Has chat?")
    connect(c, "Has chat?", "Report to file", 0)
    connect(c, "Report to file", "Send stop report")
    return workflow("Coding Agent - Error Report", ERR_ID, nodes, c, {"executionOrder": "v1"})


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for filename, wf in (
        ("coding-agent.json", build_main()),
        ("ask-human.json", build_ask_human()),
        ("error-report.json", build_error_report()),
    ):
        (OUT / filename).write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {OUT / filename} ({len(wf['nodes'])} nodes)")
