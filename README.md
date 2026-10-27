# Agent Mission Control (core)

Keep long Claude Code runs on a leash, without sitting at the keyboard.

- **A goal with a finish line.** While a goal is active, a Stop hook keeps the run going until
  the agent marks it done (it's told to only when your "done when" holds). It lets the run stop when it's waiting on you, out of budget, or stuck,
  so it can't loop.
- **Budgets with teeth.** Cap tool calls, minutes and automatic continues. When one runs out,
  every tool call is refused and the agent is told to wrap up. A new goal starts a fresh budget.
- **GO / NO-GO for risky commands.** `git push`, `npm publish`, `rm -rf`, or any pattern you
  add, is held until you approve it. The agent is told it's queued and works on other things,
  then runs exactly the command you approved.
- **Questions and notes mid-run.** The agent asks with `mc ask`. Your answers and notes
  reach it after its next tool call, through `additionalContext`. No restart.

One JSON file of state. Zero dependencies. Node 18.17+. Tested on macOS; Linux and Windows
aren't tested yet.

## Install

```bash
git clone https://github.com/long-run-labs/agent-mission-control
node agent-mission-control/install.mjs /path/to/your/project --goal "Ship the CSV export"
```

This copies the runtime to `<project>/.mission/` (git-ignored), registers one hook for six events
in `<project>/.claude/settings.local.json` (existing entries kept, original saved once as `.bak`;
listed in `.git/info/exclude` so it stays out of commits), and adds a `mission-control` skill that
teaches the agent the protocol. Add `--shared` to use the
committed `.claude/settings.json` instead; then commit `.mission/` too.

> In an interactive session, Claude Code runs project hooks only after you accept the folder's
> trust prompt.

## Steer from a second terminal

```bash
alias mc="node .mission/bin/mc.mjs"
mc status                         # goal, budget, open questions, pending approvals
mc say "use the staging DB only"  # reaches the agent after its next tool call
mc answer q2 "Postgres"
mc approve a1                     # or: mc deny a1 "not on Fridays"
mc pause / mc resume
mc set maxToolCalls 300
mc set requireApproval "git push, npm publish, terraform apply"
```

If the agent has already stopped (a blocking question, a budget, or on hold), go back to its
session and type `continue` after you answer; nothing restarts it by itself.

## How it works

| Hook event | What it does |
|---|---|
| `SessionStart` | Injects the mission brief: goal, budget, open questions, recent log, protocol |
| `UserPromptSubmit` | Passes along anything new from you |
| `PreToolUse` | Refuses tools while paused or over budget; holds commands that need a GO; keeps the agent out of `.mission/` |
| `PostToolUse`, `PostToolUseFailure` | Counts the call; delivers your notes, answers and approval decisions |
| `Stop` | While a goal is active, keeps the run going until it's done, unless it's waiting on you, out of budget, or stuck |

The agent can run its own `mc` commands at any time, one at a time. Human commands (`approve`,
`resume`, `set`, `reset-budget`…) and anything chained onto `mc` are refused. If the state file
can't be read, tools are refused with the reason instead of the checks silently switching off.

Approval patterns match the whitespace-collapsed command, case-insensitively; `*` matches
anything. They're a seatbelt, not a sandbox.

`npm test` runs the end-to-end checks against temporary projects.

## The full kit

**[Agent Mission Control](https://buy.polar.sh/polar_cl_XzIYl3hBPBQKZT8p4Sn31PRBKXB7LYpEE45zi3KltXp)** adds what you need when you're not at a terminal:

- a live local console with GO / NO-GO buttons, one-click answers, budget gauges and a steering box;
- phone alerts through ntfy, plus desktop notifications, when the agent needs a GO, is blocked,
  stops or finishes;
- a sample mission to try the console before installing.

$15, one-time, and it funds the work on this core.

## License

MIT
