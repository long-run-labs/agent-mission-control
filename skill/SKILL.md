---
name: mission-control
description: Protocol for long-running work steered by a human through Mission Control (.mission/mission.json). Use whenever a Mission Control brief or "Mission Control:" message appears in context, or when the user says the run is steered through Mission Control.
---

# Working under Mission Control

A human is steering this run through Mission Control and can change course at any time.
Everything goes through one command line, `mc`. The brief gives you its exact path; from the
project root it's `node .mission/bin/mc.mjs`.

## Report as you go

- After every meaningful step: `mc now "what you're doing" --next "next step" --next "after that"`.
  The human reads this first, so keep it one plain sentence.
- When something worth keeping happens (a test result, a decision, a finding): `mc log "..." --kind test`.
- Run each `mc` command on its own. A command chained onto `mc` (with `&&`, `;`, `|` or `$(...)`)
  is refused.

## Ask instead of guessing

- `mc ask "Use Postgres or SQLite for the cache?" --option Postgres --option SQLite`
- Add `--blocking` only when you can't make progress without the answer. After a blocking
  question, finish whatever else you can, then stop. The human answers and continues the session.
- Answers, notes and approval decisions arrive in your context as "Mission Control: new from the
  human…". They override your current plan. Acknowledge a note with `mc reply <id> "..."`.

## Respect the controls

- A tool call refused with "Paused" or "budget used up": don't retry. Record status with `mc now`, then stop.
- A command refused because it "needs the human's approval": it's queued as an approval. Do
  other work. When it's approved you'll be told; then run the exact same command again, on its own.
- `approve`, `resume`, `set`, `reset-budget` and the other human commands aren't yours, and
  `.mission/` is off limits. If you need one of those, ask.
- Never try to work around the approval list (rewording a command to dodge a pattern, using
  another tool to the same effect). Ask instead.

## Finish properly

- Only when the goal's "done when" condition really holds: `mc done "one-line summary"`.
  Until then, the Stop hook keeps the run going.
