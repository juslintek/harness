import { expandBraces } from "./braces";
import { launched } from "./launchers";
import { lex, ShellParseError } from "./lexer";
import { base, runsScript, shellScript, unwrap } from "./wrappers";

export { base };

interface Redirect {
  op: ">" | "<";
  path: string;
}

export interface Cmd {
  argv: string[];
  assigns: string[];
  piped: boolean;
  fromPipe: boolean;
  hereString: boolean;
  redirects: Redirect[];
  downloadExec: boolean;
  after: Cmd[];
  mark?: "(" | ")";
}

interface Stmt {
  words: string[];
  redirects: Redirect[];
  hereString: boolean;
  piped: boolean;
}

type Pending = ">" | "<" | "<<<" | null;

const MAX_DEPTH = 6;
const MAX_LENGTH = 100_000;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
]);
const FETCH_SUBST = /^\s*(\$\(|`|<\()\s*(curl|wget)\b/;
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function plain(argv: string[]): Cmd {
  return {
    argv,
    assigns: [],
    piped: false,
    fromPipe: false,
    hereString: false,
    redirects: [],
    downloadExec: false,
    after: [],
  };
}

const mark = (m: "(" | ")"): Cmd => ({ ...plain([]), mark: m });

function emptyStmt(): Stmt {
  return { words: [], redirects: [], hereString: false, piped: false };
}

function findStarts(argv: string[]): { starts: string[]; from: number } {
  let i = 1;
  while (["-H", "-L", "-P"].includes(argv[i] ?? "")) i++;
  const starts: string[] = [];
  while (i < argv.length && !/^(-|\(|!|\))/.test(argv[i] as string))
    starts.push(argv[i++] as string);
  return { starts: starts.length ? starts : ["."], from: i };
}

// `{}` is replaced by each start path so `find / -exec rm -rf {} \;` is judged as `rm -rf /`.
function expandExec(body: string[], starts: string[], depth: number): Cmd[] {
  const targets = body.some((w) => w.includes("{}")) ? starts : [""];
  return targets.flatMap((s) =>
    resolve({ ...emptyStmt(), words: body.map((w) => w.replaceAll("{}", s)) }, depth),
  );
}

function findExtras(argv: string[], depth: number): Cmd[] {
  const { starts, from } = findStarts(argv);
  const out: Cmd[] = [];
  for (let i = from; i < argv.length; i++) {
    if (argv[i] === "-delete") out.push(plain(["rm", "-r", "--find", ...starts]));
    else if (FIND_EXEC.has(argv[i] as string)) {
      let end = i + 1;
      while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end++;
      out.push(...expandExec(argv.slice(i + 1, end), starts, depth));
      i = end;
    }
  }
  return out;
}

function stripPrefix(stmt: Stmt): { argv: string[]; assigns: string[] } {
  let argv = [...stmt.words];
  while (argv.length && RESERVED.has(argv[0] as string)) argv.shift();
  const assigns: string[] = [];
  const takeAssigns = (): void => {
    while (argv.length && ASSIGN.test(argv[0] as string)) assigns.push(argv.shift() as string);
  };
  takeAssigns();
  for (let n = 0; n < 8; n++) {
    const un = unwrap(argv);
    if (!un) break;
    argv = un.rest;
    assigns.push(...un.assigns);
    takeAssigns();
  }
  return { argv, assigns };
}

function resolve(rawStmt: Stmt, depth: number): Cmd[] {
  const stmt = { ...rawStmt, words: rawStmt.words.flatMap(expandBraces) };
  const { argv, assigns } = stripPrefix(stmt);
  const name = base(argv[0]);
  const runs = runsScript(name);
  const cmd: Cmd = {
    ...plain(argv),
    assigns,
    piped: stmt.piped,
    hereString: stmt.hereString,
    redirects: stmt.redirects,
    downloadExec: runs && argv.some((a) => FETCH_SUBST.test(a)),
  };
  const script = runs ? shellScript(name, argv) : null;
  if (script?.includes("<stdin>")) throw new ShellParseError("script comes from stdin");
  // eval runs in the current shell, so a `cd` inside it must stay visible to the rest of the line.
  const extras =
    script === null
      ? []
      : name === "eval"
        ? parseCommands(script, depth + 1)
        : scoped(script, depth);
  return [
    cmd,
    ...extras,
    ...launchedCmds(argv, depth),
    ...(name === "find" ? findExtras(argv, depth) : []),
  ];
}

function launchedCmds(argv: string[], depth: number): Cmd[] {
  const { scripts, argvs } = launched(argv);
  return [
    ...scripts.flatMap((s) => parseCommands(s, depth + 1)),
    ...argvs.flatMap((words) => resolve({ ...emptyStmt(), words }, depth + 1)),
  ];
}

// Child shells and substitutions get their own cwd scope.
function scoped(src: string, depth: number): Cmd[] {
  return [mark("("), ...parseCommands(src, depth + 1), mark(")")];
}

function linkPipelines(group: Cmd[]): void {
  group.forEach((c, i) => {
    c.after = group.slice(i + 1);
    c.fromPipe = i > 0;
  });
}

export function parseCommands(src: string, depth = 0): Cmd[] {
  if (depth > MAX_DEPTH || src.length > MAX_LENGTH) throw new ShellParseError("too complex");
  const out: Cmd[] = [];
  let stmt = emptyStmt();
  let subs: Cmd[] = [];
  let group: Cmd[] = [];
  let pending: Pending = null;
  const endStmt = (op: string): void => {
    stmt.piped = op === "|";
    const cmds = resolve(stmt, depth);
    out.push(...subs, ...cmds);
    group.push(cmds[0] as Cmd);
    if (!stmt.piped) {
      linkPipelines(group);
      group = [];
    }
    subs = [];
    stmt = emptyStmt();
    if (op === "(" || op === ")") out.push(mark(op));
  };
  for (const t of lex(src)) {
    if (t.t === "op") {
      if (t.v === ">" || t.v === "<" || t.v === "<<<") pending = t.v;
      else endStmt(t.v);
      continue;
    }
    subs.push(...t.subs.flatMap((s) => scoped(s, depth)));
    if (pending === null) stmt.words.push(t.v);
    else if (pending === "<<<") stmt.hereString = true;
    else stmt.redirects.push({ op: pending, path: t.v });
    pending = null;
  }
  endStmt(";");
  return out.filter(
    (c) => c.mark || c.argv.length > 0 || c.assigns.length > 0 || c.redirects.length > 0,
  );
}
