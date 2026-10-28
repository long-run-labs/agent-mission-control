# Changelog

## 1.1.0 (2026-10-28)

- Installs as a Claude Code plugin: `/plugin marketplace add long-run-labs/agent-mission-control`,
  then `/plugin install agent-mission-control@long-run-labs`. It does nothing in a project until
  you give it a goal there, and a mission in a parent folder never applies to the projects below it.
- Steer from the chat with `/mc`: `/mc goal`, `/mc approve a1`, `/mc answer q1 …`, `/mc say …`,
  `/mc status` and the rest. When the agent is waiting on you, it carries on with no "continue"
  needed. A `/mc` typed while it's working waits until the run stops; press Esc first to send it
  sooner (Esc stops the current step).
- Only a `/mc` a person types in a session they're attending is applied. The usual ways around
  that (a nested `claude -p`, a scheduled prompt, a script) are refused, and starting a nested
  `claude` mid-mission waits for a GO. It's a seatbelt, not a sandbox.
- A held command gets one nudge to keep working; with nothing else to do, the run may stop without
  asking a separate question. A new goal expires approvals left from the old one.
- `mc goal` creates the mission if there isn't one. A new `.mission/` folder is git-ignored.
- The command line moved from `bin/` to `cli/`. Re-running the installer upgrades a project install.
- A registered project install takes over from the plugin in that project, so nothing runs twice.
- Fixes: a lock older than a minute is cleared even if its process ID was reused; symlinked
  project paths no longer trip the mc check; `.MISSION/` in a shell command is caught on macOS
  and Windows.

## 1.0.2 (2026-10-28)

First public release: goal and Stop control, budgets, GO/NO-GO approvals, questions and a steering
inbox through the `mc` command line, installer and agent skill.
