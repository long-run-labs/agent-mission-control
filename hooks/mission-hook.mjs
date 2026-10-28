#!/usr/bin/env node
// One Claude Code hook for every event: SessionStart, UserPromptExpansion, UserPromptSubmit,
// PreToolUse, PostToolUse, PostToolUseFailure and Stop. It runs from the plugin (hooks/hooks.json) or from a project install
// (install.mjs). With no .mission/mission.json in the project it does nothing, except apply a /mc
// command the human types. If it can't read the mission state, PreToolUse fails closed (tools are
// refused with the reason) and the human sees a system message; other events let the session carry on.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findMissionFile, read, update, budget, matchesPattern, nextId, addLog, goalActive } from "../lib/store.mjs";
import { brief, news, markNewsSeen, mcCmd, MC_FILE } from "../lib/brief.mjs";
import { run, AGENT_ONLY } from "../lib/commands.mjs";
import { notify } from "../lib/notify.mjs";

// mc subcommands the agent may run at any time, even on hold or out of budget. The rest are the human's.
const AGENT_COMMANDS = new Set(["brief", "status", "now", "log", "ask", "reply", "done", "help", "--help", "-h"]);
// What the human types in the chat: /mc …, or /agent-mission-control:mc … when another /mc exists.
const MC_PROMPT = /^\/(?:agent-mission-control:)?mc(?:\s+([\s\S]*))?$/;
// A /mc that changes something. Only a person typing it applies it (see humanTyped); anywhere else
// (a Bash line that starts a nested `claude -p`, a scheduled prompt, a file) it's refused.
const MC_HUMAN = /(^|[\s"'`(;|&=])\/(?:agent-mission-control:)?mc\s+(approve|deny|answer|say|pause|resume|set|reset-budget|goal|done|init)\b/i;
const MC_READ_ONLY = new Set(["", "status", "help", "--help", "-h", "brief"]);
// Tools whose input can become a prompt: run a command, schedule one, or reach another agent.
const PROMPT_TOOLS = new Set(["Bash", "CronCreate", "ScheduleWakeup", "SendMessage", "RemoteTrigger", "Task", "Agent"]);
const EDIT_TEXT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// Starting another Claude Code session mid-mission: it would run outside this one's checks.
const NESTED_CLAUDE_PATTERN = "claude (a nested Claude Code session)";
// Words that run the command after them, so `env -u X claude` or `bash -c "claude …"` start claude too.
const WRAPPERS = new Set(["env", "sudo", "exec", "nohup", "time", "command", "nice", "timeout", "stdbuf", "bash", "sh", "zsh"]);
const FLAG_WITH_VALUE = /^(-u|--unset|-C|--chdir|-n|-s|--signal|-k|--kill-after)$/;
// True when some command in the line starts claude (not when "claude" is just an argument, as in grep).
export function startsClaude(cmd) {
  for (const seg of plainText(cmd).split(/[;&|()`\n]|\$\(/)) {
    const w = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < w.length) {
      if (/^[A-Za-z_]\w*=/.test(w[i]) || WRAPPERS.has(w[i])) { i++; continue; }  // VAR=value, or a wrapper
      if (i > 0 && w[i].startsWith("-")) { i += FLAG_WITH_VALUE.test(w[i]) ? 2 : 1; continue; } // a wrapper's flag
      if (i > 0 && /^\d+[smhd]?$/.test(w[i])) { i++; continue; }                     // timeout's duration
      break;
    }
    if (i < w.length && /(^|\/)claude$/.test(w[i])) return true;
  }
  return false;
}
// Quotes and backslashes removed, so '/mc'' approve' or /m\c can't slip a command past the checks.
const plainText = (t) => String(t).replace(/["'`\\]/g, "");
// A /mc the human typed: Claude Code expanded it as a slash command (UserPromptExpansion), in a session a
// person is attending. A scheduled prompt arrives as plain text and doesn't expand; a nested `claude -p`
// started by the agent expands, but runs unattended.
const isMcCommand = (input) => /^(agent-mission-control:)?mc$/.test(String(input.command_name || ""));
const attended = () => process.env.CLAUDE_CODE_SESSION_ATTENDED === "1";
// Every string inside a tool's input, so a /mc can't hide in a nested field.
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}
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
// Symlinks resolved, so /tmp and /private/tmp (or a symlinked checkout) compare equal.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

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

// The mc subcommand when `cmd` is exactly one `node <the mc.mjs beside this hook> …` invocation, else
// null. A trailing `2>&1` or `>/dev/null` is allowed; any other redirection or chaining isn't.
export function mcInvocation(cmd, cwd) {
  const bare = cmd.replace(/(\s+(2>&1|2?>\s*\/dev\/null))+\s*$/, "");
  const w = shellWords(bare);
  if (!w || w.length < 2) return null;
  if (!/(^|[\\/])node(\.exe)?$/i.test(w[0])) return null;
  if (!samePath(real(path.resolve(cwd || process.cwd(), w[1])), real(MC_FILE))) return null;
  return w[2] || "help";
}

const MISSION_RE = new RegExp(String.raw`(^|[^\w.-])\.mission([\\/]|(?=[\s"';|&)]|$))`, caseInsensitiveFs ? "i" : "");
const mentionsMission = (s) => MISSION_RE.test(s);
function insideMission(p, cwd, missionDir) {
  if (!p) return false;
  const abs = path.resolve(cwd || process.cwd(), String(p));
  return samePath(abs, missionDir) || samePath(abs.slice(0, missionDir.length + 1), missionDir + path.sep);
}

// Splits what the human typed after /mc into words, honoring quotes. Nothing is executed, so any
// character is fine. Each word carries the offset where it ends, for commands that take raw text.
export function chatWords(s) {
  const words = [];
  let cur = "", inWord = false, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if ((c === '"' || c === "'") && !inWord) { quote = c; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) { words.push({ word: cur, end: i }); cur = ""; inWord = false; } continue; }
    cur += c; inWord = true;
  }
  if (inWord) words.push({ word: cur, end: s.length });
  return words;
}
const unquote = (s) => { const m = /^(["'])([\s\S]*)\1$/.exec(s); return m && !m[2].includes(m[1]) ? m[2] : s; };

// The mc argv for a /mc line. Notes, answers and reasons are taken as typed (quotes, $, backticks
// and all); the other commands are split into words.
export function chatArgv(rest) {
  const words = chatWords(rest);
  const sub = words[0]?.word;
  const after = (n) => unquote(rest.slice(words[n - 1]?.end ?? rest.length).trim());
  const withText = (argv, t) => (t ? [...argv, "--", t] : argv);
  switch (sub) {
    case "say": return withText(["say"], after(1));
    case "answer": case "deny": return words.length > 1 ? withText([sub, words[1].word], after(2)) : [sub];
    case "set": return words.length > 1 ? withText(["set", words[1].word], after(2)) : ["set"];
    case "goal": {
      const raw = after(1);
      const m = /^([\s\S]*?)\s*--done-when\s+([\s\S]*)$/.exec(raw);
      return m ? withText(["goal", "--done-when", unquote(m[2].trim())], unquote(m[1].trim())) : withText(["goal"], raw);
    }
    default: return words.map((w) => w.word);
  }
}

// Applies a /mc line the human typed, then hands the agent the result and anything else new.
async function chatCommand(input, file, rest) {
  const cwd = input.cwd || process.cwd();
  const argv = chatArgv(rest);
  const sub = argv[0] || "help";
  const out = [];
  if (AGENT_ONLY.has(sub)) out.push(`\`mc ${sub}\` is the agent's command. Type /mc help for yours.`);
  else {
    const io = { cwd, home: process.env.CLAUDE_PROJECT_DIR || cwd, print: (t) => out.push(t), warn: (t) => out.push(t), chat: true };
    try { await run(argv, io); } catch (e) { out.push(e.usage ? e.message : `Mission Control: ${e.message}`); }
  }
  file ||= findMissionFile(cwd); // /mc goal may have just created it
  const parts = [`Mission Control: the human typed \`/mc${rest ? " " + rest.slice(0, 300) : ""}\`. It's already applied; don't run mc for it.`, "Result:", out.join("\n") || "(done)"];
  // Read-only answers to a session nobody is attending change nothing, so the human's news waits for them.
  if (file && attended()) {
    try {
      parts.push(update(file, (m) => {
        m.usage.stopBlocks = 0; // the human is here; reset the auto-continue counter
        m.usage.lastAlert = null;
        m.usage.lastTypedPrompt = input.prompt_id || null; // so UserPromptSubmit knows this one was typed
        const text = sub === "goal" || sub === "init" ? brief(m) : news(m);
        markNewsSeen(m);
        return text;
      }));
    } catch (e) { parts.push(`Mission Control: ${e.message}`); }
  }
  return context("UserPromptExpansion", parts.filter(Boolean).join("\n"));
}

async function stdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

export async function handle(input, file) {
  const event = input.hook_event_name;
  const now = new Date().toISOString();
  const MC = mcCmd();

  if (event === "UserPromptExpansion") {
    if (!isMcCommand(input)) return null;
    const rest = String(input.command_args || "").trim();
    const sub = chatWords(rest)[0]?.word || "";
    if (!attended() && !MC_READ_ONLY.has(sub)) {
      return { decision: "block", reason: "Mission Control: /mc changes only work in a session a person is attending, not in claude -p or a script. Nothing was changed. From a terminal, use mc instead." };
    }
    return chatCommand(input, file, rest);
  }
  if (!file) return null;

  if (event === "SessionStart") {
    return update(file, (m) => {
      if (!m.usage.startedAt) m.usage.startedAt = now;
      m.usage.sessions += 1;
      const text = brief(m);
      markNewsSeen(m);
      return context("SessionStart", text);
    });
  }

  if (event === "UserPromptSubmit") {
    const prompt = String(input.prompt || "").trim();
    // A /mc the human typed was applied at UserPromptExpansion. The same text arriving here without
    // expanding came from a scheduled task or a script: say so, and change nothing.
    return update(file, (m) => {
      const plain = MC_PROMPT.test(prompt) && MC_HUMAN.test(prompt) && !(input.prompt_id && input.prompt_id === m.usage.lastTypedPrompt);
      m.usage.stopBlocks = 0; // a prompt arrived; reset the auto-continue counter
      m.usage.lastAlert = null;
      const text = news(m);
      markNewsSeen(m);
      const note = plain ? "Mission Control: that /mc arrived as plain text (from a scheduled task or a script, not typed by the human), so it was NOT applied. Only the human typing /mc in this chat, or running mc in a terminal, changes the mission." : "";
      return context("UserPromptSubmit", [note, text].filter(Boolean).join("\n"));
    });
  }

  if (event === "PreToolUse") {
    const tool = input.tool_name;
    const cmd = tool === "Bash" ? String(input.tool_input?.command || "") : "";
    const missionDir = path.dirname(file);
    const sub = cmd ? mcInvocation(cmd, input.cwd) : null;
    if (sub) {
      if (AGENT_COMMANDS.has(sub)) return null; // the agent's own mc may mention /mc (e.g. in a question)
      return deny(`\`mc ${sub}\` is for the human, not the agent (they type /mc ${sub} in the chat). If you need it, ask: ${MC} ask "..."`);
    }
    // A /mc human command sent another way: a nested session, a schedule, a message to another agent,
    // or a script that starts claude with one. Docs and commit messages that only mention /mc are fine.
    const texts = strings(input.tool_input).map(plainText);
    const sendsMc = PROMPT_TOOLS.has(tool) || tool.startsWith("mcp__") ? texts.some((t) => MC_HUMAN.test(t))
      : EDIT_TEXT_TOOLS.has(tool) && texts.some((t) => MC_HUMAN.test(t) && /(^|[\s;&|(\/])claude(?=\s|$)/m.test(t));
    const loneCommit = cmd && /^\s*git\s+commit\b/.test(cmd) && !/[;&|`\n]|\$\(/.test(cmd); // a message may mention /mc
    if (sendsMc && !loneCommit) {
      return deny("That would send a /mc command as if the human typed it. Only the human can steer Mission Control. If you need a decision, ask: " + mcCmd() + ' ask "..."');
    }
    if (cmd && /mc\.mjs|commands\.mjs|store\.mjs/i.test(cmd)) {
      return deny(`Run mc on its own, exactly as the brief gives it: ${MC} <command> …, with nothing chained, piped or redirected.`);
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
        return deny(`Mission budget used up (${why}). Record status with ${MC} now "...", then stop. Only the human can extend the budget: they can type /mc reset-budget or /mc set maxToolCalls … in the chat.`);
      }
    }
    if (!cmd) return null;
    const pattern = m.controls.requireApproval.find((p) => matchesPattern(cmd, p)) || (startsClaude(cmd) ? NESTED_CLAUDE_PATTERN : null);
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
      return deny(`This command matches "${pattern}", which needs the human's approval. Queued as ${id} in Mission Control. Continue with other work; you'll be told when it's decided. If nothing else can be done until then, stop. Don't ask a separate question about it: ${id} already asks.`);
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
        if (alertOnce(m, "budget", "Agent stopped: budget used up", "Type /mc reset-budget in the agent's session (or raise the budget in Mission Control), then tell it to continue.")) addLog(m, "budget", "Run stopped: budget used up.");
        return null;
      }
      const text = news(m);
      const blocking = m.questions.filter((q) => q.blocking && q.answer == null);
      const held = m.approvals.filter((a) => a.state === "waiting");
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
      // A held command gets the same treatment: pushed on once (there may be other work), then allowed to stop.
      if (input.stop_hook_active && !text && m.usage.toolCalls === m.usage.toolCallsAtLastBlock) {
        if (held.length) {
          if (alertOnce(m, `held:${held[0].id}`, `Agent is waiting for your GO (${held[0].id})`, held[0].command)) addLog(m, "approval", `Run stopped: waiting for your GO on ${held[0].id}.`);
        } else {
          addLog(m, "budget", "Run stopped: no progress after an automatic continue.");
          alertOnce(m, "stuck", "Agent stopped: no progress", m.status.now || m.goal.text);
        }
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
        held.length ? `Held for the human: ${held.map((a) => `${a.id} \`${a.command}\``).join(", ")}. Do other work toward the goal meanwhile; if nothing is left until it's decided, stop, without asking a separate question.` : "",
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
  const sub = cmd ? mcInvocation(cmd, input.cwd) : null;
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

// A project install (manual or the kit) puts its own copy of this hook in .mission/hooks/. When this
// copy runs from the plugin and the project has one, the project's copy is in charge, so nothing
// runs twice.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function stepAside(file) {
  if (!file) return false;
  const missionDir = path.dirname(file);
  if (samePath(real(ROOT), real(missionDir)) || !fs.existsSync(path.join(missionDir, "hooks", "mission-hook.mjs"))) return false;
  // Only when the project's settings actually run that copy; a stray file must not switch the checks off.
  const settingsDir = path.join(path.dirname(missionDir), ".claude");
  return ["settings.json", "settings.local.json"].some((f) => {
    try { return fs.readFileSync(path.join(settingsDir, f), "utf8").includes(".mission/hooks/mission-hook.mjs"); } catch { return false; }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("hooks", "mission-hook.mjs"));
if (isMain) {
  let out = null, input = {};
  try {
    const raw = await stdin();
    input = raw.trim() ? JSON.parse(raw) : {};
    const file = findMissionFile(input.cwd || process.cwd());
    const typedMc = input.hook_event_name === "UserPromptExpansion" && isMcCommand(input);
    if ((file || typedMc) && !stepAside(file)) {
      try {
        out = await handle(input, file);
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
