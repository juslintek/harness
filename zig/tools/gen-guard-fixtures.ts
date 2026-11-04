// Dumps what the TS guard lexer, statement parser, wrappers, braces and launchers return for a fixed
// input set, so the Zig port can be checked against it. Run from zig/: bun tools/gen-guard-fixtures.ts
// The TS parser loops forever on an unterminated single quote inside `$(...)` (closeParen resets its
// index to -1 and the loop counter wraps to 0), so every case runs in a child process with a
// watchdog and a hanging input is left out of the fixtures (the Zig side rejects it by hand-written
// test instead).
import { spawn } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "../../code/src/server/features/guard");
const OUT = join(import.meta.dir, "../src/guard/fixtures");

type Json = unknown;

function cmdJson(c: {
  argv: string[];
  assigns: string[];
  wrappers: string[];
  piped: boolean;
  fromPipe: boolean;
  hereString: boolean;
  redirects: { op: string; path: string }[];
  downloadExec: boolean;
  after: { argv: string[] }[];
  mark?: string;
}): Json {
  const o: Record<string, Json> = { argv: c.argv };
  if (c.assigns.length) o.assigns = c.assigns;
  if (c.wrappers.length) o.wrappers = c.wrappers;
  if (c.piped) o.piped = true;
  if (c.fromPipe) o.fromPipe = true;
  if (c.hereString) o.hereString = true;
  if (c.redirects.length) o.redirects = c.redirects.map((r) => [r.op, r.path]);
  if (c.downloadExec) o.downloadExec = true;
  if (c.after.length) o.after = c.after.map((a) => a.argv);
  if (c.mark) o.mark = c.mark;
  return o;
}

// Deterministic generator so reruns produce the same file.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FRAGMENTS = [
  "a", "b", "ls", "rm -rf /", "cat", "echo", "x=1", "A_B=2", " ", " ", "  ", "\t", "\n", ";", ";;", "&&",
  "||", "&", "|", "|&", "(", ")", "{", "}", "{a,b}", "{1..3}", "{x,y,z}", ",", "$", "$(", "${", "${x}",
  "`", "\\", "\\\n", '"', "'x'", "'", '"a b"', "#", "# c\n", "<", ">", ">>", "2>&1", "&>", ">&2", "<<<",
  "<(", ">(", "<<'EOF'\nbody\nEOF\n", "<<-'E'\n\tq\n\tE\n", "<<EOF", "sudo ", "env ", "env -i ", "env -S 'a b' ",
  "nice -n5 ", "timeout 5 ", "xargs ", "xargs -I{} ", "bash -c ", "sh -lc ", "eval ", "su -c ", "command ",
  "command -v ", "find . -exec ", "find a b -exec rm {} \\; ", "find / -delete ", " \\; ", " + ", "{}",
  "git rebase -x ", "git bisect run ", "git submodule foreach ", "trap ", "watch -n 2 ", "alias q=",
  "fd -x ", "npx -c ", "pnpm rimraf ", "npm exec -- ", "curl", "wget", "$(curl x)", "`wget y`", "!", "if ",
  "then ", "fi", "é", "日本", "😀", " ", "﻿", "-", "--", "-c ", "-exec ", "=",
];

// A lone quote is the usual way into the TS hang, and every hang costs the watchdog 2 seconds;
// GUARD_FUZZ_NOQUOTE=1 leaves it out for large one-off runs.
const PICK = process.env.GUARD_FUZZ_NOQUOTE ? FRAGMENTS.filter((f) => f !== "'") : FRAGMENTS;

function randomCase(r: () => number): string {
  const n = 1 + Math.floor(r() * 14);
  let s = "";
  for (let i = 0; i < n; i++) s += PICK[Math.floor(r() * PICK.length)];
  return s;
}

