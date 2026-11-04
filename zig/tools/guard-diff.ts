// Differential run of the TS L1 evaluator against `harness guard-eval --json`. It feeds both the
// corpus, its wrapped variants, the hand-written edge cases and seeded random command and path
// actions, and stops with exit 1 at the first disagreement. Run from zig/:
//   zig build -Doptimize=ReleaseSafe && bun tools/guard-diff.ts [--n 50000] [--seed 20260101]
// The TS side runs in a child process with a watchdog, because the TS parser loops forever on an
// unterminated single quote inside `$(...)`; such inputs are counted as skipped, like a TS
// RangeError (the JS stack limit is an engine limit, not behaviour to copy).
import { spawn } from "bun";
import { readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAND, randomCase, randomPaths, rng, SCOPES } from "./gen-guard-fixtures";

const GUARD = join(import.meta.dir, "../../code/src/server/features/guard");
const BIN = join(import.meta.dir, "../zig-out/bin/harness");

interface Input {
  kind: string;
  command?: string;
  paths: string[];
  toolName?: string;
  scope: (typeof SCOPES)[number];
}

type Row = { verdict: string; rule: string | null; category: string; reason: string } | { error: string };

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(process.argv[i + 1]);
}

async function build(n: number, seed: number): Promise<Input[]> {
  const { corpus } = await import(join(GUARD, "corpus.ts"));
  const r = rng(seed);
  const out: Input[] = [];
  const exec = (command: string): void => {
    out.push({ kind: "execute", command, paths: [], scope: SCOPES[out.length % 4 === 0 ? 1 : 0] as Input["scope"] });
  };
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  for (const c of HAND) exec(c);
  for (const cls of ["[^x]", "[^s]", "[\\^x]", "[^]", "[]", "[^a-z]", "[^-x]", "[a-]", "[--a]", "[s-]", "[^^]", "[a-c^]", "[z-a]", "[s", "[?]", "[*]"]) {
    exec(`cat /home/u/.${cls}sh/id_rsa`);
    exec(`cat /home/u/.${cls}`);
  }
  for (const c of ["constructor x", "toString", "valueOf -a", "ls | hasOwnProperty", "__proto__", "FOO=1 isPrototypeOf", "bash -c 'constructor a'"]) exec(c);
  for (const { cmd: c } of corpus as { cmd: string }[]) {
    exec(c);
    for (const v of [
      `(${c})`, `echo $(${c})`, `${c} | cat`, `X=1 ${c}`, `${c} > /dev/null 2>&1`, `eval ${q(c)}`,
      `bash -c ${q(c)}`, `sudo ${c}`, `a && ${c}; b`, `xargs -I{} sh -c ${q(c)}`,
    ]) exec(v);
  }
  const kinds = ["read", "edit", "delete"];
  while (out.length < n) {
    if (r() < 0.12) {
      out.push({ kind: kinds[Math.floor(r() * 3)] as string, paths: randomPaths(r), scope: SCOPES[Math.floor(r() * 2)] as Input["scope"] });
    } else exec(randomCase(r));
  }
  return out;
}

function evalTs(input: Input, evaluateL1: (a: unknown, s: unknown) => Row & { verdict: string }): Row | null {
  const { scope, ...action } = input;
  try {
    const x = evaluateL1(action, scope) as { verdict: string; rule: string | null; category: string; reason: string };
    return { verdict: x.verdict, rule: x.rule, category: x.category, reason: x.reason };
  } catch (e) {
    return e instanceof RangeError ? null : { error: "throw" };
  }
}

async function child(): Promise<void> {
  const inputs: Input[] = JSON.parse(readFileSync(process.argv[3] as string, "utf8"));
  const { evaluateL1 } = await import(join(GUARD, "l1.ts"));
  for (let i = Number(process.argv[4]); i < inputs.length; i++) {
    writeSync(1, `${JSON.stringify(evalTs(inputs[i] as Input, evaluateL1))}\n`);
  }
}

async function runTs(inputs: Input[]): Promise<(Row | null)[]> {
  const file = join(tmpdir(), `guard-diff-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(inputs));
  const out: (Row | null)[] = new Array(inputs.length).fill(null);
  try {
    let from = 0;
    while (from < inputs.length) {
      const p = spawn(["bun", import.meta.path, "child", file, String(from)], { stdout: "pipe" });
      const reader = p.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let next = from;
      for (;;) {
        const timer = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 2000));
        const got = await Promise.race([reader.read(), timer]);
        if (got === "timeout") {
          p.kill();
          next++;
          break;
        }
        if (got.done) break;
        buf += dec.decode(got.value);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          out[next++] = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      from = next;
    }
  } finally {
    rmSync(file, { force: true });
  }
  return out;
}

async function runZig(inputs: Input[]): Promise<Row[]> {
  const file = join(tmpdir(), `guard-diff-zig-${process.pid}.jsonl`);
  writeFileSync(file, `${inputs.map((i) => JSON.stringify(i)).join("\n")}\n`);
  try {
    const p = spawn([BIN, "guard-eval", "--json"], { stdin: Bun.file(file), stdout: "pipe", stderr: "inherit" });
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error("guard-eval exited non-zero");
    return text.trimEnd().split("\n").map((l) => JSON.parse(l));
  } finally {
    rmSync(file, { force: true });
  }
}

async function main(): Promise<void> {
  const n = arg("n", 50000);
  const inputs = await build(n, arg("seed", 20260101));
  const ts = await runTs(inputs);
  const keep = inputs.map((_, i) => i).filter((i) => ts[i] !== null);
  const zig = await runZig(keep.map((i) => inputs[i] as Input));
  if (zig.length !== keep.length) throw new Error(`zig answered ${zig.length} lines for ${keep.length}`);
  for (const [k, i] of keep.entries()) {
    if (JSON.stringify(ts[i]) !== JSON.stringify(zig[k])) {
      console.log(`DISAGREEMENT on input ${i}: ${JSON.stringify(inputs[i])}`);
      console.log(`  ts : ${JSON.stringify(ts[i])}`);
      console.log(`  zig: ${JSON.stringify(zig[k])}`);
      process.exit(1);
    }
  }
  const errors = keep.filter((i) => "error" in (ts[i] as object)).length;
  console.log(`inputs ${inputs.length}, compared ${keep.length}, skipped ${inputs.length - keep.length} (TS hang or stack limit), TS throws ${errors}, disagreements 0`);
}

if (process.argv[2] === "child") await child();
else if (import.meta.main) await main();
