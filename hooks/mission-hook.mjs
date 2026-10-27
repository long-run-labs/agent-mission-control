#!/usr/bin/env node
// One Claude Code hook for every event. install.mjs registers it for SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse, PostToolUseFailure and Stop. With no .mission/mission.json in the project
// it does nothing. If it can't read the mission state, PreToolUse fails closed (tools are refused with
// the reason) and the human sees a system message; other events let the session carry on.
import path from "node:path";
import { findMissionFile, read, update, budget, matchesPattern, nextId, addLog, goalActive } from "../lib/store.mjs";
import { brief, news, markNewsSeen, mcCmd } from "../lib/brief.mjs";
import { notify } from "../lib/notify.mjs";

// mc subcommands the agent may run at any time, even on hold or out of budget. The rest are the human's.
const AGENT_COMMANDS = new Set(["brief", "status", "now", "log", "ask", "reply", "done", "help", "--help", "-h"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Alerts raised while handling the event; sent (awaited, at most 4 s each) before the answer is written.
const alerts = [];
// Sends each distinct alert once, until something changes (the human acts or the run continues).
// Returns true when this is a new alert, so callers can log it once too.
function alertOnce(m, key, title, message, priority = "high") {
  if (m.usage.lastAlert === key) return false;
  m.usage.lastAlert = key;
  alerts.push([title, message, priority]);
  return true;
}
const caseInsensitiveFs = process.platform === "darwin" || process.platform === "win32";
const samePath = (a, b) => (caseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b);

const context = (event, text) => (text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null);
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

// Splits a shell command into words. Returns null if it contains anything that could run a second
// command: ; & | < > newlines or backticks anywhere, or $( outside single quotes.
export function shellWords(cmd) {
  const words = [];
  let cur = "", inWord = false, quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "`" || (c === "$" && cmd[i + 1] === "(")) return null;
      // As in bash, a backslash inside double quotes escapes only $ ` " \ and newline; elsewhere it's literal (Windows paths).
      else if (c === "\\" && "$`\"\\\n".includes(cmd[i + 1] ?? "")) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; inWord = true; continue; }
    if (c === "\n" || c === "\r" || ";&|<>`".includes(c) || (c === "$" && cmd[i + 1] === "(")) return null;
    if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ""; inWord = false; } continue; }
    cur += c; inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(cur);
  return words;
}

// The mc subcommand when `cmd` is exactly one `node <this project's .mission/bin/mc.mjs> …` invocation,
// else null. A trailing `2>&1` or `>/dev/null` is allowed; any other redirection or chaining isn't.
export function mcInvocation(cmd, cwd, missionDir) {
  const bare = cmd.replace(/(\s+(2>&1|2?>\s*\/dev\/null))+\s*$/, "");
  const w = shellWords(bare);
  if (!w || w.length < 2) return null;
  if (!/(^|[\\/])node(\.exe)?$/i.test(w[0])) return null;
  if (!samePath(path.resolve(cwd || process.cwd(), w[1]), path.join(missionDir, "bin", "mc.mjs"))) return null;
  return w[2] || "help";
}