const HAND: string[] = [
  "", " ", "\n", ";", ";;", "&", "&&", "||", "|", "()", "( )", "{ a; }", "a;b", "a\nb", "a & b", "a &b",
  "a|b|c", "a |& b", "a && b || c", "a;;b", "! a", "if a; then b; fi", "while a; do b; done",
  "echo 'a b' \"c d\" e\\ f", 'echo "a\\"b" "$x" "\\$x" "\\\\" "\\z" "a\\\nb"', "echo 'unterminated",
  'echo "unterminated', "echo `unterminated", "echo $(unterminated", "echo ${unterminated", "echo a\\",
  "echo $(echo $(echo a))", "echo `echo a` `echo b`", 'echo "$(echo "a b")"', 'echo "`echo a`"',
  "echo $(echo ')' )", 'echo $(echo ")" )', "echo $(echo \\) )", "echo $( (a) )", "echo $((1+2))",
  "echo ${HOME:-x}", "echo ${a}b${c}", "echo $", "echo $$ $? $1", "cat <(ls) >(wc)", "a<(b)", "a>(b)",
  "echo a#b", "echo a #b", "echo #c\necho d", "# only comment", "echo a # c; rm -rf /",
  "cat <<'EOF'\nline\nEOF", "cat <<'EOF'\nline\nEOF\necho after", "cat <<-'EOF'\n\tline\n\tEOF\n",
  "cat <<\"EOF\"\nrm -rf /\nEOF\nls", "cat <<'EOF'\nno end", "cat <<EOF\nx\nEOF", "cat << 'EOF'\nx\nEOF",
  "cat <<'A' <<'B'\n1\nA\n2\nB\nls", "cat <<'' x", "cat <<'E", "a <<< b", "a <<<b", "<<< x",
  "echo $(cat <<'EOF'\n)\nEOF\n)", "echo $(cat <<'EOF'\nline\nEOF\n)", "echo $(cat <<'EOF'\nline\n)",
  "a > b", "a >b", "a>b", "a >> b", "a >| b", "a 2> b", "a 2>&1", "a >&2", "a >& b", "a &> b", "a &>> b",
  "a 2>&-", "a 1>&2 b", "a 12> b", "a x1> b", "a < b", "a <b c", "a > b > c", "> b", "2> b a",
  'a "2">b', "a $(x)>b", "a >", "a <", "a >>", "a <&3", "a 3<&0",
  "FOO=1 BAR=2 cmd a", "FOO=1", "FOO=1;BAR=2", "A=$(x) b", "1A=2 b", "A+=1 b", "A= b", "=x b",
  "sudo ls", "sudo -u root ls", "sudo -uroot ls", "sudo -u", "sudo -- ls", "sudo FOO=1 ls", "sudo -E ls",
  "sudo -D /tmp ls", "sudo -D/tmp ls", "sudo --chdir=/x ls", "sudo", "sudo -u root",
  "env", "env -i ls", "env -u X ls", "env -uX ls", "env FOO=1 BAR=2 ls", "env -C /x ls", "env -C/x ls",
  "env --chdir /x ls", "env -S 'ls -l' a", "env -S'ls -l'", "env -S '' a", "env -- ls", "env - ls",
  "nice ls", "nice -n 5 ls", "nice -n5 ls", "nice -5 ls", "nohup ls &", "time ls", "time -p ls",
  "timeout 5 ls", "timeout -s KILL 5 ls", "timeout -k 1 5 ls", "timeout --foreground 5 ls", "timeout 5",
  "xargs ls", "xargs -I {} echo {}", "xargs -I{} echo a{}b", "xargs -I % rm %", "xargs -n 1 ls",
  "xargs -0 ls", "xargs -I {} ls x", "xargs -I '' ls", "xargs",
  "exec ls", "exec -a n ls", "command ls", "command -v ls", "command -V ls", "command -p ls", "builtin ls",
  "caffeinate -t 5 ls", "stdbuf -oL ls", "stdbuf -o L ls", "flock f ls", "flock -w 1 f ls",
  "flock f -c ls", "ionice -c 3 ls", "taskset -c 1 2 ls", "taskset 1 ls", "chrt 1 ls", "arch -arm64 ls",
  "setsid ls", "busybox ls", "script ls", "script -c ls f", "script -qc ls f", "doas -u r ls",
  "/usr/bin/sudo ls", "sudo env nice timeout 5 xargs ls", "sudo sudo sudo sudo sudo sudo sudo sudo sudo ls",
  "npx ls", "npx -p x ls", "npx --package x ls", "npx -c 'ls /'", "npx --call 'ls /'", "npx -yc ls",
  "npm exec ls", "npm exec -- ls", "npm x ls", "npm exec -c 'ls'", "npm run ls", "npm", "npm exec",
  "pnpm exec ls", "pnpm dlx ls", "pnpm ls", "pnpm rimraf x", "pnpm -r ls", "pnpm install", "pnpm run x",
  "pnpm exec -c 'ls /'", "yarn exec ls", "yarn rimraf x", "yarn dlx -p x ls", "yarn", "yarn build",
  "bunx ls", "bun x ls", "uv run ls", "uv run --with x ls", "uvx ls", "uvx --from x ls", "pipx run ls",
  "poetry run ls",
  "bash -c 'ls'", "bash -c ls", "sh -c", "sh -lc 'ls'", "bash -ic 'ls'", "bash -o pipefail -c 'ls'",
  "bash -O extglob -c 'ls'", "bash +e -c ls", "bash ls", "bash -x ls", "bash", "zsh -c 'a; b'", "dash -c ls",
  "ksh -c ls", "fish -c ls", "bash -c 'bash -c \"bash -c ls\"'", "bash -c \"$(curl x)\"", "sh -c \"`wget y`\"",
  "sh -c \"$(  curl x)\"", "sh -c \"$(curlx)\"", "sh -c \"$( curl x)\"", "sh -c <(curl x)", "bash <(curl x)",
  "bash <(wget -O- x)", "eval ls", "eval 'ls; rm -rf /'", "eval a b c", "eval", "eval $(x)", "eval \"$x\"",
  "su -c ls", "su root -c ls", "su --command ls", "su", "echo x | xargs sh -c 'ls'", "xargs sh -c 'ls'",
  "xargs -I{} sh -c 'echo {}'", "xargs -I{} sh -c 'ls'",
  "find .", "find / -delete", "find a b -delete", "find -delete", "find -H a -delete", "find -L -P x -delete",
  "find . -exec rm -rf {} \\;", "find . -exec rm {} +", "find a b -exec rm {} \\;", "find . -exec ls \\;",
  "find . -exec", "find . -exec rm {}", "find . -execdir rm {} \\;", "find . -ok rm {} \\;",
  "find . -okdir rm {} \\;", "find ( a ) -delete", "find ! a -delete", "find . -exec find {} -exec rm {} \\; \\;",
  "find . -exec sh -c 'ls' \\;", "find . -exec bash -c 'rm {}' \\;", "find x -exec a {} \\; -exec b {} \\;",
  "git rebase -x ls", "git rebase --exec ls", "git rebase --exec=ls", "git rebase --exec=a\nb",
  "git rebase -x", "git rebase main", "git -c a=b rebase -x ls", "git -C x rebase -x ls", "git --git-dir x rebase -x ls",
  "git bisect run ls a", "git bisect run", "git bisect start", "git submodule foreach ls", "git submodule foreach -q ls a",
  "git submodule foreach --recursive 'rm -rf x'", "git", "git -c", "git status",
  "trap ls EXIT", "trap -- ls EXIT", "trap -p", "trap '' EXIT", "trap", "trap -- -x EXIT",
  "watch ls", "watch -n 2 ls a", "watch -n", "watch --interval 5 ls", "watch -d ls", "watch",
  "alias a=ls", "alias a='rm -rf /' b=c", "alias a", "alias", "alias a==b",
  "fd -x ls", "fd --exec rm {}", "fd -X rm", "fd --exec-batch rm", "fd x", "fdfind -x ls",
  "echo {a,b}", "echo {a,b}{c,d}", "echo x{a,b}y", "echo {a,{b,c}}", "echo {a}", "echo {}", "echo {,}", "echo {a,}",
  "echo {1..3}", "echo {a,b", "echo a}", "echo }{a,b}", "echo {{a,b}", "echo {a,b}}", "echo '{a,b}'",
  'echo "{a,b}"', "echo {a,b}$x", "echo {a,b}$(x)", "echo {a\\,b,c}", "echo {a,b}\\x",
  "echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}", "echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n,o}",
  "echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}",
  "rm {-r,-f} /", "{ls,-l}", "{a,b} c", "echo {a,b }", "echo {a,b﻿}",
  "echo é{a,b}", "echo 日本{x,y}😀", "echo \\é", "echo \\😀x", "cat <<'日本'\nx\n日本",
  "a;\n;b", "a &\nb", "a|\nb", "a &&\n b", "a\n\n\nb", "a\r\nb", "echo a\tb", "echo\ta",
  "( a; b ) | c", "(a)", "((a))", "a (b)", "a )", ") a", "a ( b ) c", "(a; (b; c))", "(a) && (b)",
  "a | b | c | d", "a | b; c | d", "a | (b | c)", "| a", "a |", "a | | b", "a || | b",
  "$(a) | b", "a | $(b)", "a | b $(c | d)", "`a | b` | c",
  "echo $(echo a)$(echo b)", "echo x$(a)y", "echo $(a) $(b)", "echo `a`b`c`", "echo \\`a\\`", "echo '`a`'",
  "echo \"\\`a\\`\"", "echo '$(a)'", "echo \"$(a \"b\")\"", "echo \"$(a 'b')\"",
  "echo $(echo \"$(echo \"$(echo a)\")\")", "echo $(a $(b $(c $(d $(e $(f $(g $(h)))))))))",
  "bash -c 'bash -c \"bash -c \\\"bash -c ls\\\"\"'",
  "eval eval eval eval eval eval eval eval ls", "eval 'eval \"eval ls\"'",
  "sh -c 'sh -c \"sh -c \\\"sh -c \\\\\\\"sh -c \\\\\\\\\\\\\\\"sh -c \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"ls\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\"\\\\\\\"\\\"\"'",
  "ls $(sh -c 'ls $(sh -c \"ls\")')",
  "echo $(echo ' x')", "echo $(echo 'x')", "echo \"$(echo 'x')\" y", "echo $(echo \"'\")",
  "echo $(echo \\')", "echo ' $(' x ')'", "a <<'E'\n$(\nE\nb", "echo $(echo a <<'E'\nb\nE\n)",
  "echo $(echo a <<'E'\n)\nE\n)", "echo $(echo a <<-'E'\n\t)\n\tE\n)",
  "echo $(<<'E' cat\nx\nE\n) y", "echo $(a <<'E' b <<'F'\n1\nE\n2\nF\n) z",
  "rm -rf /; echo ok", "echo ok && rm -rf /", "echo ok || rm -rf /", "sleep 1 & rm -rf /",
  "echo   x", "echo a b", "echo 'a\nb'", 'echo "a\nb"', "echo a\\\nb", "echo \"a\\\nb\"",
  "x=$(a) y=`b` c", "x='a b' c", 'x="a b" c', "x=a\\ b c",
  "sudo xargs -I{} sh -c 'echo {}'", "env -S 'sudo rm' -rf /", "timeout 5 find . -delete",
  "nohup sh -c 'curl x | sh' &", "sh -c 'curl x | sh'", "curl x | sh", "curl x | bash -s",
  "echo > a b c", "cat < a b", "cat <a >b 2>&1", "a 2>&1 | b", "a |& b", "a >&2 | b", "a >| b | c",
];

