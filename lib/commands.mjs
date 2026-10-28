// The mc commands, shared by the terminal (cli/mc.mjs) and the chat (/mc, applied by the hook).
// run() throws an error with `usage: true` for anything the person typed wrong.
import path from "node:path";
import { findMissionFile, read, update, create, nextId, addLog, budget, resetUsage } from "./store.mjs";
import { brief, syncControlsSeen, mcCmd } from "./brief.mjs";
import { notify } from "./notify.mjs";

export const HELP = `mc — Mission Control for long-running agent runs

Agent commands
  mc brief                         Print the full mission brief
  mc status [--json]               Goal, budget, open questions and approvals
  mc now "text" [--phase P] [--next "step"]...   Update what you're doing and what's next
  mc log "text" [--kind build]     Add a log entry
  mc ask "question" [--option A]... [--blocking]  Ask the human; prints the question id
  mc reply <id> "text"             Reply to a human note
  mc done ["summary"]              Mark the goal done (lets the run finish)

Human commands (the hook refuses these when the agent tries to run them)
  mc goal "text" [--done-when "condition"]   Set a new goal (restarts the budget)
  mc say "text"                    Send the agent a note (arrives between tool calls)
  mc answer <id> "text"            Answer a question
  mc approve <id> | mc deny <id> ["why"]
  mc pause | mc resume
  mc set <control> <value>         maxToolCalls, maxMinutes, maxStopBlocks, notes, requireApproval (comma list)
  mc set ntfy <topic> | mc set desktop on|off    Phone and desktop alerts (full kit)
  mc test-alert                    Send a test alert (full kit)
  mc reset-budget                  Restart the tool-call and time budget
  mc init ["goal"]                 Create .mission/mission.json here (mc goal does it too)
  mc ui [--port 4747]              Open the live console (full kit)

In the Claude Code chat, type the human commands as /mc: /mc approve a1, /mc say use staging.
Use -- to end flags when text starts with --:  mc say -- "--force is fine here"
`;

export const CHAT_HELP = `Mission Control: type these in the chat
  /mc goal Ship the CSV export --done-when tests pass and a PR is open
  /mc status
  /mc approve a1          /mc deny a1 not on Fridays
  /mc answer q1 Postgres
  /mc say use the staging DB only
  /mc pause               /mc resume
  /mc set maxToolCalls 2000      /mc set maxMinutes 600
  /mc set requireApproval git push, npm publish, terraform apply
  /mc reset-budget        /mc done
A /mc typed while the agent is working waits until the run stops. To send it sooner, press
Esc first (it stops the current step), or run mc in a terminal: it acts at the agent's next tool
call without interrupting it.`;

// Agent-only commands; a human typing them in the chat is told so.
export const AGENT_ONLY = new Set(["now", "log", "ask", "reply"]);
// Flags that never take a value, so `ask --blocking "text"` keeps its text.
const BOOLEAN_FLAGS = new Set(["blocking", "json", "help"]);
export const MAX_TEXT = 4000;