const mentionsMission = (s) => /(^|[^\w.-])\.mission([\\/]|(?=[\s"';|&)]|$))/.test(s);
function insideMission(p, cwd, missionDir) {
  if (!p) return false;
  const abs = path.resolve(cwd || process.cwd(), String(p));
  return samePath(abs, missionDir) || samePath(abs.slice(0, missionDir.length + 1), missionDir + path.sep);
}

async function stdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

export function handle(input, file) {
  const event = input.hook_event_name;
  const now = new Date().toISOString();
  const MC = mcCmd(file);

  if (event === "SessionStart") {
    return update(file, (m) => {
      if (!m.usage.startedAt) m.usage.startedAt = now;
      m.usage.sessions += 1;
      const text = brief(m, file);
      markNewsSeen(m);
      return context("SessionStart", text);
    });
  }

  if (event === "UserPromptSubmit") {
    return update(file, (m) => {
      m.usage.stopBlocks = 0; // the human is here; reset the auto-continue counter
      m.usage.lastAlert = null;
      const text = news(m);
      markNewsSeen(m);
      return context("UserPromptSubmit", text);
    });
  }

  if (event === "PreToolUse") {
    const tool = input.tool_name;
    const cmd = tool === "Bash" ? String(input.tool_input?.command || "") : "";
    const missionDir = path.dirname(file);
    const sub = cmd ? mcInvocation(cmd, input.cwd, missionDir) : null;
    if (sub) {
      if (AGENT_COMMANDS.has(sub)) return null;
      return deny(`\`mc ${sub}\` is for the human, not the agent. If you need it, ask: ${MC} ask "..."`);
    }
    if (cmd && mentionsMission(cmd)) {
      return deny(`Leave .mission/ alone: it holds Mission Control's state. To report, ask or read status, run ${MC} <command> on its own, not chained with other commands.`);
    }
    if (EDIT_TOOLS.has(tool) && insideMission(input.tool_input?.file_path || input.tool_input?.notebook_path, input.cwd, missionDir)) {
      return deny(`.mission/ holds Mission Control's state; don't edit it. Use ${MC} instead.`);
    }
    const m = read(file);
    if (m.controls.paused) {
      return deny(`Paused by the human in Mission Control. Don't start new work. Record where you are with ${MC} now "...", then stop and wait.`);
    }
    if (goalActive(m)) {
      const b = budget(m);
      if (b.exhausted) {
        const why = b.overCalls ? `${m.usage.toolCalls}/${m.controls.maxToolCalls} tool calls` : `${Math.round(b.minutes)}/${m.controls.maxMinutes} minutes`;
        return deny(`Mission budget used up (${why}). Record status with ${MC} now "...", then stop. Only the human can extend the budget: they can raise it in Mission Control or run mc reset-budget in their own terminal.`);
      }
    }
    if (!cmd) return null;
    const pattern = m.controls.requireApproval.find((p) => matchesPattern(cmd, p));
    if (!pattern) return null;
    return update(file, (m2) => {
      const same = m2.approvals.filter((a) => a.command === cmd && !a.used);
      if (same.some((a) => a.state === "approved")) return null; // marked used once it has run (PostToolUse)
      const denied = same.find((a) => a.state === "denied");
      if (denied) {
        denied.used = true;
        return deny(`The human denied ${denied.id}${denied.note ? `: ${denied.note}` : ""}. Don't retry it; find another way or ask.`);
      }
      const waiting = same.find((a) => a.state === "waiting");
      if (waiting) return deny(`Still waiting for the human to approve ${waiting.id}. Continue with other work; you'll be told when it's decided.`);
      const id = nextId(m2.approvals, "a");
      m2.approvals.unshift({ id, command: cmd, pattern, reason: String(input.tool_input?.description || ""), state: "waiting", at: now });
      addLog(m2, "approval", `Asked for approval ${id}: ${cmd}`);
      alerts.push([`Agent needs a GO (${id})`, cmd, "high"]);
      return deny(`This command matches "${pattern}", which needs the human's approval. Queued as ${id} in Mission Control. Continue with other work; you'll be told when it's decided.`);
    });
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    return update(file, (m) => {
      if (!m.usage.startedAt) m.usage.startedAt = now; // a goal set mid-session starts its clock here
      m.usage.toolCalls += 1;
      // The human approved one run: it's spent whether that run succeeded or failed.
      if (input.tool_name === "Bash") {
        const cmd = String(input.tool_input?.command || "");
        const ran = m.approvals.find((a) => a.state === "approved" && !a.used && a.command === cmd);
        if (ran) { ran.used = true; ran.usedAt = now; addLog(m, "approval", `${event === "PostToolUseFailure" ? "Approved command failed" : "Ran approved command"} ${ran.id}: ${cmd}`); }
      }
      if (event === "PostToolUseFailure") return null; // counted; news waits for the next successful call
      const text = news(m);
      if (text) markNewsSeen(m);
      return context("PostToolUse", text);
    });
  }

  if (event === "Stop") {
    return update(file, (m) => {
      if (!goalActive(m) || m.controls.paused) return null;
      const b = budget(m);
      if (b.exhausted) {
        if (alertOnce(m, "budget", "Agent stopped: budget used up", "Raise the budget in Mission Control or run mc reset-budget, then tell the agent to continue.")) addLog(m, "budget", "Run stopped: budget used up.");
        return null;
      }
      const text = news(m);
      const blocking = m.questions.filter((q) => q.blocking && q.answer == null);
      if (blocking.length && !text) { // waiting on the human
        alertOnce(m, `blocking:${blocking[0].id}`, `Agent is waiting on you (${blocking[0].id})`, blocking[0].text);
        return null;
      }
      if (m.usage.stopBlocks >= m.controls.maxStopBlocks) {
        addLog(m, "budget", `Run stopped: reached ${m.controls.maxStopBlocks} automatic continues.`);
        alertOnce(m, "maxStops", "Agent stopped", `Reached ${m.controls.maxStopBlocks} automatic continues without finishing.`);
        return null;
      }
      // Pushed on last time and did nothing since: it's stuck, so let it stop rather than loop.
      if (input.stop_hook_active && !text && m.usage.toolCalls === m.usage.toolCallsAtLastBlock) {
        addLog(m, "budget", "Run stopped: no progress after an automatic continue.");
        alertOnce(m, "stuck", "Agent stopped: no progress", m.status.now || m.goal.text);
        return null;
      }
      m.usage.stopBlocks += 1;
      m.usage.toolCallsAtLastBlock = m.usage.toolCalls;
      m.usage.lastAlert = null;
      markNewsSeen(m);
      const next = m.status.next.length ? ` Planned next: ${m.status.next.join(" → ")}.` : "";
      const reason = [
        `The mission isn't done yet: ${m.goal.text}.${m.goal.doneWhen ? ` Done when: ${m.goal.doneWhen}.` : ""}${next}`,
        text,
        `Keep going. If the goal is met, run ${MC} done "summary". If you can't continue without the human, run ${MC} ask "..." --blocking and then stop. (Automatic continue ${m.usage.stopBlocks}/${m.controls.maxStopBlocks}.)`,
      ].filter(Boolean).join("\n");
      return { decision: "block", reason };
    });
  }

  return null;
}

// What to answer when the mission state can't be read or written.
export function failure(input, error, file) {
  const msg = `Mission Control: ${error.message}`;
  if (input.hook_event_name !== "PreToolUse") return { systemMessage: msg };
  const cmd = input.tool_name === "Bash" ? String(input.tool_input?.command || "") : "";
  const sub = cmd && file ? mcInvocation(cmd, input.cwd, path.dirname(file)) : null;
  if (sub && AGENT_COMMANDS.has(sub)) return { systemMessage: msg }; // let mc run; it reports the same problem
  return {
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Mission Control can't read its state, so it's refusing tools to stay safe: ${error.message} Tell the human; they need to fix .mission/mission.json.`,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("hooks", "mission-hook.mjs"));
if (isMain) {
  let out = null, input = {};
  try {
    const raw = await stdin();
    input = raw.trim() ? JSON.parse(raw) : {};
    const file = findMissionFile(input.cwd || process.cwd());
    if (file) {
      try {
        out = handle(input, file);
      } catch (e) {
        out = failure(input, e, file);
      }
      if (alerts.length) {
        let controls = null;
        try { ({ controls } = read(file)); } catch {}
        if (controls) for (const a of alerts) await notify(controls, ...a);
      }
    }
  } catch (e) {
    out = { systemMessage: `Mission Control: ${e.message}` };
  }
  // Exit only after stdout has drained; a large answer to a pipe would otherwise be cut off.
  process.stdout.write(out ? JSON.stringify(out) : "", () => process.exit(0));
}
