// Mission state: one JSON file that the agent, the hooks, the CLI and the dashboard all share.
// Writes go through update(), which takes a short directory lock and replaces the file atomically.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SCHEMA_VERSION = 1;
export const DEFAULT_APPROVALS = ["git push", "npm publish", "rm -rf", "rm -fr", "git clean*x", "curl * | sh", "curl * | bash", "wget * | sh", "terraform apply", "kubectl delete"];
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 2000; // a lock with no recorded owner this old was left by a crashed writer
const LOCK_MAX_MS = 60000; // no write takes this long, so an older lock is stale whatever its PID says (reused PIDs)

export function emptyMission(goal = "") {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    goal: { text: goal, doneWhen: "", done: false, doneAt: null, summary: "" },
    controls: {
      paused: false,
      maxToolCalls: 400,
      maxMinutes: 120,
      maxStopBlocks: 25,
      requireApproval: [...DEFAULT_APPROVALS],
      notes: "",
      notify: { desktop: true, ntfyTopic: "", ntfyServer: "https://ntfy.sh" },
    },
    status: { phase: "", now: "", next: [], updatedAt: now },
    questions: [],
    inbox: [],
    approvals: [],
    log: [{ at: now, kind: "start", text: goal ? `Mission created: ${goal}` : "Mission created" }],
    usage: { startedAt: null, toolCalls: 0, stopBlocks: 0, toolCallsAtLastBlock: null, sessions: 0, lastControlsSeen: null, lastAlert: null },
  };
}

// Resolution order: $MISSION_FILE; else, inside Claude Code (hooks get $CLAUDE_PROJECT_DIR), that
// project's own .mission/ only; else walk up from cwd to the repo root (the first folder with .git),
// never past the home folder. A mission in a parent folder never takes over the projects below it.
export function findMissionFile(start = process.cwd()) {
  if (process.env.MISSION_FILE) return path.resolve(process.env.MISSION_FILE);
  if (process.env.CLAUDE_PROJECT_DIR) {
    const p = path.join(process.env.CLAUDE_PROJECT_DIR, ".mission", "mission.json");
    return fs.existsSync(p) ? p : null;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let dir = path.resolve(start);
  for (;;) {
    const p = path.join(dir, ".mission", "mission.json");
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir || fs.existsSync(path.join(dir, ".git")) || (home && path.resolve(up) === path.resolve(home) && dir !== home)) return null;
    dir = up;
  }
}

export function read(file) {
  const raw = fs.readFileSync(file, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e.message}). Fix it by hand (often a trailing comma) or delete it and run \`mc init\`.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must hold a JSON object.`);
  return normalize(data);
}

// Fill in whatever is missing and coerce types, so a hand-edited file can't quietly switch a check off.
export function normalize(m) {
  const base = emptyMission();
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const num = (v, d) => { const n = Number(v); return v !== "" && v !== null && Number.isFinite(n) && n >= 0 ? n : d; };
  const flag = (v) => v === true || (typeof v === "string" && !/^(false|0|no|off|)$/i.test(v.trim())) || (typeof v === "number" && v !== 0);
  const records = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) : []);
  const g = obj(m.goal), c = obj(m.controls), s = obj(m.status), u = obj(m.usage);

  const out = { ...base, ...m };
  out.goal = { ...base.goal, ...g, text: String(g.text ?? ""), doneWhen: String(g.doneWhen ?? ""), done: flag(g.done) };
  let approvals = base.controls.requireApproval;
  if (Array.isArray(c.requireApproval)) approvals = c.requireApproval.map(String);
  else if (typeof c.requireApproval === "string") approvals = c.requireApproval.split(",");
  out.controls = {
    ...base.controls,
    ...c,
    paused: flag(c.paused),
    maxToolCalls: num(c.maxToolCalls, base.controls.maxToolCalls),
    maxMinutes: num(c.maxMinutes, base.controls.maxMinutes),
    maxStopBlocks: num(c.maxStopBlocks, base.controls.maxStopBlocks),
    requireApproval: approvals.map((p) => p.trim()).filter(Boolean),
    notes: String(c.notes ?? ""),
    notify: { ...base.controls.notify, ...obj(c.notify) },
  };
  out.status = { ...base.status, ...s, now: String(s.now ?? ""), phase: String(s.phase ?? ""), next: Array.isArray(s.next) ? s.next.map(String) : [] };
  out.usage = {
    ...base.usage,
    ...u,
    toolCalls: num(u.toolCalls, 0),
    stopBlocks: num(u.stopBlocks, 0),
    sessions: num(u.sessions, 0),
  };
  for (const k of ["questions", "inbox", "approvals", "log"]) out[k] = records(m[k]);
  return out;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// true = owner alive, false = owner gone, null = can't tell (no pid recorded yet).
