import type { Change } from "./classify";
import { childEnv } from "./proc";

const STAT_CAP = 20_000;
const BASE_CANDIDATES = ["origin/HEAD", "main", "master"];

// `-z` output: `STATUS NUL path NUL`, and for renames and copies `STATUS NUL old NUL new NUL`.
export function parseNameStatus(raw: string): Change[] {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++] as string;
    const moved = status.startsWith("R") || status.startsWith("C");
    const first = fields[i++];
    const second = moved ? fields[i++] : undefined;
    if (first === undefined || (moved && second === undefined)) throw new Error("bad diff output");
    changes.push(
      moved ? { status, path: second as string, oldPath: first } : { status, path: first },
    );
  }
  return changes;
}

async function gitOut(repo: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
    env: childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  if ((await proc.exited) === 0) return out;
  if (args[0] === "rev-parse") return null;
  throw new Error(`git ${args[0]} failed: ${err.trim()}`);
}

// Resolved to a sha so nothing a branch name contains reaches the diff arguments.
async function defaultBase(repo: string): Promise<string> {
  for (const name of BASE_CANDIDATES) {
    const sha = await gitOut(repo, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
    if (sha !== null) return sha.trim();
  }
  throw new Error("no default branch to diff against");
}

export async function changedFiles(repo: string, sha: string): Promise<Change[]> {
  const range = `${await defaultBase(repo)}...${sha}`;
  const out = await gitOut(repo, ["diff", "--name-status", "-M", "-z", "--no-ext-diff", range]);
  return parseNameStatus(out ?? "");
}

export async function diffStat(repo: string, sha: string): Promise<string> {
  const range = `${await defaultBase(repo)}...${sha}`;
  const out = await gitOut(repo, ["diff", "--stat", "--no-color", "--no-ext-diff", range]);
  return (out ?? "").slice(0, STAT_CAP);
}
