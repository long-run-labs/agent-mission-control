// node --test test/smoke.test.mjs — drives the real hook, CLI and console against temp projects.
// Tests named after a review finding (B1, M2, …) guard that fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellWords, chatArgv } from "../hooks/mission-hook.mjs";

process.env.MC_NO_DESKTOP = "1"; // no real notifications while testing
process.env.CLAUDE_CODE_SESSION_ATTENDED = "1"; // hooks run as in a session a person is attending, unless a test says otherwise

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL = fs.existsSync(path.join(root, "dashboard")); // the free core ships without the console and alerts
const fullOnly = { skip: !FULL && "console and alerts are in the full kit" };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mc test-")); // the space is deliberate
const install = (dir, ...args) => spawnSync(process.execPath, [path.join(root, "install.mjs"), dir, ...args], { encoding: "utf8" });
function project(goal = "Ship the export") {
  const dir = tmp();
  const r = install(dir, ...(goal ? ["--goal", goal] : []));
  assert.equal(r.status, 0, r.stderr);
  return dir;
}
const missionFile = (dir) => path.join(dir, ".mission/mission.json");
const state = (dir) => JSON.parse(fs.readFileSync(missionFile(dir), "utf8"));
const edit = (dir, fn) => { const m = state(dir); fn(m); fs.writeFileSync(missionFile(dir), JSON.stringify(m)); };
const hookRaw = (dir, input) => spawnSync(process.execPath, [path.join(dir, ".mission/hooks/mission-hook.mjs")], {
  input: JSON.stringify({ cwd: dir, session_id: "t", ...input }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
const hook = (dir, input) => {
  const r = hookRaw(dir, input);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};
const mc = (dir, ...args) => {
  const r = spawnSync(process.execPath, [path.join(dir, ".mission/cli/mc.mjs"), ...args], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
};
const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const ctx = (o) => o?.hookSpecificOutput?.additionalContext || "";
const reason = (o) => o?.hookSpecificOutput?.permissionDecisionReason || "";
const denied = (o) => o?.hookSpecificOutput?.permissionDecision === "deny";
const MC = "node .mission/cli/mc.mjs";
// The plugin's own copy of the hook, run the way Claude Code runs a plugin hook.
const pluginHook = (dir, input) => {
  const r = spawnSync(process.execPath, [path.join(root, "hooks/mission-hook.mjs")], {
    input: JSON.stringify({ cwd: dir, session_id: "t", ...input }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};
// What Claude Code sends when the human types a slash command: it expands first (UserPromptExpansion).
const typed = (prompt) => {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(prompt);
  return { hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: m[1], command_args: m[2], prompt, prompt_id: "p-" + Math.random() };
};
const plainPrompt = (prompt, extra) => ({ hook_event_name: "UserPromptSubmit", prompt, ...extra });

test("install registers every hook event locally and leaves shared settings alone (M4)", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
  install(dir);
  install(dir); // idempotent
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8")), { permissions: { allow: ["Bash(npm test)"] } });
  const local = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.local.json"), "utf8"));
  for (const ev of ["SessionStart", "UserPromptExpansion", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]) assert.equal(local.hooks[ev].length, 1, ev);
  assert.equal(fs.readFileSync(path.join(dir, ".mission/.gitignore"), "utf8"), "*\n");
  assert.ok(fs.existsSync(path.join(dir, ".claude/skills/mission-control/SKILL.md")));
});

test("--shared merges into settings.json, keeps the first backup and ignores only state (M4, m3)", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".claude"));
  const original = JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } });
  fs.writeFileSync(path.join(dir, ".claude/settings.json"), original);
  install(dir, "--shared");
  install(dir, "--shared");
  const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"));
  assert.deepEqual(s.permissions.allow, ["Bash(npm test)"]);
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, ".claude/settings.json.bak"), "utf8"), original);
  assert.match(fs.readFileSync(path.join(dir, ".mission/.gitignore"), "utf8"), /^mission\.json$/m);
});

