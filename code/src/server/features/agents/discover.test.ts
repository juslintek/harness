import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverAgents, type Runner } from "./discover";

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
  throws?: string;
}

function fakeRunner(replies: Record<string, Reply>): Runner {
  return async (argv) => {
    const reply = replies[argv.join(" ")];
    if (!reply) return { code: 127, stdout: "", stderr: "not found" };
    if (reply.throws) throw new Error(reply.throws);
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
}

const find = async (replies: Record<string, Reply>, id: string) =>
  (await discoverAgents(fakeRunner(replies))).find((agent) => agent.id === id);

test("a missing binary is reported as not installed", async () => {
  const agent = await find({}, "claude");
  expect(agent).toEqual({
    id: "claude",
    installed: false,
    path: null,
    version: null,
    loggedIn: null,
    error: null,
  });
});

test("version is parsed from the cli output and the path from which", async () => {
  const agent = await find(
    {
      "claude --version": { stdout: "2.1.316 (Claude Code)\n" },
      "which claude": { stdout: "/usr/local/bin/claude\n" },
      "claude auth status": { stdout: '{\n  "loggedIn": true\n}' },
    },
    "claude",
  );
  expect(agent).toMatchObject({
    installed: true,
    version: "2.1.316",
    path: "/usr/local/bin/claude",
    loggedIn: true,
  });
});

test("a failing probe means logged out", async () => {
  const agent = await find(
    { "codex --version": { stdout: "codex-cli 0.164.0" }, "codex login status": { code: 1 } },
    "codex",
  );
  expect(agent).toMatchObject({
    installed: true,
    version: "0.164.0",
    loggedIn: false,
    error: null,
  });
});

test("a probe that succeeds without the expected output means logged out", async () => {
  const agent = await find(
    {
      "claude --version": { stdout: "2.1.316" },
      "claude auth status": { stdout: '{"loggedIn": false}' },
    },
    "claude",
  );
  expect(agent?.loggedIn).toBe(false);
});

test("codex prints its login status on stderr and still counts as logged in", async () => {
  const agent = await find(
    {
      "codex --version": { stdout: "0.165.0" },
      "codex login status": { stderr: "Logged in using ChatGPT" },
    },
    "codex",
  );
  expect(agent?.loggedIn).toBe(true);
});

test("a probe that throws gives unknown login state and the error", async () => {
  const agent = await find(
    {
      "codex --version": { stdout: "0.164.0" },
      "codex login status": { throws: "timed out after 5000 ms" },
    },
    "codex",
  );
  expect(agent).toMatchObject({
    installed: true,
    loggedIn: null,
    error: "timed out after 5000 ms",
  });
});

test("agents without a probe have unknown login state", async () => {
  const agent = await find({ "junie --version": { stdout: "junie 1.2.3" } }, "junie");
  expect(agent).toMatchObject({ installed: true, loggedIn: null });
});

test("the codex login probe runs against the real ~/.codex, the one runs symlink auth from", async () => {
  const seen: Record<string, Record<string, string> | undefined> = {};
  const run: Runner = async (argv, _timeout, env) => {
    seen[argv.join(" ")] = env;
    return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
  };
  await discoverAgents(run);
  expect(seen["codex login status"]).toEqual({ CODEX_HOME: join(homedir(), ".codex") });
  expect(seen["claude auth status"]).toBeUndefined();
});