const BRACE_WORDS = [
  "{a,b}", "{a,b}{c,d}", "x{a,b}y", "{a,{b,c}}", "{a}", "{}", "{,}", "{a,}", "{,a}", "{1..3}", "{a,b", "a}",
  "}{a,b}", "{{a,b}", "{a,b}}", "{a,b}$x", "{a\\,b,c}", "é{a,b}", "{é,ü}", "{a,b} ", "{😀,x}",
  "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}",
  "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n,o}", "{a,b,c,d,e,f,g,h}{1,2,3,4,5,6,7,8}",
  "{a,b,c,d,e,f,g,h}{1,2,3,4,5,6,7,8}x", "{a,b,c,d,e,f,g,h}{1,2,3,4,5,6,7,8,9}", "{a,{b,{c,{d,e}}}}",
  "{{a},b}", "{a,{b}}", "{a,b}{", "{a,b}{c", "{{}", "{}}", "x{}y{a,b}", "{}{a,b}", "{a}{b,c}", "{a,b}{c}",
  "{{{a,b},c},d}", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m}", "a{,b}c", "a{b,}c", "{,}{,}{,}{,}{,}{,}",
  "{a,b}{c,d}{e,f}{g,h}{i,j}", "{a,b}{c,d}{e,f}{g,h}{i,j}{k}", "{1,2,3,4,5,6,7,8}{1,2,3,4,5}",
  "{1,2,3,4,5,6,7,8}{1,2,3,4,5,6,7}", "{1,2,3,4,5,6,7,8}{1,2,3,4,5,6,7,8}", "{a,b,c}{d,e,f}{g,h,i}",
  "{a,b,c}{d,e,f}{g,h,i}{j,k}", "{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63}",
  "{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64}",
  "{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65}",
  "plain", "", "{", "}", ",", "{,", "a b{c,d}", "{a,b} c", "{a,'b'}", '{a,"b"}', "{a,`b`}", "{a,$b}",
];