test("the hook command is PowerShell-safe and old installs are upgraded in place (M3)", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".claude"));
  const legacy = 'node "$CLAUDE_PROJECT_DIR/.mission/hooks/mission-hook.mjs"';
  fs.writeFileSync(path.join(dir, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: legacy }] }] } }));
  install(dir);
  const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.local.json"), "utf8"));
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PROJECT_DIR}/.mission/hooks/mission-hook.mjs"');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node "${CLAUDE_PROJECT_DIR}/.mission/hooks/mission-hook.mjs"');
});

test("a malformed settings file stops the installer before it changes anything (m3)", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: {} } }));
  const r = install(dir);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, ".mission")), false);
});

test("session start injects the brief, with an absolute mc path (m5)", () => {
  const dir = project();
  const out = hook(dir, { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx(out), /Goal: Ship the export/);
  assert.ok(ctx(out).includes(`node "${path.join(fs.realpathSync(dir), ".mission", "cli", "mc.mjs")}" now`));
  assert.ok(state(dir).usage.startedAt);
});

test("human notes and answers reach the agent once, after a tool call", () => {
  const dir = project();
  hook(dir, { hook_event_name: "SessionStart" });
  mc(dir, "ask", "Which format?", "--option", "CSV", "--option", "XLSX");
  mc(dir, "say", "Use the staging DB only");
  mc(dir, "answer", "q1", "CSV");
  const first = hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" });
  assert.match(ctx(first), /Use the staging DB only/);
  assert.match(ctx(first), /Answer to q1.*CSV/);
  assert.equal(hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" }), null);
  assert.equal(state(dir).usage.toolCalls, 2);
});

test("risky commands wait for GO, then run once; the GO is spent only when the command runs (m6)", () => {
  const dir = project();
  const first = hook(dir, bash("git push origin main"));
  assert.ok(denied(first));
  assert.match(reason(first), /Queued as a1/);
  assert.match(reason(hook(dir, bash("git push origin main"))), /Still waiting/);
  assert.equal(hook(dir, bash("git status")), null);
  mc(dir, "approve", "a1");
  assert.match(ctx(hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" })), /a1 APPROVED/);
  assert.equal(hook(dir, bash("git push origin main")), null);
  assert.equal(hook(dir, bash("git push origin main")), null, "still unused: the first attempt never ran");
  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.match(reason(hook(dir, bash("git push origin main"))), /Queued as a2/);
});

test("approval patterns ignore extra whitespace (m4)", () => {
  const dir = project();
  assert.match(reason(hook(dir, bash("git   push  origin main"))), /Queued as a1/);
});

test("chaining a command onto mc doesn't skip the checks (B1)", () => {
  const dir = project();
  assert.ok(denied(hook(dir, bash(`${MC} now "pushing" && git push origin main`))));
  assert.ok(denied(hook(dir, bash(`${MC} now "$(git push origin main)"`))));
  assert.ok(denied(hook(dir, bash(`${MC} now "x"; rm -rf build`))));
  assert.equal(hook(dir, bash(`${MC} now 'literal $(not run) && fine'`)), null, "single-quoted text is just text");
  mc(dir, "pause");
  assert.ok(denied(hook(dir, bash(`rm -rf build; ${MC} status`))));
});

test("the agent can't run the human's mc commands or touch .mission/ (M2)", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  for (const sub of ["approve a1", "resume", "reset-budget", "set maxToolCalls 0", "say hi", "answer q1 x", "goal new", "ui"]) {
    const out = hook(dir, bash(`${MC} ${sub}`));
    assert.ok(denied(out), sub);
    assert.match(reason(out), /for the human/);
  }
  assert.ok(denied(hook(dir, bash("sed -i '' s/waiting/approved/ .mission/mission.json"))));
  assert.ok(denied(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, ".mission/mission.json") } })));
  assert.ok(denied(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: ".mission/hooks/mission-hook.mjs" } })));
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/submission.json") } }), null);
  mc(dir, "pause");
  assert.equal(hook(dir, bash(`${MC} now "waiting for the human"`)), null, "agent commands still work on hold");
});

