#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_CODEX_APP_SERVER: string = join(import.meta.dir, "fake-codex-app-server.ts");

interface FakeAuth {
  account?: string;
  usedPercent?: number;
  secondaryUsedPercent?: number;
  resetsAt?: number;
  mode?: "ok" | "logged_out" | "malformed" | "hang" | "rpc_error" | "refresh";
  refreshed?: boolean;
}

const authPath = (): string | null => {
  const home = process.env.CODEX_HOME;
  return home ? join(home, "auth.json") : null;
};

function readAuth(): FakeAuth | null {
  const path = authPath();
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as FakeAuth;
}

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

async function handleAccountRead(id: number | undefined): Promise<void> {
  const auth = readAuth();
  if (!auth || auth.mode === "logged_out") {
    send({ jsonrpc: "2.0", id, result: { account: null, requiresOpenaiAuth: true } });
    return;
  }
  if (auth.mode === "malformed") {
    process.stdout.write("not-valid-json\n", () => process.exit(0));
    return;
  }
  if (auth.mode === "hang") await new Promise(() => {});
  if (auth.mode === "rpc_error") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "internal failure" } });
    return;
  }
  if (auth.mode === "refresh") {
    const path = authPath();
    if (path) writeFileSync(path, JSON.stringify({ ...auth, refreshed: true }));
  }
  send({
    jsonrpc: "2.0",
    id,
    result: {
      account: { type: "chatgpt", email: auth.account ?? "a@example.test" },
      requiresOpenaiAuth: true,
    },
  });
}

function handleRateLimitsRead(id: number | undefined): void {
  const auth = readAuth() ?? {};
  const nowSec = Math.floor(Date.now() / 1000);
  send({
    jsonrpc: "2.0",
    id,
    result: {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: auth.usedPercent ?? 25,
          windowDurationMins: 10080,
          resetsAt: auth.resetsAt ?? nowSec + 3600,
        },
        secondary:
          auth.secondaryUsedPercent === undefined
            ? null
            : {
                usedPercent: auth.secondaryUsedPercent,
                windowDurationMins: 300,
                resetsAt: auth.resetsAt ?? nowSec + 1800,
              },
      },
    },
  });
}

function handle(msg: { id?: number; method?: string }): void {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex" } });
  } else if (msg.method === "initialized") {
    send({ jsonrpc: "2.0", method: "account/updated", params: {} });
  } else if (msg.method === "account/read") {
    void handleAccountRead(msg.id);
  } else if (msg.method === "account/rateLimits/read") {
    handleRateLimitsRead(msg.id);
  }
}

async function main(): Promise<void> {
  const pidFile = process.env.FAKE_CODEX_PIDFILE;
  if (pidFile) writeFileSync(pidFile, String(process.pid));
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() !== "") handle(JSON.parse(line) as { id?: number; method?: string });
      at = buffer.indexOf("\n");
    }
  }
}

if (import.meta.main) void main();
