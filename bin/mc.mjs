#!/usr/bin/env node
// mc: the Mission Control command line. Agents use it to report and ask; humans use it to steer
// from a terminal when the dashboard isn't open.
import path from "node:path";
import { findMissionFile, read, update, create, nextId, addLog, budget, resetUsage } from "../lib/store.mjs";
import { brief, syncControlsSeen } from "../lib/brief.mjs";
import { notify } from "../lib/notify.mjs";

const HELP = `mc — Mission Control for long-running agent runs

Agent commands
  mc brief                         Print the full mission brief
  mc status [--json]               Goal, budget, open questions and approvals
  mc now "text" [--phase P] [--next "step"]...   Update what you're doing and what's next
  mc log "text" [--kind build]     Add a log entry
  mc ask "question" [--option A]... [--blocking]  Ask the human; prints the question id
  mc reply <id> "text"             Reply to a human note
  mc done ["summary"]              Mark the goal done (lets the run finish)

Human commands (the hook refuses these when the agent tries to run them)
  mc init ["goal"]                 Create .mission/mission.json here
  mc goal "text" [--done-when "condition"]   Set a new goal (restarts the budget)
  mc say "text"                    Send the agent a note (arrives between tool calls)
  mc answer <id> "text"            Answer a question
  mc approve <id> | mc deny <id> ["why"]
  mc pause | mc resume
  mc set <control> <value>         maxToolCalls, maxMinutes, maxStopBlocks, notes, requireApproval (comma list)
  mc set ntfy <topic> | mc set desktop on|off    Phone and desktop alerts when the agent needs you
  mc test-alert                    Send a test alert to check your setup
  mc reset-budget                  Restart the tool-call and time budget
  mc ui [--port 4747]              Open the console (prints its private link)

Use -- to end flags when text starts with --:  mc say -- "--force is fine here"
`;

// Flags that never take a value, so `ask --blocking "text"` keeps its text.
const BOOLEAN_FLAGS = new Set(["blocking", "json", "help"]);
const MAX_TEXT = 4000;

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const key = a.slice(2);
      const val = !BOOLEAN_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      if (key in flags) flags[key] = [].concat(flags[key], val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}
const list = (v) => (v == null || v === true ? [] : [].concat(v).map(String));
// Throw rather than exit, so a failure inside update() still releases the file lock.
const die = (msg) => { throw Object.assign(new Error(msg), { usage: true }); };
const now = () => new Date().toISOString();

function need() {
  const f = findMissionFile();
  if (!f) die('No mission here. Run `mc init "your goal"` in the project root, or set MISSION_FILE.');
  return f;
}
function findItem(arr, id, what) {
  const x = arr.find((i) => i.id === id);
  if (!x) die(`No ${what} with id ${id}.`);
  return x;
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, flags } = parse(rest);
const fullText = pos.join(" ").trim();
const text = fullText.slice(0, MAX_TEXT);
if (fullText.length > MAX_TEXT) process.stderr.write(`Note: text trimmed to ${MAX_TEXT} characters.\n`);