test("pause and budget refuse tools, and the budget message points to the human (B2)", () => {
  const dir = project();
  mc(dir, "pause");
  assert.match(reason(hook(dir, bash("ls"))), /Paused/);
  assert.match(reason(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} })), /Paused/);
  mc(dir, "resume");
  mc(dir, "set", "maxToolCalls", "2");
  hook(dir, { hook_event_name: "PostToolUse" });
  hook(dir, { hook_event_name: "PostToolUseFailure" }); // failed calls count too (m7)
  const out = hook(dir, bash("ls"));
  assert.match(reason(out), /budget used up/);
  assert.match(reason(out), /Only the human can extend/);
});

test("the budget stops applying once the goal is done, and a new goal restarts it (B2)", () => {
  const dir = project();
  hook(dir, { hook_event_name: "SessionStart" });
  edit(dir, (m) => { m.usage.startedAt = new Date(Date.now() - 3 * 3600e3).toISOString(); });
  assert.ok(denied(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} })));
  mc(dir, "done", "shipped");
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }), null);
  assert.equal(hook(dir, { hook_event_name: "Stop" }), null);
  mc(dir, "goal", "Next feature");
  const u = state(dir).usage;
  assert.equal(u.toolCalls, 0);
  assert.equal(u.startedAt, null, "the clock starts at first use, not when the goal is set (N3)");
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }), null);
  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" });
  assert.ok(Date.now() - new Date(state(dir).usage.startedAt).getTime() < 60e3);
});

test("with no goal set, the Stop hook lets the run end (M1)", () => {
  const dir = project(null);
  hook(dir, { hook_event_name: "SessionStart" });
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: false }), null);
});

test("stop is blocked until done, but not when waiting on the human or stuck", () => {
  const dir = project();
  const block = hook(dir, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(block.decision, "block");
  assert.match(block.reason, /Ship the export/);
  assert.match(block.reason, /ask "\.\.\." --blocking/);
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: true }), null, "no tool calls since the last push: let it stop");
  hook(dir, { hook_event_name: "PostToolUse" });
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: true }).decision, "block");
  mc(dir, "ask", "--blocking", "Prod credentials?");
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: false }), null);
  mc(dir, "answer", "q1", "Use the read-only key");
  assert.match(hook(dir, { hook_event_name: "Stop", stop_hook_active: false }).reason, /read-only key/);
  mc(dir, "done", "Shipped");
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: false }), null);
});

test("ask --blocking keeps the question text, and -- ends flags (M6)", () => {
  const dir = project();
  assert.ok(mc(dir, "ask", "--blocking", "Need prod creds?").ok);
  assert.ok(mc(dir, "say", "--", "--force is fine here").ok);
  const m = state(dir);
  assert.equal(m.questions[0].text, "Need prod creds?");
  assert.equal(m.questions[0].blocking, true);
  assert.equal(m.inbox[0].text, "--force is fine here");
});

test("a broken mission file fails closed for tools, and says so (B3)", () => {
  const dir = project();
  fs.writeFileSync(missionFile(dir), fs.readFileSync(missionFile(dir), "utf8").replace('"paused": false', '"paused": true,,'));
  const out = hook(dir, bash("git push --force origin main"));
  assert.ok(denied(out));
  assert.match(out.systemMessage, /isn't valid JSON/);
  assert.ok(denied(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} })));
  assert.ok(!denied(hook(dir, bash(`${MC} status`))), "the agent's own mc commands still run");
  const status = mc(dir, "status");
  assert.ok(!status.ok);
  assert.match(status.out, /isn't valid JSON/, "and mc reports the problem itself");
});

test("hand-edited values are coerced, not ignored (B3)", () => {
  const dir = project();
  edit(dir, (m) => { m.controls.requireApproval = "git push, npm publish"; });
  assert.match(reason(hook(dir, bash("npm publish"))), /Queued as a1/);
  edit(dir, (m) => { m.controls.paused = "yes"; });
  assert.match(reason(hook(dir, bash("ls"))), /Paused/);
  edit(dir, (m) => { m.controls.paused = "false"; m.controls.maxToolCalls = "abc"; });
  assert.equal(hook(dir, bash("ls")), null);
});

