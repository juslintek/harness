import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
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
export type PackageOptions = BuildOptions & { uiDist?: string };

// Baked into the binary so a self-update can diff against what is actually running. Empty when
// the source is not a git checkout.
function headCommit(root: string): string {
  const res = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stderr: "ignore" });
  return res.exitCode === 0 ? res.stdout.toString().trim() : "";
}

async function writeSha256(filePath: string, fileName: string): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(filePath).arrayBuffer());
  await Bun.write(`${filePath}.sha256`, `${hasher.digest("hex")}  ${fileName}\n`);
}

async function compileBinary(root: string, options: BuildOptions, outfile: string): Promise<void> {
  const version = options.version ?? pkg.version;
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
    { cwd: resolve(outfile, ".."), stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error(`bun build failed for ${options.target}`);
  chmodSync(outfile, 0o755);
}

// Returns the binary path; the checksum goes next to it as <binary>.sha256 in `sha256sum` format.
export async function build(options: BuildOptions): Promise<string> {
  const root = join(import.meta.dir, "..");
  const fileName = `harness-${options.target}`;
  const outfile = resolve(options.out, fileName);
  mkdirSync(options.out, { recursive: true });
  await compileBinary(root, options, outfile);
  await writeSha256(outfile, fileName);
  return outfile;
}

const ADAPTER_ENTRIES = [
  ["claude-agent-acp.mjs", "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"],
  ["codex-acp.mjs", "node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
] as const;

async function bundleAdapters(root: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const [name, relEntry] of ADAPTER_ENTRIES) {
    const entry = join(root, relEntry);
    if (!existsSync(entry)) throw new Error(`ACP adapter entry not found: ${entry}`);
    const proc = Bun.spawn(
      [process.execPath, "build", entry, "--target=bun", "--outfile", join(outDir, name)],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) throw new Error(`failed to bundle ${name}`);
  }
}

function stageLinuxSeccomp(root: string, target: Target, stage: string): boolean {
  if (!target.startsWith("linux-")) return false;
  const arch = target.slice("linux-".length);
  const src = join(
    root,
    "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp",
    arch,
    "apply-seccomp",
  );
  if (!existsSync(src)) throw new Error(`Linux seccomp helper missing: ${src}`);
  const destDir = join(stage, "vendor", "seccomp", arch);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "apply-seccomp");
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  return true;
}

// Packages a self-contained tarball (harness binary, ui/dist, bundled ACP adapters, and Linux
// seccomp helper) with a sibling .sha256 file so it runs cleanly outside any source checkout.
export async function packageDistribution(options: PackageOptions): Promise<string> {
  const root = join(import.meta.dir, "..");
  const uiDist = resolve(options.uiDist ?? join(root, "../ui/dist"));
  if (!existsSync(join(uiDist, "index.html"))) {
    throw new Error(`UI build not found at ${uiDist} (run \`cd ui && bun run build\` first)`);
  }
  mkdirSync(options.out, { recursive: true });
  const archiveName = `harness-${options.target}.tar.gz`;
  const archivePath = resolve(options.out, archiveName);
  const stage = mkdtempSync(join(tmpdir(), "harness-pkg-"));
  try {
    await compileBinary(root, options, join(stage, "harness"));
    cpSync(uiDist, join(stage, "ui"), { recursive: true });
    await bundleAdapters(root, join(stage, "adapters"));
    const entries = ["harness", "ui", "adapters"];
    if (stageLinuxSeccomp(root, options.target, stage)) entries.push("vendor");
    const tar = Bun.spawn(["tar", "-C", stage, "-czf", archivePath, ...entries], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await tar.exited) !== 0) throw new Error(`tar failed for ${archiveName}`);
    await writeSha256(archivePath, archiveName);
    return archivePath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const target = parseTarget(flag(args, "--target") ?? "host");
  const out = flag(args, "--out") ?? "dist";
  const uiDist = flag(args, "--ui-dist");
  const outfile = args.includes("--package")
    ? await packageDistribution({ target, out, ...(uiDist ? { uiDist } : {}) })
    : await build({ target, out });
  console.log(outfile);
}
