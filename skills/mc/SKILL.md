---
name: mc
description: Steer Mission Control from the chat. Set a goal, approve or deny held commands, answer the agent's questions, send notes, pause, resume and change budgets. For the human only.
disable-model-invocation: true
argument-hint: goal <what> --done-when <how you'll know> | approve <id> | answer <id> <text> | say <note> | status | help
---

Mission Control applied this command before you saw it. Its result is in your context, in a block
that starts "Mission Control: the human typed". Don't run any mc command for it.

1. For `status` and `help`, show the result unchanged in a code block, then stop.
2. For any other command, tell the human the result in one short line. Then carry on with the
   mission, unless it's paused, done or has no goal. A command they just approved can run now.

If no "Mission Control: the human typed" block is in your context, the hook didn't run. Tell the
human Mission Control's hook isn't active in this session (check /plugin, or re-run the installer).