test("a stale lock is cleared instead of opening the gate (B3)", () => {
  const dir = project();
  fs.mkdirSync(missionFile(dir) + ".lock");
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(missionFile(dir) + ".lock", old, old);
  assert.match(reason(hook(dir, bash("git push origin main"))), /Queued as a1/);
  assert.equal(fs.existsSync(missionFile(dir) + ".lock"), false);
});

test("large notes don't break the hook's output (m1)", () => {
  const dir = project();
  edit(dir, (m) => { for (let i = 1; i <= 40; i++) m.inbox.unshift({ id: "m" + i, text: "x".repeat(5000), at: new Date().toISOString(), seen: false }); });
  const r = hookRaw(dir, { hook_event_name: "PostToolUse", tool_name: "Read" });
  const out = JSON.parse(r.stdout); // valid JSON, not cut off
  assert.ok(r.stdout.length < 12000);
  assert.match(ctx(out), /more, delivered after your next tool call/);
  assert.ok(mc(dir, "say", "y".repeat(10000)).ok);
  assert.equal(state(dir).inbox[0].text.length, 4000);
});

test("console: token required for the page and API, bad Host refused, broken file answered (M2, m2)", fullOnly, async () => {
  const dir = project();
  const { startServer } = await import(pathToFileURL(path.join(dir, ".mission/dashboard/server.mjs")).href);
  const port = 47000 + Math.floor(Math.random() * 2000);
  const server = startServer({ file: missionFile(dir), port, quiet: true });
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${port}`;
    const token = server.mcToken;
    assert.equal((await fetch(base + "/")).status, 401);
    const page = await (await fetch(`${base}/?t=${token}`)).text();
    assert.ok(page.includes(`const TOKEN = "${token}"`));
    assert.equal((await fetch(base + "/api/state")).status, 401);
    const evil = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: `/?t=${token}`, headers: { host: "evil.example:80" } }, (res) => resolve(res.statusCode));
    });
    assert.equal(evil, 403);
    const ok = await fetch(base + "/api/action", { method: "POST", headers: { "x-mc-token": token, "content-type": "application/json" }, body: JSON.stringify({ type: "say", text: "hello from the console" }) });
    assert.equal(ok.status, 200);
    assert.equal(state(dir).inbox[0].text, "hello from the console");
    await fetch(base + "/api/action", { method: "POST", headers: { "x-mc-token": token, "content-type": "application/json" }, body: JSON.stringify({ type: "controls", patch: { maxToolCalls: "" } }) });
    assert.equal(state(dir).controls.maxToolCalls, 400, "an emptied box doesn't remove the limit (m9)");
    fs.writeFileSync(missionFile(dir), "{ not json");
    assert.equal((await fetch(base + "/api/state", { headers: { "x-mc-token": token } })).status, 500);
  } finally {
    server.close();
  }
});

test("a GO request pings the configured ntfy topic", fullOnly, async () => {
  const dir = project();
  const got = [];
  const fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { got.push({ url: req.url, title: req.headers.title, priority: req.headers.priority, body }); res.end("{}"); });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  try {
    edit(dir, (m) => { m.controls.notify = { desktop: false, ntfyTopic: "my-agent", ntfyServer: `http://127.0.0.1:${fake.address().port}` }; });
    const child = spawn(process.execPath, [path.join(dir, ".mission/hooks/mission-hook.mjs")], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.end(JSON.stringify({ cwd: dir, ...bash("npm publish --access public") }));
    await new Promise((r) => child.on("close", r));
    assert.match(reason(JSON.parse(out)), /Queued as a1/);
    assert.equal(got.length, 1);
    assert.equal(got[0].url, "/my-agent");
    assert.equal(got[0].title, "Agent needs a GO (a1)");
    assert.equal(got[0].priority, "high");
    assert.equal(got[0].body, "npm publish --access public");
  } finally {
    fake.close();
  }
});

test("repeated stops send each alert once (m8)", () => {
  const dir = project();
  mc(dir, "ask", "Which region?", "--blocking");
  hook(dir, { hook_event_name: "Stop" });
  assert.equal(state(dir).usage.lastAlert, "blocking:q1");
  hook(dir, { hook_event_name: "Stop" });
  assert.equal(state(dir).usage.lastAlert, "blocking:q1");
});

