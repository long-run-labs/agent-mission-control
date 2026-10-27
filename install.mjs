#!/usr/bin/env node
// Installs Mission Control into a project:
//   node install.mjs [project-dir] [--goal "what the agent should achieve"] [--shared]
// Copies the runtime to <project>/.mission/, registers the hook in <project>/.claude/settings.local.json
// (or settings.json with --shared), adds the agent skill, and creates mission.json if it doesn't exist.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const USAGE = `Usage: node install.mjs [project-dir] [--goal "text"] [--shared]

  --goal "text"  Set the mission goal now (you can also run mc goal later).
  --shared       Register the hook in .claude/settings.json, which teams usually commit, so
                 everyone who opens the project gets it. Commit .mission/ too in that case.
                 Default: .claude/settings.local.json, which stays on your machine.`;

const src = path.dirname(fileURLToPath(import.meta.url));
const HOOK_CMD = 'node "${CLAUDE_PROJECT_DIR}/.mission/hooks/mission-hook.mjs"';
// Earlier versions wrote this spelling; it breaks under PowerShell, so re-installing replaces it.
const LEGACY_CMDS = ['node "$CLAUDE_PROJECT_DIR/.mission/hooks/mission-hook.mjs"'];
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

const fail = (msg) => { console.error(msg); process.exit(1); };

// Claude Code git-ignores settings.local.json only when it creates the file itself. We create it, so
// add our personal files to the repo's local exclude list (.git/info/exclude), which changes no
// tracked file. Doesn't rely on global excludes, which differ per machine. Returns the paths added.
function excludeFromGit(dir, relPaths) {
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let prefix, excludeFile;
  try {
    if (git("rev-parse", "--is-inside-work-tree") !== "true") return [];
    prefix = git("rev-parse", "--show-prefix"); // the project's folder inside the repo, "" at the root
    excludeFile = path.resolve(dir, git("rev-parse", "--git-path", "info/exclude"));
  } catch { return []; }
  const added = [];
  for (const rel of relPaths) {
    const pattern = "/" + prefix + rel;
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern)) continue;
    fs.appendFileSync(excludeFile, (current && !current.endsWith("\n") ? "\n" : "") + pattern + "\n");
    added.push(rel);
  }
  return added;
}

let goal = "", shared = false, target = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
  else if (a === "--goal") { if (args[i + 1] === undefined) fail("--goal needs a value.\n\n" + USAGE); goal = args[++i]; }
  else if (a === "--shared") shared = true;
  else if (a.startsWith("-")) fail(`Unknown option ${a}.\n\n${USAGE}`);
  else if (target) fail(`Only one project directory, please.\n\n${USAGE}`);
  else target = a;
}
target = path.resolve(target || ".");
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) fail(`Not a directory: ${target}`);

// Read and check the settings file before touching anything, so a bad file leaves the project as it was.
const settingsFile = path.join(target, ".claude", shared ? "settings.json" : "settings.local.json");
let settings = {}, rawSettings = null;
if (fs.existsSync(settingsFile)) {
  rawSettings = fs.readFileSync(settingsFile, "utf8");
  if (rawSettings.trim()) {
    try { settings = JSON.parse(rawSettings); } catch (e) { fail(`Couldn't parse ${settingsFile} (${e.message}). Fix it or remove it, then run again.`); }
  }
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(settings)) fail(`${settingsFile} should hold a JSON object. Fix it, then run again.`);
  if (settings.hooks !== undefined && !isObj(settings.hooks)) fail(`"hooks" in ${settingsFile} should be an object. Fix it, then run again.`);
  for (const ev of EVENTS) {
    if (settings.hooks?.[ev] !== undefined && !Array.isArray(settings.hooks[ev])) fail(`"hooks.${ev}" in ${settingsFile} should be a list. Fix it, then run again.`);
  }
}

const dest = path.join(target, ".mission");
for (const dir of ["bin", "lib", "hooks", "dashboard"]) {
  if (fs.existsSync(path.join(src, dir))) fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
}
fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
// Keep state out of git: everything when the hook is local, only the state files when it's shared.
fs.writeFileSync(path.join(dest, ".gitignore"), shared ? "mission.json\nmission.json.*\n" : "*\n");

const missionFile = path.join(dest, "mission.json");
const { create } = await import(pathToFileURL(path.join(dest, "lib", "store.mjs")).href);
const fresh = !fs.existsSync(missionFile);
if (fresh) create(missionFile, goal);

// Merge the hook in without disturbing anything else; replace older spellings of our own command.
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
const backup = settingsFile + ".bak";
if (rawSettings !== null && !fs.existsSync(backup)) fs.writeFileSync(backup, rawSettings);
settings.hooks ??= {};
let added = 0, upgraded = 0;
for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] ??= []);
  let present = false;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (h?.command === HOOK_CMD) present = true;
      else if (LEGACY_CMDS.includes(h?.command)) { h.command = HOOK_CMD; present = true; upgraded++; }
    }
  }
  if (present) continue;
  const entry = { hooks: [{ type: "command", command: HOOK_CMD, timeout: 10 }] };
  if (TOOL_EVENTS.has(ev)) entry.matcher = "*";
  groups.push(entry);
  added++;
}
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

const skillDir = path.join(target, ".claude", "skills", "mission-control");
fs.mkdirSync(skillDir, { recursive: true });
fs.copyFileSync(path.join(src, "skill", "SKILL.md"), path.join(skillDir, "SKILL.md"));

const excluded = shared ? [] : excludeFromGit(target, [".claude/settings.local.json*", ".claude/skills/mission-control/"]);

// An older install may have put the hook in the other settings file; running it from both would count every call twice.
const otherFile = path.join(target, ".claude", shared ? "settings.local.json" : "settings.json");
let alsoInOther = false;
try { const raw = fs.readFileSync(otherFile, "utf8"); alsoInOther = [HOOK_CMD, ...LEGACY_CMDS].some((c) => raw.includes(JSON.stringify(c).slice(1, -1))); } catch {}

const rel = (p) => path.relative(process.cwd(), p) || ".";
const hookNote = added || upgraded ? [added && `${added} events registered`, upgraded && `${upgraded} upgraded`].filter(Boolean).join(", ") : "already registered";
console.log(`Mission Control installed in ${rel(target)}
  runtime   ${rel(dest)}/   (git-ignored: ${shared ? "state only" : "all of it"})
  mission   ${rel(missionFile)}${fresh ? " (new)" : " (kept existing)"}
  hooks     ${rel(settingsFile)} (${hookNote}${fs.existsSync(backup) ? `; your original is in ${path.basename(backup)}` : ""})
  skill     ${rel(skillDir)}/SKILL.md${excluded.length ? `\n  git       kept out of commits via .git/info/exclude: ${excluded.join(", ")}` : ""}${alsoInOther ? `\n\n  Note: the hook is also registered in ${rel(otherFile)}. Remove the mission-hook.mjs entries there so it doesn't run twice.` : ""}

Next:
  1. Set the goal:     node .mission/bin/mc.mjs goal "Ship the CSV export" --done-when "tests pass and PR is open"
${fs.existsSync(path.join(src, "dashboard")) ? "  2. Open the console: node .mission/bin/mc.mjs ui   (prints a private link)" : "  2. Watch and steer:  node .mission/bin/mc.mjs status / say / approve"}
  3. Start Claude Code in ${rel(target)} and give it the task.`);
