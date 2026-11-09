import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TargetView } from "../../../shared/distribution";
import type { RunResult, Transport } from "./transport";

export type Exec = (argv: string[]) => Promise<RunResult>;

const OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];
const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// scp hands the remote path to a remote parser, so only plain path characters get through.
const PATH = /^\/[A-Za-z0-9_@%+=:,./-]*$/;

export async function spawnExec(argv: string[], env?: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    ...(env ? { env } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

// ssh joins the command into one string for the remote shell, so every word is single-quoted.
const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

function checkTarget(target: TargetView): void {
  if (!HOST.test(target.address)) throw new Error("refusing an unsafe host name");
  if (target.user !== undefined && !USER.test(target.user)) {
    throw new Error("refusing an unsafe user name");
  }
  const { port } = target;
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new Error("refusing an invalid port");
  }
}

function checkPath(path: string): string {
  if (!PATH.test(path) || path.split("/").includes("..")) {
    throw new Error(`refusing an unsafe remote path: ${JSON.stringify(path)}`);
  }
  return path;
}

// The key and the ssh config are never read here: ssh itself finds them, exactly as when the
// admin runs it by hand.
export function sshTransport(target: TargetView, exec: Exec = spawnExec): Transport {
  checkTarget(target);
  const { address, user, port } = target;
  const sshArgv = (command: string): string[] => [
    "ssh",
    ...OPTIONS,
    ...(port === undefined ? [] : ["-p", `${port}`]),
    ...(user === undefined ? [] : ["-l", user]),
    "--",
    address,
    command,
  ];
  const remote = (path: string): string => {
    const host = address.includes(":") ? `[${address}]` : address;
    return `${user === undefined ? "" : `${user}@`}${host}:${path}`;
  };
  const run = (argv: string[]): Promise<RunResult> => exec(sshArgv(argv.map(quote).join(" ")));
  const must = async (argv: string[], what: string): Promise<void> => {
    const res = await run(argv);
    if (res.code !== 0)
      throw new Error(`${what} failed (${res.code}): ${res.stderr.trim().slice(0, 200)}`);
  };
  return {
    run,
    exists: async (path) => (await run(["test", "-e", checkPath(path)])).code === 0,
    async put(path, bytes, mode) {
      checkPath(path);
      await must(["mkdir", "-p", dirname(path)], "mkdir");
      // The local copy already has the final mode, so scp creates the remote file with it and a
      // 0600 file is never briefly world-readable.
      const dir = mkdtempSync(join(tmpdir(), "harness-put-"));
      try {
        const local = join(dir, "payload");
        writeFileSync(local, bytes, { mode });
        const copy = await exec([
          "scp",
          "-q",
          ...OPTIONS,
          ...(port === undefined ? [] : ["-P", `${port}`]),
          "--",
          local,
          remote(path),
        ]);
        if (copy.code !== 0)
          throw new Error(`scp failed (${copy.code}): ${copy.stderr.trim().slice(0, 200)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      await must(["chmod", mode.toString(8), path], "chmod");
    },
  };
}
