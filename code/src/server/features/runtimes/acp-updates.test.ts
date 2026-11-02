import { expect, test } from "bun:test";
import { UpdateSink } from "./acp-updates";
import type { RunContext } from "./adapter";

const ctx = { runId: "r", spec: { id: "codex" }, emit: () => undefined } as unknown as RunContext;
const script = "pwd; rg --files; cat notes.txt";

function ask(permissionCommand: string): string | undefined {
  const sink = new UpdateSink(ctx);
  sink.handle({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    kind: "execute",
    rawInput: { command: script },
  });
  return sink.describe({ toolCallId: "t1", rawInput: { command: permissionCommand } }).command;
}

test("a script Codex re-quotes in the permission request is read as the announced command", () => {
  expect(ask(`"${script}"`)).toBe(script);
});

test("a different quoted command is left as it was asked", () => {
  expect(ask('"rm -rf /"')).toBe('"rm -rf /"');
});

test("a script with single quotes inside is re-quoted by Codex and still matches", () => {
  const withQuotes = "git status && rg --files -g '! .git' -g 'AGENTS.md' && ls -la";
  const sink = new UpdateSink(ctx);
  sink.handle({ sessionUpdate: "tool_call", toolCallId: "t2", rawInput: { command: withQuotes } });
  const requoted = `"git status && rg --files -g '"'! .git'"' -g 'AGENTS.md' && ls -la"`;
  const ask = sink.describe({ toolCallId: "t2", rawInput: { command: requoted } });
  expect(ask.command).toBe(withQuotes);
});