test("in a git repo, the installer keeps its personal files out of commits (N1)", () => {
  const dir = tmp();
  const home = tmp(); // no global excludes, like a fresh machine
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  spawnSync("git", ["init", "-q"], { cwd: dir, env });
  const r = spawnSync(process.execPath, [path.join(root, "install.mjs"), dir, "--goal", "x"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.git\/info\/exclude/);
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, env, encoding: "utf8" }).stdout;
  assert.equal(status.trim(), "", `nothing to commit, got:\n${status}`);
  spawnSync(process.execPath, [path.join(root, "install.mjs"), dir], { encoding: "utf8", env });
  const exclude = fs.readFileSync(path.join(dir, ".git/info/exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === "/.claude/settings.local.json*").length, 1, "added once");
});

test("a failed run spends the GO too (N2)", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  mc(dir, "approve", "a1");
  assert.equal(hook(dir, bash("git push origin main")), null);
  hook(dir, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.match(reason(hook(dir, bash("git push origin main"))), /Queued as a2/);
});

test("only this project's mc is exempt; a trailing 2>&1 is fine (N4, N6)", () => {
  const dir = project();
  mc(dir, "pause");
  assert.ok(denied(hook(dir, bash("node /tmp/elsewhere/.mission/cli/mc.mjs status"))));
  assert.equal(hook(dir, bash(`${MC} status 2>&1`)), null);
  assert.equal(hook(dir, bash(`node "${path.join(dir, ".mission/cli/mc.mjs")}" now "absolute path"`)), null);
});

test("backslashes inside double quotes follow bash rules, so Windows paths survive (N5)", () => {
  assert.deepEqual(shellWords('node "C:\\Users\\me\\.mission\\cli\\mc.mjs" now "say \\"hi\\""'), ["node", "C:\\Users\\me\\.mission\\cli\\mc.mjs", "now", 'say "hi"']);
  const dir = project();
  const out = hook(dir, { hook_event_name: "SessionStart" });
  assert.ok(!/mc\.mjs"/.test(ctx(out)) || !ctx(out).includes("\\.mission\\"), "brief uses forward slashes");
});

test("the agent's own mc done doesn't come back as news from the human (N9)", () => {
  const dir = project();
  hook(dir, { hook_event_name: "SessionStart" });
  mc(dir, "done", "shipped");
  assert.equal(hook(dir, { hook_event_name: "PostToolUse", tool_name: "Bash" }), null);
});

test("git clean with -x needs a GO by default (N10)", () => {
  const dir = project();
  assert.match(reason(hook(dir, bash("git clean -fdx"))), /Queued as a1/);
  assert.equal(hook(dir, bash("git clean -fd")), null);
});

// 1.1.0: /mc in the chat, the plugin, and review round 3 (R3–R5).

test("/mc applies the human's command and hands the agent the result", () => {
  const dir = project();
  hook(dir, { hook_event_name: "SessionStart" });
  hook(dir, bash("git push origin main"));
  const out = hook(dir, typed("/mc approve a1"));
  assert.match(ctx(out), /the human typed `\/mc approve a1`/);
  assert.match(ctx(out), /a1 approved: git push origin main/);
  assert.match(ctx(out), /a1 APPROVED/, "and the decision is delivered right away");
  assert.equal(state(dir).approvals[0].state, "approved");
  assert.equal(hook(dir, bash("git push origin main")), null);
  assert.match(ctx(hook(dir, typed("/agent-mission-control:mc status"))), /State: running/);
});

test("/mc takes notes, answers and reasons exactly as typed", () => {
  const dir = project();
  const note = `use the "staging" DB, it's $(rm -rf x) \`y\` & that's final`;
  hook(dir, typed(`/mc say ${note}`));
  assert.equal(state(dir).inbox[0].text, note);
  hook(dir, typed('/mc say "quoted whole"'));
  assert.equal(state(dir).inbox[0].text, "quoted whole");
  mc(dir, "ask", "Which DB?");
  hook(dir, typed("/mc answer q1 Postgres, not SQLite"));
  assert.equal(state(dir).questions[0].answer, "Postgres, not SQLite");
  hook(dir, bash("npm publish"));
  hook(dir, typed("/mc deny a1 not on Fridays"));
  assert.equal(state(dir).approvals[0].note, "not on Fridays");
  hook(dir, typed("/mc set requireApproval git push, npm publish"));
  assert.deepEqual(state(dir).controls.requireApproval, ["git push", "npm publish"]);
  assert.deepEqual(chatArgv('goal "Ship it" --done-when "tests pass"'), ["goal", "--done-when", "tests pass", "--", "Ship it"]);
  assert.deepEqual(chatArgv("goal Ship the CSV export --done-when tests pass and a PR is open"), ["goal", "--done-when", "tests pass and a PR is open", "--", "Ship the CSV export"]);
});

test("/mc refuses the agent's own commands and explains mistakes", () => {
  const dir = project();
  assert.match(ctx(hook(dir, typed("/mc ask what now"))), /the agent's command/);
  assert.match(ctx(hook(dir, typed("/mc approve a9"))), /No approval with id a9/);
  assert.match(ctx(hook(dir, typed("/mc"))), /type these in the chat/);
  assert.equal(hook(dir, typed("/mcp")), null, "other commands are left alone");
  assert.doesNotMatch(ctx(hook(dir, plainPrompt("please run /mc status"))), /the human typed/);
});

test("the plugin does nothing in a project without a mission", () => {
  const dir = tmp();
  for (const input of [{ hook_event_name: "SessionStart" }, bash("git push origin main"), { hook_event_name: "PostToolUse", tool_name: "Read" }, { hook_event_name: "Stop" }, plainPrompt("hello"), plainPrompt("/mc approve a1")]) {
    assert.equal(pluginHook(dir, input), null, input.hook_event_name);
  }
  assert.equal(fs.existsSync(path.join(dir, ".mission")), false);
});

test("/mc goal starts a git-ignored mission from the plugin, and the brief points at the plugin's mc", () => {
  const dir = tmp();
  const out = pluginHook(dir, typed("/mc goal Ship the CSV export --done-when tests pass"));
  const m = state(dir);
  assert.equal(m.goal.text, "Ship the CSV export");
  assert.equal(m.goal.doneWhen, "tests pass");
  assert.equal(fs.readFileSync(path.join(dir, ".mission/.gitignore"), "utf8"), "*\n");
  assert.ok(ctx(out).includes(`node "${path.join(fs.realpathSync(root), "cli", "mc.mjs")}" now`), "brief included, with the plugin's mc");
  assert.match(reason(pluginHook(dir, bash("git push origin main"))), /Queued as a1/);
  assert.ok(denied(pluginHook(dir, bash(`node "${path.join(root, "cli/mc.mjs")}" approve a1`))), "the agent can't approve itself");
  assert.equal(pluginHook(dir, bash(`node "${path.join(root, "cli/mc.mjs")}" now "working"`)), null);
});

test("a project install takes over from the plugin, so nothing runs twice", () => {
  const dir = project();
  assert.equal(pluginHook(dir, bash("git push origin main")), null, "the plugin steps aside");
  assert.equal(pluginHook(dir, typed("/mc status")), null);
  assert.match(reason(hook(dir, bash("git push origin main"))), /Queued as a1/, "the project's copy is in charge");
  assert.equal(state(dir).usage.toolCalls, 0);
});

test("the agent can't reach mc's human commands by another path", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  for (const cmd of ["cd .mission/cli && node mc.mjs approve a1", "node ./x/../.mission/cli/mc.mjs approve a1", `node "${path.join(root, "cli/mc.mjs")}" approve a1`, "cp -r .mission /tmp/m && node /tmp/m/cli/mc.mjs approve a1"]) {
    assert.ok(denied(hook(dir, bash(cmd))), cmd);
  }
  assert.equal(state(dir).approvals[0].state, "waiting");
});

test("a lock older than a minute is stale even if its PID is alive (R3)", () => {
  const dir = project();
  const lock = missionFile(dir) + ".lock";
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), "1"); // launchd/init: always alive
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  assert.match(reason(hook(dir, bash("git push origin main"))), /Queued as a1/);
  assert.equal(fs.existsSync(lock), false);
});