export function parse(argv) {
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

function findItem(arr, id, what) {
  const x = arr.find((i) => i.id === id);
  if (!x) die(`No ${what} with id ${id}.`);
  return x;
}

// run(argv, io): `io.cwd` is where to look for the mission (default: the process's), `io.home` the
// folder to create .mission/ in when there's none, `io.print` and `io.warn` take the output, and
// `io.chat` is true when the human typed it as /mc (then the agent carries on by itself).
export async function run(argv, io = {}) {
  const cwd = io.cwd || process.cwd();
  const print = io.print || ((s) => console.log(s));
  const warn = io.warn || ((s) => process.stderr.write(s + "\n"));
  const continueHint = io.chat ? "" : ' If the agent has already stopped, type "continue" in its session.';
  const homeFile = () => (process.env.MISSION_FILE ? path.resolve(process.env.MISSION_FILE) : path.join(io.home || cwd, ".mission", "mission.json"));
  const need = () => {
    const f = findMissionFile(cwd);
    if (!f) die(io.chat ? 'No mission in this project yet. Start one with /mc goal "what to achieve".' : 'No mission here. Run `mc goal "your goal"` in the project root, or set MISSION_FILE.');
    return f;
  };

  const [cmd, ...rest] = argv;
  const { pos, flags } = parse(rest);
  const fullText = pos.join(" ").trim();
  const text = fullText.slice(0, MAX_TEXT);
  if (fullText.length > MAX_TEXT) warn(`Note: text trimmed to ${MAX_TEXT} characters.`);

  switch (cmd) {
    case undefined: case "help": case "--help": case "-h":
      print(io.chat ? `${CHAT_HELP}\nFrom this project's folder: ${mcCmd()} say "..."` : HELP.trimEnd());
      break;

    case "init": {
      const file = homeFile();
      try { create(file, text); } catch (e) { die(e.message); }
      print(`Created ${path.relative(cwd, file) || file}`);
      break;
    }

    case "brief":
      { const f = need(); print(brief(read(f), f)); }
      break;

    case "status": {
      const m = read(need());
      if (flags.json) { print(JSON.stringify({ ...m, budget: budget(m) }, null, 2)); break; }
      const b = budget(m);
      const lines = [`Goal: ${m.goal.text || "(none)"}${m.goal.done ? "  [DONE]" : ""}`];
      if (m.goal.doneWhen) lines.push(`Done when: ${m.goal.doneWhen}`);
      const state = m.controls.paused ? "paused" : !m.goal.text ? "no goal set" : m.goal.done ? "done" : b.exhausted ? "out of budget" : "running";
      lines.push(`State: ${state} · tool calls ${m.usage.toolCalls}/${m.controls.maxToolCalls || "∞"} · minutes ${Math.round(b.minutes)}/${m.controls.maxMinutes || "∞"}`);
      if (m.status.now) lines.push(`Now: ${m.status.now}`);
      if (m.status.next.length) lines.push(`Next: ${m.status.next.join(" → ")}`);
      for (const q of m.questions.filter((q) => q.answer == null)) lines.push(`? ${q.id}${q.blocking ? " (blocking)" : ""}: ${q.text}${q.options?.length ? `  [${q.options.join(" / ")}]` : ""}`);
      for (const a of m.approvals.filter((a) => a.state === "waiting")) lines.push(`! ${a.id} needs approval: ${a.command}`);
      for (const x of m.inbox.filter((x) => !x.seen)) lines.push(`> ${x.id} unread note: ${x.text}`);
      print(lines.join("\n"));
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
      print("Status updated.");
      break;
    }

    case "log": {
      if (!text) die('Usage: mc log "text" [--kind build]');
      update(need(), (m) => addLog(m, flags.kind && flags.kind !== true ? String(flags.kind) : "note", text));
      print("Logged.");
      break;
    }

    case "ask": {
      if (!text) die('Usage: mc ask "question" [--option A] [--blocking]');
      const file = need();
      const id = update(file, (m) => {
        const id = nextId(m.questions, "q");
        m.questions.unshift({ id, text, options: list(flags.option), blocking: !!flags.blocking, answer: null, askedAt: now() });
        addLog(m, "question", `${id}: ${text}`);
        return id;
      });
      if (flags.blocking) await notify(read(file).controls, `Agent is blocked on ${id}`, text, "high");
      print(`Asked ${id}.${flags.blocking ? " It's blocking: finish what you can, then stop. The human answers and continues the session." : " The answer arrives in your context after a tool call once the human replies."}`);
      break;
    }

    case "reply": {
      const [id, ...words] = pos;
      if (!id || !words.length) die('Usage: mc reply <id> "text"');
      update(need(), (m) => { const x = findItem(m.inbox, id, "note"); x.reply = words.join(" "); x.repliedAt = now(); x.seen = true; });
      print(`Replied to ${id}.`);
      break;
    }

    case "done": {
      const file = need();
      update(file, (m) => { m.goal.done = true; m.goal.doneAt = now(); m.goal.summary = text; syncControlsSeen(m); addLog(m, "done", text || "Goal marked done."); });
      await notify(read(file).controls, "Mission complete", text || "The agent marked the goal done.");
      print("Goal marked done. The run may finish now.");
      break;
    }

    case "goal": {
      if (!text) die(io.chat ? "Usage: /mc goal what to achieve --done-when how you'll know it's done" : 'Usage: mc goal "text" [--done-when "condition"]');
      let file = findMissionFile(cwd);
      const fresh = !file;
      if (fresh) { file = homeFile(); create(file, ""); }
      update(file, (m) => {
        m.goal.text = text; m.goal.done = false; m.goal.doneAt = null; m.goal.summary = "";
        m.goal.doneWhen = flags["done-when"] && flags["done-when"] !== true ? String(flags["done-when"]) : "";
        resetUsage(m);
        // Approvals asked for under the old goal don't carry over.
        for (const a of m.approvals) if (a.state === "waiting") { a.state = "expired"; a.decidedAt = now(); a.decisionSeen = false; addLog(m, "approval", `${a.id} expired with the old goal: ${a.command}`); }
        addLog(m, "goal", `Goal set: ${text}`);
      });
      print(`${fresh ? `Mission created in ${path.relative(cwd, path.dirname(file)) || path.dirname(file)}/ (git-ignored). ` : ""}Goal set. The budget starts from zero.`);
      break;
    }

    case "say": {
      if (!text) die(io.chat ? "Usage: /mc say your note for the agent" : 'Usage: mc say "note for the agent"');
      const id = update(need(), (m) => { const id = nextId(m.inbox, "m"); m.inbox.unshift({ id, text, at: now(), seen: false }); return id; });
      print(io.chat ? `Sent ${id}.` : `Sent ${id}. The agent sees it after its next tool call.`);
      break;
    }

    case "answer": {
      const [id, ...words] = pos;
      if (!id || !words.length) die(io.chat ? "Usage: /mc answer <id> your answer" : 'Usage: mc answer <id> "text"');
      update(need(), (m) => { const q = findItem(m.questions, id, "question"); q.answer = words.join(" ").slice(0, MAX_TEXT); q.answeredAt = now(); q.answerSeen = false; addLog(m, "answer", `${id}: ${q.answer}`); });
      print(`Answered ${id}.${continueHint}`);
      break;
    }

    case "approve": case "deny": {
      const [id, ...words] = pos;
      if (!id) die(`Usage: ${io.chat ? "/" : ""}mc ${cmd} <id>`);
      const command = update(need(), (m) => {
        const a = findItem(m.approvals, id, "approval");
        a.state = cmd === "approve" ? "approved" : "denied"; a.note = words.join(" "); a.decidedAt = now(); a.decisionSeen = false;
        addLog(m, "approval", `${id} ${a.state}: ${a.command}`);
        return a.command;
      });
      print(`${id} ${cmd === "approve" ? "approved" : "denied"}: ${command}${continueHint}`);
      break;
    }

    case "pause": case "resume": {
      update(need(), (m) => { m.controls.paused = cmd === "pause"; addLog(m, "control", cmd === "pause" ? "Paused by the human." : "Resumed by the human."); });
      print(cmd === "pause" ? "Paused. The agent is stopped at its next tool call." : `Resumed.${continueHint}`);
      break;
    }

    case "set": {
      const [key, ...vals] = pos;
      const value = vals.join(" ");
      const numeric = ["maxToolCalls", "maxMinutes", "maxStopBlocks"];
      if (!key || (!value && key !== "notes")) die(`Usage: ${io.chat ? "/" : ""}mc set <control> <value>`);
      update(need(), (m) => {
        if (numeric.includes(key)) { const n = Number(value); if (!Number.isFinite(n) || n < 0) die(`${key} must be a number ≥ 0 (0 = no limit).`); m.controls[key] = n; }
        else if (key === "requireApproval") m.controls.requireApproval = value.split(",").map((s) => s.trim()).filter(Boolean);
        else if (key === "notes") m.controls.notes = value;
        else if (key === "ntfy" || key === "desktop") die("Alerts are part of the full kit, not the free plugin.");
        else die(`Unknown control "${key}". Try: ${[...numeric, "requireApproval", "notes", "ntfy", "desktop"].join(", ")}`);
        addLog(m, "control", `${key} set to ${value || "(empty)"}`);
      });
      print(`${key} updated.`);
      break;
    }

    case "test-alert": {
      print(io.chat ? "Not in the free plugin: alerts are part of the full kit (see the README)." : "Desktop and phone alerts are in the full kit: https://buy.polar.sh/polar_cl_XzIYl3hBPBQKZT8p4Sn31PRBKXB7LYpEE45zi3KltXp");
      break;
    }

    case "reset-budget": {
      update(need(), (m) => { resetUsage(m); addLog(m, "control", "Budget restarted."); });
      print("Budget restarted.");
      break;
    }

    case "ui": {
      print(io.chat ? "Not in the free plugin: the live console is part of the full kit (see the README)." : "The live console (GO/NO-GO buttons, answers, budgets, phone alerts) is in the full kit: https://buy.polar.sh/polar_cl_XzIYl3hBPBQKZT8p4Sn31PRBKXB7LYpEE45zi3KltXp");
      break;
    }

    default:
      die(`Unknown command "${cmd}". ${io.chat ? "Type /mc help." : "Run `mc help`."}`);
  }
}