function lockOwnerAlive(lock) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8")); } catch { return null; }
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function withLock(file, fn) {
  const lock = file + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try { fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); } catch {}
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A live owner keeps its lock however long it takes; waiters give up at the deadline instead.
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      const alive = lockOwnerAlive(lock);
      const stale = age > LOCK_MAX_MS || alive === false || (alive === null && age > LOCK_STALE_MS);
      if (stale) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`the mission file is busy (lock folder ${lock}). Try again in a moment. If nothing is running, delete that folder.`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function write(file, mission) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mission, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// update(file, m => { ...mutate m...; return result }) returns whatever the callback returns.
export function update(file, fn) {
  return withLock(file, () => {
    const m = read(file);
    const result = fn(m);
    trim(m);
    write(file, m);
    return result;
  });
}

// Creates the mission file. A new .mission/ folder also gets a .gitignore, so state stays out of commits.
export function create(file, goal) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) throw new Error(`already exists: ${file}`);
  const ignore = path.join(dir, ".gitignore");
  if (path.basename(dir) === ".mission" && !fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  write(file, emptyMission(goal));
}

// Keep everything still in play; drop the oldest finished items beyond 100 of each kind.
function keepRecent(list, isFinished, max = 100) {
  const finished = list.filter(isFinished);
  if (finished.length <= max) return list;
  const keep = new Set(finished.slice(0, max));
  return list.filter((x) => !isFinished(x) || keep.has(x));
}

function trim(m) {
  if (m.log.length > 300) m.log = m.log.slice(0, 300);
  m.inbox = keepRecent(m.inbox, (x) => x.seen);
  m.questions = keepRecent(m.questions, (q) => q.answer != null && q.answerSeen);
  m.approvals = keepRecent(m.approvals, (a) => a.state !== "waiting" && (a.used || a.state === "denied" || a.state === "expired"));
}

export function nextId(list, prefix) {
  let n = 0;
  for (const x of list) {
    const k = Number(String(x.id || "").slice(prefix.length));
    if (x.id?.startsWith(prefix) && k > n) n = k;
  }
  return prefix + (n + 1);
}

export function addLog(m, kind, text) {
  m.log.unshift({ at: new Date().toISOString(), kind, text });
}

// A goal is active once it's set and until it's marked done. Budgets and the Stop hook only act then.
export const goalActive = (m) => Boolean(m.goal.text) && !m.goal.done;

// New goal, reopened goal or a manual restart: the budget starts again from zero, and the clock
// starts at the next session or tool call, not now (a goal set tonight for tomorrow's run is fine).
export function resetUsage(m) {
  m.usage.startedAt = null;
  m.usage.toolCalls = 0;
  m.usage.stopBlocks = 0;
  m.usage.toolCallsAtLastBlock = null;
  m.usage.lastAlert = null;
}

// Budget, in one place, so hooks, CLI and dashboard agree. Minutes are wall-clock time since the first
// session or tool call after the goal was set.
export function budget(m) {
  const c = m.controls, u = m.usage;
  const minutes = u.startedAt ? Math.max(0, (Date.now() - new Date(u.startedAt).getTime()) / 60000) : 0;
  const overCalls = c.maxToolCalls > 0 && u.toolCalls >= c.maxToolCalls;
  const overTime = c.maxMinutes > 0 && minutes >= c.maxMinutes;
  return { minutes, overCalls, overTime, exhausted: overCalls || overTime };
}

// Glob-ish match on the whitespace-collapsed command: "*" matches anything, otherwise a
// case-insensitive substring match. A seatbelt, not a sandbox.
export function matchesPattern(command, pattern) {
  const cmd = String(command).toLowerCase().replace(/\s+/g, " ");
  const parts = String(pattern).toLowerCase().replace(/\s+/g, " ").split("*").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  let at = 0;
  for (const p of parts) {
    const i = cmd.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return true;
}