test("symlinked project paths still match the project's mc (R4)", () => {
  const dir = project();
  const link = path.join(tmp(), "link");
  fs.symlinkSync(dir, link);
  mc(dir, "pause");
  assert.equal(hook(dir, { ...bash(`node "${path.join(link, ".mission/cli/mc.mjs")}" status`), cwd: link }), null);
});

test(".MISSION in a shell command is caught where the disk ignores case (R5)", { skip: !["darwin", "win32"].includes(process.platform) && "case-sensitive disk" }, () => {
  const dir = project();
  assert.ok(denied(hook(dir, bash("cat .MISSION/mission.json"))));
});

test("the plugin's hook list registers every event with the plugin's own hook", { skip: !fs.existsSync(path.join(root, "hooks/hooks.json")) && "built into the plugin only" }, () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8"));
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]) {
    assert.deepEqual(hooks[ev][0].hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/mission-hook.mjs"], ev);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
});

test("a held command gets one push to keep working, then the run may stop without a second question (M1)", () => {
  const dir = project();
  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" });
  hook(dir, bash("git push origin main"));
  const first = hook(dir, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(first.decision, "block", "a held command alone isn't a reason to stop");
  assert.match(first.reason, /Held for the human: a1 `git push origin main`/);
  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" }); // it found other work
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: true }).decision, "block");
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: true }), null, "nothing left but the held command: it may stop");
  assert.match(state(dir).log[0].text, /waiting for your GO on a1/);
  hook(dir, typed("/mc approve a1"));
  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: false }).decision, "block", "once it's decided and run, the goal pushes on");
});

