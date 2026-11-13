import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnExec } from "./ssh-transport";
import type { RunResult, Transport } from "./transport";

const LOCAL_HOME = "/home/deploy";

export interface LocalTransport extends Transport {
  stop: () => void;
}

const OK: RunResult = { code: 0, stdout: "", stderr: "" };

interface ParsedUnit {
  binary: string;
  env: Record<string, string>;
}

// Reads back the two unit formats the executor writes, so the test starts exactly what the unit
// text says and a broken unit fails the deploy like it would on a real machine.
function parseUnit(text: string): ParsedUnit | null {
  const binary = /(?:ExecStart=|<array>\s*<string>)(\/[^\s<]+)/.exec(text)?.[1];
  const env: Record<string, string> = {};
  for (const name of ["HARNESS_HOME", "HARNESS_PORT", "HARNESS_HOST"]) {
    const value = new RegExp(`${name}(?:=|</key>\\s*<string>)([^\\s<]+)`).exec(text)?.[1];
    if (value !== undefined) env[name] = value;
  }
  if (!env.HARNESS_HOME || !env.HARNESS_PORT || !env.HARNESS_HOST) return null;
  return binary ? { binary, env } : null;
}

// Paths are virtual and live under `root`. systemctl and launchctl are never run: the unit text
// is parsed and the binary started directly, detached, with its pid recorded, so a test deploys
// for real without touching this machine's service manager.
export function localTransport(root: string): LocalTransport {
  const abs = (path: string): string => join(root, path);
  const units: string[] = [];
  const procs: { kill: () => void }[] = [];
  const env = { PATH: process.env.PATH ?? "", HOME: LOCAL_HOME };
  const start = (text: string): RunResult => {
    const unit = parseUnit(text);
    if (!unit) return { code: 1, stdout: "", stderr: "unit file is not parsable" };
    const log = openSync(join(root, "harness.log"), "a");
    const proc = Bun.spawn([abs(unit.binary)], {
      env: { ...env, ...unit.env, HARNESS_HOME: abs(unit.env.HARNESS_HOME ?? "") },
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    });
    proc.unref();
    procs.push(proc);
    writeFileSync(join(root, "harness.pid"), `${proc.pid}\n`);
    return OK;
  };
  return {
    async put(path, bytes, mode) {
      mkdirSync(dirname(abs(path)), { recursive: true });
      writeFileSync(abs(path), bytes, { mode });
      if (/\.(service|plist)$/.test(path)) units.push(new TextDecoder().decode(bytes));
    },
    async run(argv) {
      const [cmd, ...rest] = argv;
      if (cmd !== "systemctl" && cmd !== "launchctl") return spawnExec(argv, env);
      const text = units.at(-1);
      const starts = rest.includes("--now") || rest[0] === "load";
      return starts && text ? start(text) : OK;
    },
    exists: async (path) => Bun.file(abs(path)).exists(),
    stop() {
      for (const proc of procs) proc.kill();
    },
  };
}
