// Building blocks for the Phase 6 gate: the attempt log, temp dirs, git and HTTP helpers.
// Everything runs on temp homes and loopback; nothing reaches a real host or a keychain.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createReport, type Report } from "./gate-5-kit";

export const ROOT: string = join(import.meta.dir, "..", "..");
export const LOG_DIR: string = join(ROOT, "working-docs", "phase-6-gate-logs");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-gate6-${prefix}-`));
}

export function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

export interface GateLog {
  print: (line: string) => void;
  report: Report;
  path: string;
  attempt: number;
}

// One file per attempt, numbered after the ones already in the directory.
export function openLog(): GateLog {
  mkdirSync(LOG_DIR, { recursive: true });
  const taken = readdirSync(LOG_DIR).flatMap((f) => /^attempt-(\d+)\.log$/.exec(f)?.[1] ?? []);
  const attempt = Math.max(0, ...taken.map(Number)) + 1;
  const path = join(LOG_DIR, `attempt-${attempt}.log`);
  const print = (line: string): void => {
    console.log(line);
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  };
  print(`gate 6 attempt ${attempt}, commit ${git(ROOT, "rev-parse", "HEAD")}`);
  return { print, report: createReport(print), path, attempt };
}

export interface Reply {
  status: number;
  json: Record<string, unknown>;
  list: Record<string, unknown>[];
}

export async function call(
  client: Client,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Reply> {
  const res = await client.call(method, path, {
    cookie,
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  const list = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  return {
    status: res.status,
    json: list.length > 0 ? {} : (parsed as Record<string, unknown>),
    list,
  };
}

export function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

// Every file under a directory, for "this text is nowhere on the target" checks.
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

export function filesContaining(dir: string, needle: string): string[] {
  const bytes = Buffer.from(needle);
  return filesUnder(dir).filter((f) => readFileSync(f).includes(bytes));
}