test("a new goal expires approvals left from the old one (M1)", () => {
  const dir = project();
  hook(dir, bash("npm publish"));
  hook(dir, typed("/mc goal Refactor the parser"));
  assert.equal(state(dir).approvals[0].state, "expired");
  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" });
  assert.equal(hook(dir, { hook_event_name: "Stop", stop_hook_active: false }).decision, "block");
  assert.match(reason(hook(dir, bash("npm publish"))), /Queued as a2/, "the same command asks again under the new goal");
});

// Release review v4: B1 (the agent approving itself through /mc), M2, m2, m3.

test("a /mc from claude -p or a script is refused: only an attended session applies it (B1)", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  const r = spawnSync(process.execPath, [path.join(dir, ".mission/hooks/mission-hook.mjs")], {
    input: JSON.stringify({ cwd: dir, session_id: "t", ...typed("/mc approve a1") }), encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ATTENDED: "0" },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /only work in a session a person is attending/);
  assert.equal(state(dir).approvals[0].state, "waiting");
});

test("a scheduled /mc arrives as plain text and isn't applied (B1)", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  const out = hook(dir, plainPrompt("/mc approve a1"));
  assert.match(ctx(out), /NOT applied/);
  assert.equal(state(dir).approvals[0].state, "waiting");
  const t = typed("/mc say hello");
  hook(dir, t);
  assert.doesNotMatch(ctx(hook(dir, plainPrompt("/mc say hello", { prompt_id: t.prompt_id }))) , /NOT applied/, "the typed one isn't flagged");
});

test("the agent can't send /mc through a tool: nested claude, schedules, files (B1)", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  for (const input of [
    bash('claude -p "/mc approve a1" --max-turns 1'),
    bash("echo '/mc resume' | claude -p"),
    { hook_event_name: "PreToolUse", tool_name: "CronCreate", tool_input: { cron: "5 3 * * *", prompt: "/mc approve a1" } },
    { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup", tool_input: { delaySeconds: 60, prompt: "/agent-mission-control:mc set maxToolCalls 0" } },
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "go.sh", content: "claude -p '/mc approve a1'" } },
  ]) assert.ok(denied(hook(dir, input)), JSON.stringify(input.tool_input));
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "/mc approve" } }), null, "searching for it is fine");
  assert.ok(denied(hook(dir, bash("node -e \"import('./lib/commands.mjs')\""))), "the library isn't a way around mc either");
});

