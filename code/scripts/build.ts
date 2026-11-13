import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";

export const TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export type Target = (typeof TARGETS)[number];

export function hostTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target {
  const name = `${platform}-${arch}`;
  const found = TARGETS.find((target) => target === name);
  if (!found) throw new Error(`no build target for ${name}`);
  return found;
}

export function parseTarget(value: string): Target {
  if (value === "host") return hostTarget();
  const found = TARGETS.find((target) => target === value);
  if (!found) throw new Error(`unknown target "${value}", use ${TARGETS.join(", ")} or host`);
  return found;
}

export type BuildOptions = { target: Target; out: string; version?: string; commit?: string };

// Baked into the binary so a self-update can diff against what is actually running. Empty when
// the source is not a git checkout.
function headCommit(root: string): string {
  const res = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stderr: "ignore" });
  return res.exitCode === 0 ? res.stdout.toString().trim() : "";
}

// Returns the binary path; the checksum goes next to it as <binary>.sha256 in `sha256sum` format.
export async function build(options: BuildOptions): Promise<string> {
  const root = join(import.meta.dir, "..");
  const version = options.version ?? pkg.version;
  const outfile = resolve(options.out, `harness-${options.target}`);
  mkdirSync(options.out, { recursive: true });
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=bun-${options.target}`,
      "--define",
      `HARNESS_VERSION=${JSON.stringify(version)}`,
      "--define",
      `HARNESS_COMMIT=${JSON.stringify(options.commit ?? headCommit(root))}`,
      join(root, "src/main.ts"),
      "--outfile",
      outfile,
    ],
    { cwd: resolve(options.out), stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error(`bun build failed for ${options.target}`);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(outfile).arrayBuffer());
  await Bun.write(`${outfile}.sha256`, `${hasher.digest("hex")}  harness-${options.target}\n`);
  return outfile;
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const target = parseTarget(flag(args, "--target") ?? "host");
  const outfile = await build({ target, out: flag(args, "--out") ?? "dist" });
  console.log(outfile);
}
