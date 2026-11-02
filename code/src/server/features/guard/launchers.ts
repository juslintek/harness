import { base } from "./wrappers";

export interface Launched {
  scripts: string[];
  argvs: string[][];
}

const NOTHING: Launched = { scripts: [], argvs: [] };
const GIT_VALUE_FLAGS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);
const WATCH_VALUE_FLAGS = new Set(["-n", "--interval"]);

function gitSub(argv: string[]): { sub: string; rest: string[] } {
  let i = 1;
  while (i < argv.length && (argv[i] as string).startsWith("-")) {
    i += GIT_VALUE_FLAGS.has(argv[i] as string) ? 2 : 1;
  }
  return { sub: argv[i] ?? "", rest: argv.slice(i + 1) };
}

function gitLaunch(argv: string[]): Launched {
  const { sub, rest } = gitSub(argv);
  if (sub === "rebase") {
    const scripts = rest.flatMap((a, i) =>
      a === "-x" || a === "--exec" ? [rest[i + 1] ?? ""] : (/^--exec=(.*)/.exec(a)?.slice(1) ?? []),
    );
    return { scripts, argvs: [] };
  }
  if (sub === "bisect" && rest[0] === "run") return { scripts: [], argvs: [rest.slice(1)] };
  if (sub === "submodule" && rest[0] === "foreach") {
    return {
      scripts: [
        rest
          .filter((a) => !a.startsWith("-"))
          .slice(1)
          .join(" "),
      ],
      argvs: [],
    };
  }
  return NOTHING;
}

function watchScript(args: string[]): string {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (words.length === 0 && a.startsWith("-")) i += WATCH_VALUE_FLAGS.has(a) ? 1 : 0;
    else words.push(a);
  }
  return words.join(" ");
}

// Commands that run a string or argv later or elsewhere; the inner command is judged like a typed one.
export function launched(argv: string[]): Launched {
  const name = base(argv[0]);
  if (name === "git") return gitLaunch(argv);
  if (name === "trap") {
    const action = argv[1] === "--" ? argv[2] : argv[1];
    return action && !action.startsWith("-") ? { scripts: [action], argvs: [] } : NOTHING;
  }
  if (name === "watch") return { scripts: [watchScript(argv.slice(1))], argvs: [] };
  if (name === "alias") {
    const values = argv
      .slice(1)
      .flatMap((a) => (a.includes("=") ? [a.slice(a.indexOf("=") + 1)] : []));
    return { scripts: values, argvs: [] };
  }
  if (name === "fd" || name === "fdfind") {
    const i = argv.findIndex((a) => ["-x", "--exec", "-X", "--exec-batch"].includes(a));
    return i < 0 ? NOTHING : { scripts: [], argvs: [argv.slice(i + 1)] };
  }
  return NOTHING;
}