test("plugin mode: a mission in a parent folder doesn't take over the projects below it (M2)", () => {
  const parent = tmp();
  pluginHook(parent, typed("/mc goal tidy my dotfiles"));
  const child = path.join(parent, "code", "other-project");
  fs.mkdirSync(path.join(child, ".git"), { recursive: true });
  assert.equal(pluginHook(child, { hook_event_name: "SessionStart" }), null);
  assert.equal(pluginHook(child, bash("git push origin main")), null);
  pluginHook(child, typed("/mc goal ship feature X"));
  assert.equal(state(child).goal.text, "ship feature X", "its own mission, in the project");
  assert.equal(state(parent).goal.text, "tidy my dotfiles", "the parent's is untouched");
});

test("the plugin steps aside only for a project install that's actually registered (m2)", () => {
  const dir = tmp();
  pluginHook(dir, typed("/mc goal Ship it"));
  fs.mkdirSync(path.join(dir, ".mission/hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mission/hooks/mission-hook.mjs"), "");
  assert.match(reason(pluginHook(dir, bash("git push origin main"))), /Queued as a1/, "a stray file doesn't switch the checks off");
});

test("re-installing doesn't replace the backup of your own settings with ours (m3)", () => {
  const dir = tmp();
  install(dir);
  install(dir);
  assert.equal(fs.existsSync(path.join(dir, ".claude/settings.local.json.bak")), false);
});

// Release review v5: M1 (a disguised /mc), m1 (false refusals), m5 (unattended reads).

test("a disguised /mc is still caught, and starting a nested claude needs a GO (v5 M1)", () => {
  const dir = project();
  hook(dir, bash("git push origin main"));
  assert.ok(denied(hook(dir, bash("env -u CLAUDE_CODE_CHILD_SESSION claude -p '/mc'' approve a1'"))), "split quotes");
  assert.ok(denied(hook(dir, bash('claude -p "/m\\c approve a1"'))), "a backslash");
  const nested = hook(dir, bash("claude --version"));
  assert.match(reason(nested), /nested Claude Code session.*Queued as a2/s, "any nested claude waits for the human");
  assert.match(reason(hook(dir, bash("git commit -m wip && claude -p hi"))), /Queued as a3/);
  assert.equal(state(dir).approvals.find((a) => a.id === "a1").state, "waiting");
});

test("the agent's own mc, docs and commit messages may mention /mc (v5 m1)", () => {
  const dir = project();
  assert.equal(hook(dir, bash(`${MC} ask "The push is held as a1. Can you /mc approve a1?"`)), null);
  assert.equal(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "docs/usage.md", content: "Type /mc approve a1 in the chat." } }), null);
  assert.equal(hook(dir, bash('git commit -m "docs: explain /mc approve"')), null);
});

test("an unattended /mc status reads without taking the human's news (v5 m5)", () => {
  const dir = project();
  mc(dir, "say", "use the staging DB only");
  const r = spawnSync(process.execPath, [path.join(dir, ".mission/hooks/mission-hook.mjs")], {
    input: JSON.stringify({ cwd: dir, session_id: "t", ...typed("/mc status") }), encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ATTENDED: "0" },
  });
  assert.match(ctx(JSON.parse(r.stdout)), /State: running/);
  assert.match(ctx(hook(dir, { hook_event_name: "PostToolUse", tool_name: "Read" })), /use the staging DB only/, "the real session still gets the note");
});

test("only starting claude is held, not mentioning it; only a lone git commit skips the /mc check (v5.1 n1, n2)", () => {
  const dir = project();
  for (const c of ["grep -rn claude src", "which claude", 'git commit -m "mention claude here"', "ls ~/.claude/plugins"]) assert.equal(hook(dir, bash(c)), null, c);
  for (const c of ["env -u CLAUDE_CODE_CHILD_SESSION claude -p hi", 'bash -c "claude -p hi"', "cd sub && claude --version"]) assert.match(reason(hook(dir, bash(c))), /nested Claude Code session/, c);
  assert.ok(denied(hook(dir, bash("git commit -m wip && claude -p '/mc approve a1'"))), "a chained command gets the /mc check");
});
