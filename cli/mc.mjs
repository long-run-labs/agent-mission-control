#!/usr/bin/env node
// mc: the Mission Control command line. Agents use it to report and ask; humans use it to steer
// from a terminal (in the chat, they type the same commands as /mc).
import { run } from "../lib/commands.mjs";

try {
  await run(process.argv.slice(2));
} catch (e) {
  process.stderr.write((e.usage ? e.message : `mc: ${e.message}`) + "\n");
  process.exit(1);
}
