import { ask, type Ctx, deny, isInside, type L1Result, type Rule, resolvePath } from "./rules-core";
import { base, type Cmd } from "./shell";

const ENGINES = new Set(["docker", "podman", "nerdctl", "docker-compose", "podman-compose"]);
const RUNNING = new Set(["run", "exec", "create", "up"]);
const GLOBAL_VALUE_FLAGS = new Set([
  "-H",
  "--host",
  "--context",
  "-c",
  "--config",
  "--connection",
  "-f",
  "--file",
  "-p",
]);
const HOST_PATH = /^(\/|~|\$|\.)/;

function subcommand(cmd: Cmd): string {
  const args = cmd.argv.slice(1);
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const a = args[i] as string;
    if (a.startsWith("-")) i += GLOBAL_VALUE_FLAGS.has(a) ? 1 : 0;
    else words.push(a);
  }
  const wrapped = ["compose", "container"].includes(words[0] ?? "");
  return (wrapped ? words[1] : words[0]) ?? "";
}

function mountSources(args: string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const vol =
      /^(?:-v|--volume=?)(.+)$/.exec(a)?.[1] ??
      (/^(-v|--volume)$/.test(a) ? args[i + 1] : undefined);
    if (vol) out.push(vol.split(":")[0] as string);
    const mount = /^--mount=?(.*)$/.exec(a)?.[1] || (a === "--mount" ? args[i + 1] : undefined);
    const src = mount ? /(?:source|src)=([^,]+)/.exec(mount)?.[1] : undefined;
    if (src) out.push(src);
  });
  return out.filter((p) => HOST_PATH.test(p));
}

function dangerous(cmd: Cmd, scope: Ctx): string | null {
  const args = cmd.argv.slice(1);
  if (args.some((a) => a.includes("docker.sock"))) return "the docker socket";
  if (args.some((a) => /^--privileged(=(true|1))?$/.test(a))) return "--privileged";
  if (args.includes("--pid=host") || args.some((a, i) => a === "--pid" && args[i + 1] === "host")) {
    return "--pid=host";
  }
  const outside = mountSources(args).find((p) => {
    const abs = resolvePath(p, scope);
    return abs !== null && !isInside(abs, scope);
  });
  return outside === undefined ? null : `a bind mount of ${outside}`;
}

// The container daemon runs outside the sandbox, so what a container may touch is judged here.
export const container: Rule = (cmd, scope): L1Result | null => {
  const risky = dangerous(cmd, scope);
  if (
    risky &&
    (ENGINES.has(base(cmd.argv[0])) || cmd.argv.some((a) => a.includes("docker.sock")))
  ) {
    return deny("container.host-access", `container access to ${risky} bypasses the sandbox`);
  }
  if (!ENGINES.has(base(cmd.argv[0]))) return null;
  return RUNNING.has(subcommand(cmd))
    ? ask("container.run", "containers run outside the sandbox", "shell")
    : null;
};
