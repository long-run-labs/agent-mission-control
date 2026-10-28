// What the agent is told. The hooks inject these strings into Claude's context; `mc brief` prints them.
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { budget, goalActive } from "./store.mjs";

const MAX_NEWS = 8000; // characters of human news injected per tool call; the rest waits for the next one

// The mc command line that ships beside this file: <plugin>/cli/mc.mjs, or .mission/cli/mc.mjs for a
// project install. Absolute, so it works from any subfolder. Forward slashes work for Node on every
// platform and survive shell quoting on Windows too.
export const MC_FILE = fileURLToPath(new URL("../cli/mc.mjs", import.meta.url));
export const mcCmd = () => `node "${MC_FILE.replace(/\\/g, "/")}"`;

export function protocol() {
  const MC = mcCmd();
  return [
    "Mission Control protocol (a human is steering this run through Mission Control):",
    `- After each meaningful step: ${MC} now "what you're doing" --next "next step" --next "after that"`,
    `- Log results worth keeping: ${MC} log "what happened" --kind build|test|research|decision`,
    `- Need a decision? ${MC} ask "question" --option "A" --option "B" [--blocking]. Use --blocking only if you can't continue without it, then stop.`,
    `- Reply to a human note: ${MC} reply <id> "your reply"`,
    `- Goal met? ${MC} done "one-line summary". Only then are you allowed to finish.`,
    "- Run mc commands on their own, never chained with other commands. Leave the .mission/ folder alone.",
    "- Messages from the human arrive in your context between tool calls. They override your plan.",
    "- The human steers with /mc in this chat (or mc in a terminal). A message starting \"Mission Control: the human typed\" is a command they already applied.",
  ].join("\n");
}

function controlsHash(m) {
  const { goal, controls } = m;
  return crypto.createHash("sha1").update(JSON.stringify({ g: [goal.text, goal.doneWhen, goal.done], c: controls })).digest("hex").slice(0, 12);
}

function controlsLine(m) {
  const c = m.controls, u = m.usage, b = budget(m);
  const parts = [];
  if (c.paused) parts.push("PAUSED by the human");
  parts.push(`tool calls ${u.toolCalls}/${c.maxToolCalls || "∞"}`);
  parts.push(`minutes ${Math.round(b.minutes)}/${c.maxMinutes || "∞"}`);
  if (c.requireApproval.length) parts.push(`needs approval: ${c.requireApproval.join(", ")}`);
  return parts.join(" · ");
}

// The human's items the agent hasn't seen yet, oldest first, within the size cap.
function pending(m) {
  const items = [];
  for (const x of [...m.inbox].reverse().filter((x) => !x.seen)) items.push({ kind: "inbox", x, line: `- Human note [${x.id}]: ${x.text}` });
  for (const q of m.questions.filter((q) => q.answer != null && !q.answerSeen)) items.push({ kind: "answer", x: q, line: `- Answer to ${q.id} ("${q.text}"): ${q.answer}` });
  for (const a of m.approvals.filter((a) => a.state !== "waiting" && !a.decisionSeen)) {
    items.push({ kind: "approval", x: a, line: `- Approval ${a.id} ${a.state.toUpperCase()}: \`${a.command}\`${a.note ? ` (${a.note})` : ""}${a.state === "approved" ? " — you may run it now, exactly as written, on its own." : ""}` });
  }
  if (m.usage.lastControlsSeen && m.usage.lastControlsSeen !== controlsHash(m)) {
    items.push({ kind: "controls", line: `- Controls changed. Goal: ${m.goal.text || "(none)"}${m.goal.doneWhen ? ` — done when ${m.goal.doneWhen}` : ""}${m.goal.done ? " (marked done)" : ""}. ${controlsLine(m)}${m.controls.notes ? `. Standing notes: ${m.controls.notes}` : ""}` });
  }
  const shown = [];
  let size = 0;
  for (const it of items) {
    const line = it.line.length > MAX_NEWS ? it.line.slice(0, MAX_NEWS - 40) + " …(cut; run mc status)" : it.line;
    if (shown.length && size + line.length > MAX_NEWS) break;
    shown.push({ ...it, line });
    size += line.length;
  }
  return { shown, more: items.length - shown.length };
}

// Records the current goal and controls as already known to the agent, so the agent's own
// changes (like `mc done`) don't come back to it as news from the human.
export function syncControlsSeen(m) {
  m.usage.lastControlsSeen = controlsHash(m);
}

// Everything new from the human since the agent last looked. Empty string when nothing is new.
export function news(m) {
  const { shown, more } = pending(m);
  if (!shown.length) return "";
  const lines = ["Mission Control: new from the human since your last step", ...shown.map((s) => s.line)];
  if (more) lines.push(`- …and ${more} more, delivered after your next tool call.`);
  return lines.join("\n");
}

// Marks what news() just showed as seen. Returns true when something from the human was seen.
export function markNewsSeen(m) {
  const { shown } = pending(m);
  const now = new Date().toISOString();
  let human = false;
  for (const s of shown) {
    if (s.kind === "inbox") { s.x.seen = true; s.x.seenAt = now; human = true; }
    else if (s.kind === "answer") { s.x.answerSeen = true; human = true; }
    else if (s.kind === "approval") { s.x.decisionSeen = true; human = true; }
  }
  const h = controlsHash(m);
  if (m.usage.lastControlsSeen !== h) { if (m.usage.lastControlsSeen) human = true; m.usage.lastControlsSeen = h; }
  if (human) { m.usage.stopBlocks = 0; m.usage.lastAlert = null; }
  return human;
}

export function brief(m) {
  const out = ["# Mission brief (.mission/mission.json)"];
  out.push(`Goal: ${m.goal.text || "(none set)"}`);
  if (!m.goal.text) out.push("No goal is set, so Mission Control won't keep this run going. The human sets one with `mc goal`.");
  if (m.goal.doneWhen) out.push(`Done when: ${m.goal.doneWhen}`);
  if (m.goal.done) out.push(`Goal is marked DONE${m.goal.summary ? `: ${m.goal.summary}` : ""}.`);
  if (goalActive(m) || m.controls.paused) out.push(`Controls: ${controlsLine(m)}`);
  if (m.controls.notes) out.push(`Standing notes from the human: ${m.controls.notes.slice(0, 2000)}`);
  const s = m.status;
  if (s.now || s.next.length) {
    out.push(`Last status: ${s.phase ? `[${s.phase}] ` : ""}${s.now}`);
    if (s.next.length) out.push(`Planned next: ${s.next.join(" → ")}`);
  }
  const open = m.questions.filter((q) => q.answer == null).slice(0, 10);
  if (open.length) out.push(`Open questions to the human: ${open.map((q) => `${q.id}${q.blocking ? " (blocking)" : ""} "${q.text}"`).join("; ")}`);
  const waiting = m.approvals.filter((a) => a.state === "waiting").slice(0, 10);
  if (waiting.length) out.push(`Waiting for approval: ${waiting.map((a) => `${a.id} \`${a.command}\``).join("; ")}`);
  const recent = m.log.slice(0, 5);
  if (recent.length) out.push("Recent log:\n" + recent.map((l) => `- ${String(l.at).slice(0, 16).replace("T", " ")} ${l.kind}: ${String(l.text).slice(0, 300)}`).join("\n"));
  const n = news(m);
  if (n) out.push(n);
  out.push(protocol());
  return out.join("\n");
}