try {
switch (cmd) {
  case undefined: case "help": case "--help": case "-h":
    process.stdout.write(HELP);
    break;

  case "init": {
    const file = process.env.MISSION_FILE ? path.resolve(process.env.MISSION_FILE) : path.resolve(".mission", "mission.json");
    try { create(file, text); } catch (e) { die(e.message); }
    console.log(`Created ${path.relative(process.cwd(), file) || file}`);
    break;
  }

  case "brief":
    { const f = need(); console.log(brief(read(f), f)); }
    break;

  case "status": {
    const m = read(need());
    if (flags.json) { console.log(JSON.stringify({ ...m, budget: budget(m) }, null, 2)); break; }
    const b = budget(m);
    console.log(`Goal: ${m.goal.text || "(none)"}${m.goal.done ? "  [DONE]" : ""}`);
    if (m.goal.doneWhen) console.log(`Done when: ${m.goal.doneWhen}`);
    const state = m.controls.paused ? "paused" : !m.goal.text ? "no goal set" : m.goal.done ? "done" : b.exhausted ? "out of budget" : "running";
    console.log(`State: ${state} · tool calls ${m.usage.toolCalls}/${m.controls.maxToolCalls || "∞"} · minutes ${Math.round(b.minutes)}/${m.controls.maxMinutes || "∞"}`);
    if (m.status.now) console.log(`Now: ${m.status.now}`);
    if (m.status.next.length) console.log(`Next: ${m.status.next.join(" → ")}`);
    for (const q of m.questions.filter((q) => q.answer == null)) console.log(`? ${q.id}${q.blocking ? " (blocking)" : ""}: ${q.text}${q.options?.length ? `  [${q.options.join(" / ")}]` : ""}`);
    for (const a of m.approvals.filter((a) => a.state === "waiting")) console.log(`! ${a.id} needs approval: ${a.command}`);
    for (const x of m.inbox.filter((x) => !x.seen)) console.log(`> ${x.id} unread note: ${x.text}`);
    break;
  }

  case "now": {
    if (!text) die('Usage: mc now "what you are doing" [--phase P] [--next "step"]');
    update(need(), (m) => {
      m.status.now = text;
      if (flags.phase && flags.phase !== true) m.status.phase = String(flags.phase);
      if (flags.next) m.status.next = list(flags.next);
      m.status.updatedAt = now();
    });
    console.log("Status updated.");
    break;
  }

  case "log": {
    if (!text) die('Usage: mc log "text" [--kind build]');
    update(need(), (m) => addLog(m, flags.kind && flags.kind !== true ? String(flags.kind) : "note", text));
    console.log("Logged.");
    break;
  }

  case "ask": {
    if (!text) die('Usage: mc ask "question" [--option A] [--blocking]');
    const id = update(need(), (m) => {
      const id = nextId(m.questions, "q");
      m.questions.unshift({ id, text, options: list(flags.option), blocking: !!flags.blocking, answer: null, askedAt: now() });
      addLog(m, "question", `${id}: ${text}`);
      return id;
    });
    if (flags.blocking) await notify(read(need()).controls, `Agent is blocked on ${id}`, text, "high");
    console.log(`Asked ${id}.${flags.blocking ? " It's blocking: finish what you can, then stop. The human answers and continues the session." : " The answer arrives in your context after a tool call once the human replies."}`);
    break;
  }

  case "reply": {
    const [id, ...words] = pos;
    if (!id || !words.length) die('Usage: mc reply <id> "text"');
    update(need(), (m) => { const x = findItem(m.inbox, id, "note"); x.reply = words.join(" "); x.repliedAt = now(); x.seen = true; });
    console.log(`Replied to ${id}.`);
    break;
  }

  case "done": {
    update(need(), (m) => { m.goal.done = true; m.goal.doneAt = now(); m.goal.summary = text; syncControlsSeen(m); addLog(m, "done", text || "Goal marked done."); });
    await notify(read(need()).controls, "Mission complete", text || "The agent marked the goal done.");
    console.log("Goal marked done. The run may finish now.");
    break;
  }

  case "goal": {
    if (!text) die('Usage: mc goal "text" [--done-when "condition"]');
    update(need(), (m) => {
      m.goal.text = text; m.goal.done = false; m.goal.doneAt = null; m.goal.summary = "";
      m.goal.doneWhen = flags["done-when"] && flags["done-when"] !== true ? String(flags["done-when"]) : "";
      resetUsage(m);
      addLog(m, "goal", `Goal set: ${text}`);
    });
    console.log("Goal set. The budget starts from zero.");
    break;
  }

  case "say": {
    if (!text) die('Usage: mc say "note for the agent"');
    const id = update(need(), (m) => { const id = nextId(m.inbox, "m"); m.inbox.unshift({ id, text, at: now(), seen: false }); return id; });
    console.log(`Sent ${id}. The agent sees it after its next tool call.`);
    break;
  }

  case "answer": {
    const [id, ...words] = pos;
    if (!id || !words.length) die('Usage: mc answer <id> "text"');
    update(need(), (m) => { const q = findItem(m.questions, id, "question"); q.answer = words.join(" ").slice(0, MAX_TEXT); q.answeredAt = now(); q.answerSeen = false; addLog(m, "answer", `${id}: ${q.answer}`); });
    console.log(`Answered ${id}. If the agent has already stopped, type "continue" in its session.`);
    break;
  }

  case "approve": case "deny": {
    const [id, ...words] = pos;
    if (!id) die(`Usage: mc ${cmd} <id>`);
    update(need(), (m) => {
      const a = findItem(m.approvals, id, "approval");
      a.state = cmd === "approve" ? "approved" : "denied"; a.note = words.join(" "); a.decidedAt = now(); a.decisionSeen = false;
      addLog(m, "approval", `${id} ${a.state}: ${a.command}`);
    });
    console.log(`${id} ${cmd === "approve" ? "approved" : "denied"}. If the agent has already stopped, type "continue" in its session.`);
    break;
  }

  case "pause": case "resume": {
    update(need(), (m) => { m.controls.paused = cmd === "pause"; addLog(m, "control", cmd === "pause" ? "Paused by the human." : "Resumed by the human."); });
    console.log(cmd === "pause" ? "Paused. The agent is stopped at its next tool call." : 'Resumed. If the agent has already stopped, type "continue" in its session.');
    break;
  }

  case "set": {
    const [key, ...vals] = pos;
    const value = vals.join(" ");
    const numeric = ["maxToolCalls", "maxMinutes", "maxStopBlocks"];
    if (!key || (!value && key !== "notes")) die("Usage: mc set <control> <value>");
    update(need(), (m) => {
      if (numeric.includes(key)) { const n = Number(value); if (!Number.isFinite(n) || n < 0) die(`${key} must be a number ≥ 0 (0 = no limit).`); m.controls[key] = n; }
      else if (key === "requireApproval") m.controls.requireApproval = value.split(",").map((s) => s.trim()).filter(Boolean);
      else if (key === "notes") m.controls.notes = value;
      else if (key === "ntfy") m.controls.notify.ntfyTopic = value === "off" ? "" : value;
      else if (key === "desktop") m.controls.notify.desktop = !/^(off|false|0|no)$/i.test(value);
      else die(`Unknown control "${key}". Try: ${[...numeric, "requireApproval", "notes", "ntfy", "desktop"].join(", ")}`);
      addLog(m, "control", `${key} set to ${value || "(empty)"}`);
    });
    console.log(`${key} updated.`);
    break;
  }

  case "test-alert": {
    console.log("Desktop and phone alerts are in the full kit: https://buy.polar.sh/polar_cl_XzIYl3hBPBQKZT8p4Sn31PRBKXB7LYpEE45zi3KltXp");
    break;
    const { controls } = read(need());
    await notify(controls, "Mission Control test", "Alerts work. You'll get one when the agent needs a GO or is blocked.", "default");
    const where = [controls.notify.desktop !== false && "desktop", controls.notify.ntfyTopic && `ntfy topic "${controls.notify.ntfyTopic}"`].filter(Boolean);
    console.log(where.length ? `Sent to ${where.join(" and ")}.` : "Alerts are off. Turn them on with `mc set desktop on` or `mc set ntfy <topic>`.");
    break;
  }

  case "reset-budget": {
    update(need(), (m) => { resetUsage(m); addLog(m, "control", "Budget restarted."); });
    console.log("Budget restarted.");
    break;
  }

  case "ui": {
    console.log("The live console (GO/NO-GO buttons, answers, budgets, phone alerts) is in the full kit: https://buy.polar.sh/polar_cl_XzIYl3hBPBQKZT8p4Sn31PRBKXB7LYpEE45zi3KltXp");
    break;
  }

  default:
    die(`Unknown command "${cmd}". Run \`mc help\`.`);
}
} catch (e) {
  process.stderr.write((e.usage ? e.message : `mc: ${e.message}`) + "\n");
  process.exit(1);
}