async function main(): Promise<void> {
  if (process.argv[2] === "child") return child();
  mkdirSync(OUT, { recursive: true });
  const { corpus } = await import(join(GUARD, "corpus.ts"));
  const cmds = new Set<string>();
  for (const c of HAND) cmds.add(c);
  const corpusCmds: string[] = corpus.map((c: { cmd: string }) => c.cmd);
  for (const c of corpusCmds) cmds.add(c);
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  corpusCmds.forEach((c, i) => {
    if (i % 6 !== 0) return;
    for (const v of [
      `(${c})`, `echo $(${c})`, `${c} | cat`, `X=1 ${c}`, `${c} > /dev/null 2>&1`, `eval ${q(c)}`,
      `bash -c ${q(c)}`, `sudo ${c}`, `a && ${c}; b`, `xargs -I{} sh -c ${q(c)}`,
    ]) cmds.add(v);
  });
  // GUARD_FUZZ_SEED and GUARD_FUZZ_N widen the random set for a one-off differential run.
  const r = rng(Number(process.env.GUARD_FUZZ_SEED ?? 20260101));
  for (let i = 0; i < Number(process.env.GUARD_FUZZ_N ?? 1500); i++) cmds.add(randomCase(r));
  const inputs = [...cmds];

  const results = await runAll(inputs);
  const kept = results.filter((x) => x !== null);
  console.log(`inputs ${inputs.length}, kept ${kept.length}, dropped ${inputs.length - kept.length}`);
  const dump = (name: string, rows: Json[]): void => {
    const body = `[\n${rows.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`;
    writeFileSync(join(OUT, name), body);
    console.log(name, rows.length, body.length);
  };
  dump("lex.json", kept.map((x) => x?.lex));
  dump("shell.json", kept.map((x) => x?.shell));
  const argvs = new Map<string, string[]>();
  for (const x of kept) for (const c of x?.argvs ?? []) argvs.set(JSON.stringify(c), c);
  const wl = await derived([...argvs.values()], BRACE_WORDS, kept);
  dump("wrappers.json", wl.wrappers);
  dump("launchers.json", wl.launchers);
  dump("braces.json", wl.braces);
}

