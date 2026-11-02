import { basename } from "node:path";
import { ask, type Ctx, deny, type L1Result, resolvePath } from "./rules-core";
import { RUNNER } from "./rules-exec";
import { isSecretPath } from "./rules-secret";
import { base, type Cmd } from "./shell";

const FETCHERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c"]);
const UPLOAD_FLAGS = new Set([
  "-d",
  "--data",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-F",
  "--form",
  "--json",
]);

function uploadsFile(args: string[]): boolean {
  return args.some((a, i) => {
    if (a === "-T" || /^--(upload-file|post-file|body-file)(=|$)/.test(a)) return true;
    if (/^(-d|--data[a-z-]*|-F|--form|--json)=?@/.test(a)) return true;
    return UPLOAD_FLAGS.has(a) && /(^|=)@/.test(args[i + 1] ?? "");
  });
}

export function network(cmd: Cmd, scope: Ctx): L1Result | null {
  const name = base(cmd.argv[0]);
  if (cmd.downloadExec) return deny("net.fetch-exec", "downloaded code is executed", "network");
  if (["nc", "ncat", "netcat", "socat"].includes(name)) {
    const leaks = [...cmd.argv, ...cmd.redirects.map((r) => r.path)].some((w) =>
      isSecretPath(w, scope),
    );
    return leaks
      ? deny("net.exfil-secret", "sends a credential file over a raw socket", "network")
      : ask("net.raw-socket", "raw sockets can exfiltrate data", "network");
  }
  if (name === "ssh" || name === "sftp") {
    return ask("net.ssh", "a remote shell runs commands the guard cannot see", "network");
  }
  if (!FETCHERS.has(name)) return null;
  if (cmd.piped && cmd.after.some((c) => RUNNER.test(base(c.argv[0])))) {
    return deny("net.pipe-to-shell", "downloaded content is piped into an interpreter", "network");
  }
  if (cmd.argv.some((w) => isSecretPath(w, scope))) {
    return deny("net.exfil-secret", "sends a credential file over the network", "network");
  }
  return uploadsFile(cmd.argv.slice(1))
    ? ask("net.upload", "uploads a local file", "network")
    : null;
}

// Files a fetcher saves are remembered so a later `sh a.sh` or `./a.sh` is judged as run-what-you-downloaded.
export function recordFetch(cmd: Cmd, scope: Ctx, fetched: Set<string>): void {
  if (!FETCHERS.has(base(cmd.argv[0]))) return;
  const outputs = cmd.redirects.filter((r) => r.op === ">").map((r) => r.path);
  if (cmd.argv.includes("-O")) {
    outputs.push(...cmd.argv.filter((a) => /^[^-].*\/[^/]+$/.test(a)).map((u) => basename(u)));
  }
  cmd.argv.forEach((a, i) => {
    if (/^(-o|--output|-O|--output-document)$/.test(a) && cmd.argv[i + 1]) {
      outputs.push(cmd.argv[i + 1] as string);
    }
  });
  for (const o of outputs) {
    const abs = resolvePath(o, scope);
    if (abs) fetched.add(abs);
  }
}

export function runsFetched(cmd: Cmd, scope: Ctx, fetched: Set<string>): L1Result | null {
  if (fetched.size === 0) return null;
  const hits = (w: string | undefined): boolean => {
    const abs = w ? resolvePath(w, scope) : null;
    return abs !== null && fetched.has(abs);
  };
  const runs = RUNNER.test(base(cmd.argv[0])) || ["source", "."].includes(base(cmd.argv[0]));
  return hits(cmd.argv[0]) || (runs && cmd.argv.slice(1).some(hits))
    ? deny("net.fetch-exec", "runs a file downloaded earlier in this command line", "network")
    : null;
}
