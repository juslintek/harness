// Measurement shim for the smoke run: starts the real ACP adapter (argv[2..]) and copies its stdout
// frames to ACP_TEE_LOG, so usage_update counts and PromptResponse quotas can be read afterwards.
import { appendFileSync } from "node:fs";

const log = process.env.ACP_TEE_LOG;
const child = Bun.spawn(process.argv.slice(2), {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "inherit",
});
for await (const chunk of child.stdout) {
  process.stdout.write(chunk);
  if (log) appendFileSync(log, chunk);
}
process.exit(await child.exited);