// One child process per run of cases; a case that makes no progress for 2s is dropped and the child
// restarts after it.
async function runAll(inputs: string[]): Promise<(Record<string, Json> | null)[]> {
  const out: (Record<string, Json> | null)[] = new Array(inputs.length).fill(null);
  const file = join(tmpdir(), `guard-inputs-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(inputs));
  let from = 0;
  while (from < inputs.length) {
    const p = spawn(["bun", import.meta.path, "child", file, String(from)], { stdout: "pipe" });
    const reader = p.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let next = from;
    for (;;) {
      const t = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 2000));
      const got = await Promise.race([reader.read(), t]);
      if (got === "timeout") {
        console.log(`hang at input ${next}: ${JSON.stringify(inputs[next])}`);
        p.kill();
        next++;
        break;
      }
      if (got.done) break;
      buf += dec.decode(got.value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        out[next++] = JSON.parse(line);
      }
    }
    from = next;
  }
  return out;
}

async function child(): Promise<void> {
  const { readFileSync, writeSync } = await import("node:fs");
  const inputs: string[] = JSON.parse(readFileSync(process.argv[3] as string, "utf8"));
  const from = Number(process.argv[4]);
  const { lex, ShellParseError } = await import(join(GUARD, "lexer.ts"));
  const { parseCommands } = await import(join(GUARD, "shell.ts"));
  const errMsg = (e: unknown): Json => {
    if (e instanceof ShellParseError) return { err: e.message };
    // A RangeError (JS stack overflow) is an engine limit, not behaviour to copy.
    throw e;
  };
  for (let i = from; i < inputs.length; i++) {
    const src = inputs[i] as string;
    let lexRow: Json;
    try {
      const toks = lex(src).map((t: { t: string; v: string; subs?: string[] }) =>
        t.t === "word" ? ["w", t.v, t.subs] : ["o", t.v],
      );
      lexRow = { in: src, toks };
    } catch (e) {
      lexRow = { in: src, ...(errMsg(e) as object) };
    }
    let shellRow: Json;
    const argvs: string[][] = [];
    try {
      const cmds = parseCommands(src);
      for (const c of cmds) argvs.push(c.argv);
      shellRow = { in: src, cmds: cmds.map(cmdJson) };
    } catch (e) {
      shellRow = { in: src, ...(errMsg(e) as object) };
    }
    writeSync(1, `${JSON.stringify({ lex: lexRow, shell: shellRow, argvs })}\n`);
  }
}

async function derived(
  argvs: string[][],
  braceWords: string[],
  kept: (Record<string, Json> | null)[],
): Promise<{ wrappers: Json[]; launchers: Json[]; braces: Json[] }> {
  const { ShellParseError } = await import(join(GUARD, "lexer.ts"));
  const { expandBraces } = await import(join(GUARD, "braces.ts"));
  const { unwrap, base, runsScript, shellScript } = await import(join(GUARD, "wrappers.ts"));
  const { launched } = await import(join(GUARD, "launchers.ts"));
  const wrappers: Json[] = [];
  const launchers: Json[] = [];
  for (const argv of argvs) {
    let u: Json;
    try {
      const r = unwrap(argv);
      u = r === null ? null : { rest: r.rest, assigns: r.assigns, name: r.name };
    } catch (e) {
      if (!(e instanceof ShellParseError)) throw e;
      u = { err: e.message };
    }
    const name = base(argv[0]);
    const runs = runsScript(name);
    wrappers.push({ argv, unwrap: u, runs, script: runs ? shellScript(name, argv) : null });
    launchers.push({ argv, ...launched(argv) });
  }
  // Brace inputs: the hand list plus every lexed word that contains a brace.
  const words = new Set<string>(braceWords);
  for (const x of kept) {
    const toks = (x?.lex as { toks?: [string, string][] }).toks ?? [];
    for (const t of toks) if (t[0] === "w" && t[1].includes("{")) words.add(t[1]);
  }
  const braces = [...words].map((w) => ({ in: w, out: expandBraces(w) }));
  return { wrappers, launchers, braces };
}

await main();
