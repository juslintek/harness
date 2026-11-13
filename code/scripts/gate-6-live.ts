// A compiled host binary running on a temp home and driven over HTTP, plus the temp clone the
// self-update pipeline builds scripted commits from.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSoftAuthenticator } from "../src/server/test-support/soft-authenticator";
import { enrollWithCode, makeClient, type Remote, signIn } from "./gate-5-kit";
import { call, git, type Reply, ROOT, tempDir } from "./gate-6-kit";

export interface Live extends Remote {
  home: string;
  port: number;
  origin: string;
  proc: Bun.Subprocess;
  // A session without step-up, as after a plain sign-in.
  cookie: string;
}

const PORT_LINE = /listening on http:\/\/127\.0\.0\.1:(\d+)/;
const ENROLL_LINE = /\/#\/enroll\/(\S+)/;

async function readBoot(
  logPath: string,
  proc: Bun.Subprocess,
): Promise<{ port: number; code: string }> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const text = readFileSync(logPath, "utf8");
    const port = PORT_LINE.exec(text)?.[1];
    const code = ENROLL_LINE.exec(text)?.[1];
    if (port && code) return { port: Number(port), code };
    if (proc.exitCode !== null) throw new Error(`binary exited at boot: ${text.slice(-400)}`);
    await Bun.sleep(100);
  }
  throw new Error("binary did not print its port and enrollment link");
}

export async function startLive(binary: string): Promise<Live> {
  const home = tempDir("live");
  const logPath = join(home, "boot.log");
  await Bun.write(logPath, "");
  const proc = Bun.spawn([binary], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? home,
      HARNESS_HOME: home,
      HARNESS_PORT: "0",
    },
    stdin: "ignore",
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  const { port, code } = await readBoot(logPath, proc);
  const origin = `http://localhost:${port}`;
  const client = makeClient(port, origin);
  const rp = { id: "localhost", name: "Harness", origin };
  const authn = createSoftAuthenticator(rp);
  const remote = { client, authn };
  await enrollWithCode(remote, code, {
    email: "admin@gate6.test",
    name: "Gate Admin",
  });
  // Enrolling leaves a fresh step-up behind, so sign in again for a plain session.
  return { ...remote, home, port, origin, proc, cookie: await signIn(remote) };
}

export const lockPid = (live: Live): number =>
  Number.parseInt(readFileSync(join(live.home, "harness.lock"), "utf8"), 10);

export function killLive(live: Live): void {
  try {
    process.kill(lockPid(live), "SIGKILL");
  } catch {
    // already gone
  }
}

export const healthVersion = async (live: Live): Promise<string> =>
  ((await (await fetch(`http://127.0.0.1:${live.port}/api/health`)).json()) as { version: string })
    .version;

export interface Seen {
  id: string;
  reply: Reply;
  statuses: string[];
}

// Polls until the request reaches one of `until`; the port is briefly down during a swap.
export async function waitRequest(
  live: Live,
  id: string,
  until: string[],
  ms: number,
): Promise<Seen> {
  const end = Date.now() + ms;
  const statuses: string[] = [];
  for (;;) {
    const reply = await call(
      live.client,
      "GET",
      `/api/selfupdate/requests/${id}`,
      live.cookie,
    ).catch(() => null);
    const status = reply ? String(reply.json.status) : null;
    if (status && statuses.at(-1) !== status) statuses.push(status);
    if (reply && status && until.includes(status)) return { id, reply, statuses };
    if (Date.now() > end) throw new Error(`request ${id} stuck at ${statuses.join(">")}`);
    await Bun.sleep(1000);
  }
}

export interface Clone {
  dir: string;
  // Makes a branch off the base commit with the given file rewrites; returns its name.
  branch: (name: string, edits: Record<string, (text: string) => string>) => string;
}

export function makeClone(): Clone {
  const dir = join(tempDir("clone"), "repo");
  git(ROOT, "clone", "--local", "-q", ROOT, dir);
  git(dir, "config", "user.email", "gate6@example.test");
  git(dir, "config", "user.name", "gate6");
  const base = git(dir, "rev-parse", "HEAD");
  return {
    dir,
    branch(name, edits) {
      git(dir, "checkout", "-q", "-b", name, base);
      for (const [file, edit] of Object.entries(edits)) {
        const path = join(dir, file);
        const before = existsSync(path) ? readFileSync(path, "utf8") : "";
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, edit(before));
      }
      git(dir, "add", "-A");
      git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `gate 6: ${name}`);
      git(dir, "checkout", "-q", base);
      return name;
    },
  };
}

export const setVersion =
  (version: string) =>
  (text: string): string =>
    text.replace(/"version": "[^"]*"/, `"version": "${version}"`);
