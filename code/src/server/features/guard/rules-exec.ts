import { ask, type Ctx, isInside, type L1Result, resolvePath } from "./rules-core";
import { base, type Cmd } from "./shell";

type ExecRule = (cmd: Cmd, scope: Ctx) => L1Result | null;

// Interpreters that take a program from stdin when no script operand is given.
export const RUNNER: RegExp =
  /^(sh|bash|zsh|dash|ksh|fish|python[\d.]*|node(?:js)?|perl|ruby|php|deno|bun|osascript)$/;
const INLINE_FLAG: Array<[RegExp, RegExp]> = [
  [/^python[\d.]*$/, /^-[a-zA-Z]*c/],
  [/^perl$/, /^-[a-zA-Z]*[eE]/],
  [/^ruby$/, /^-[a-zA-Z]*e/],
  [/^node(?:js)?$/, /^(--eval|--print)(=|$)|^-[a-zA-Z]*[ep]/],
  [/^bun$/, /^(--eval|--print)(=|$)|^-[ep]/],
  [/^php$/, /^-[a-zA-Z]*r/],
  [/^osascript$/, /^-[a-zA-Z]*e/],
];
const STDIN_PATH = /^(\/dev\/(stdin|fd\/\d+)|\/proc\/self\/fd\/\d+)$/;
const VALUE_FLAGS = new Set(["-W", "-X", "-Q"]);

// Names that expand or split in the shell cannot be judged from the text.
export const dynamicName: ExecRule = (cmd) => {
  const name = cmd.argv[0] ?? "";
  const glob = name.includes("[") && name !== "[" && name !== "[[";
  return glob || /[$`{}*?]|<stdin>|<\(/.test(name)
    ? ask("exec.dynamic-command", `cannot tell which command ${name} runs`)
    : null;
};

function flagsBeforeOperand(args: string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--" || !a.startsWith("-") || a === "-") break;
    flags.push(a);
    if (VALUE_FLAGS.has(a)) i++;
  }
  return flags;
}

export const inlineCode: ExecRule = (cmd) => {
  const name = base(cmd.argv[0]);
  const args = cmd.argv.slice(1);
  const inline =
    (name === "deno" && args[0] === "eval") ||
    (/^[gmn]?awk$/.test(name) && args.some((a) => a.includes("system("))) ||
    INLINE_FLAG.some(([n, f]) => n.test(name) && flagsBeforeOperand(args).some((a) => f.test(a)));
  return inline ? ask("exec.inline-code", `${name} runs code given on the command line`) : null;
};

export const stdinScript: ExecRule = (cmd) => {
  const name = base(cmd.argv[0]);
  if (!RUNNER.test(name)) return null;
  const args = cmd.argv.slice(1);
  const operand = args.find((a) => !a.startsWith("-") || a === "-");
  if (operand !== undefined && (STDIN_PATH.test(operand) || /^[<>]\(/.test(operand))) {
    return ask("exec.stdin-script", `${name} would run a script it receives on stdin`);
  }
  const reads = cmd.fromPipe || cmd.hereString || cmd.redirects.some((r) => r.op === "<");
  const fromStdin = (operand === undefined || operand === "-" || args.includes("-s")) && reads;
  return fromStdin || args.some((a) => a.includes("<stdin>"))
    ? ask("exec.stdin-script", `${name} would run a script it receives on stdin`)
    : null;
};

export const sourceOutside: ExecRule = (cmd, scope) => {
  const name = base(cmd.argv[0]);
  if (name !== "source" && name !== ".") return null;
  const abs = resolvePath(cmd.argv[1] ?? "", scope);
  return abs !== null && isInside(abs, scope)
    ? null
    : ask("exec.source-outside", "sourcing a script from outside the task root");
};

export const escalate: ExecRule = (cmd) => {
  const name = base(cmd.argv[0]);
  return ["su", "parallel", "chroot", "nsenter", "unshare", "sandbox-exec"].includes(name)
    ? ask("exec.escalate", `${name} runs other commands the guard cannot see`)
    : null;
};
