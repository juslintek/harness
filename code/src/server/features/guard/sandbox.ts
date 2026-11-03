import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface SandboxInput {
  runDir: string;
  worktree: string;
  gitCommonDir: string | null;
  // Required with gitCommonDir: the worktree's admin dir (<common>/worktrees/<name>) and its run branch.
  gitWorktreeDir?: string | null;
  branch?: string | null;
  agentId?: string | null;
  harnessHome: string;
  agentStateWrite: string[];
  agentEgress: string[];
  preset: "dev" | "offline" | "open-web";
  weakerNetworkIsolation: boolean;
  codexHome: string | null;
  // A manager reviews and delegates; it must not change code, so the worktree and git refs stay read-only.
  readOnlyWorktree?: boolean;
  // A read-only run still needs somewhere to run tests: a detached checkout of its own, whose admin
  // dir is the only git state it may write. Refs, objects and the run worktree stay read-only.
  scratch?: { path: string; gitDir: string };
}

export type SrtSettings = SandboxRuntimeConfig &
  Required<Pick<SandboxRuntimeConfig, "network" | "filesystem" | "enableWeakerNetworkIsolation">>;

const DEV_DOMAINS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "repo.packagist.org",
  "packagist.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "gitlab.com",
];

// ~/Library/Keychains is not denied: the Claude adapter reads its login from the Keychain inside srt (spikes.md 7.2).
const DENY_READ_HOME = [
  "~/.ssh",
  "~/.aws",
  "~/.config/gh",
  "~/.gnupg",
  "~/.netrc",
  "~/.docker/config.json",
  "~/.kube",
];

// Everything here is read by an agent CLI as code or config on its next start, possibly outside srt.
const underHome = (dir: string, names: string[]): string[] => names.map((n) => `${dir}/${n}`);

const DENY_WRITE_HOME = [
  ...underHome("~/.claude", [
    "settings.json",
    "settings.local.json",
    "hooks",
    "plugins",
    "agents",
    "commands",
    "skills",
    "output-styles",
    "CLAUDE.md",
    "rules",
    "shell-snapshots",
  ]),
  "~/.claude.json",
  ...underHome("~/.gemini", [
    "settings.json",
    "GEMINI.md",
    "skills",
    "extensions",
    "hooks",
    "config",
    "trustedFolders.json",
    ".env",
    "bin",
    "antigravity/mcp_config.json",
    "antigravity/bin",
    "antigravity/builtin",
    "antigravity-cli/settings.json",
    "antigravity-cli/mcp",
    "antigravity-cli/bin",
    "antigravity-cli/builtin",
    "antigravity-cli/plugin_data",
    "antigravity-acp/settings.json",
  ]),
  ...underHome("~/.copilot", [
    "mcp-config.json",
    "mcp.json",
    "extensions",
    "installed-plugins",
    "agents",
  ]),
  ...underHome("~/.cursor", ["mcp.json", "hooks.json", "extensions", "rules", "commands"]),
  "~/.junie/mcp",
  ...underHome("~/.codex", ["config.toml", "rules", "hooks.json"]),
];

// A run may read its own agent's credentials and no other agent's. gemini and agy share ~/.gemini.
const GEMINI_CREDENTIALS = underHome("~/.gemini", [
  "oauth_creds.json",
  "google_accounts.json",
  "jetski-standalone-oauth-token",
  "antigravity-cli/antigravity-oauth-token",
]);
const AGENT_CREDENTIALS: Record<string, string[]> = {
  claude: ["~/.claude/.credentials.json"],
  codex: ["~/.codex/auth.json"],
  // Copilot's CLI login token lives in the keychain and cannot be file-denied. These are the
  // plaintext files the IDE plugin and the CLI's fallback store write.
  copilot: [
    "~/.config/github-copilot/oauth.json",
    "~/.config/github-copilot/apps.json",
    "~/.config/github-copilot/auth.db",
    "~/.copilot/config.json",
  ],
  gemini: GEMINI_CREDENTIALS,
  agy: GEMINI_CREDENTIALS,
};

function otherAgentCredentials(agentId: string | null | undefined): string[] {
  const own = new Set(agentId ? (AGENT_CREDENTIALS[agentId] ?? []) : []);
  return Object.values(AGENT_CREDENTIALS)
    .flat()
    .filter((p) => !own.has(p));
}

// The worktree's .git file points at the admin dir; rewriting it makes git read attacker-chosen config.
// Commit on the run branch needs only these: objects, the worktree's own admin dir, the branch ref, its lock, the packed-refs lock and reflog.
function gitWritable(input: SandboxInput): string[] {
  const common = input.gitCommonDir;
  if (!common) return [];
  const { gitWorktreeDir, branch } = input;
  if (!gitWorktreeDir || !branch)
    throw new Error("sandbox git access needs the worktree dir and the run branch");
  return [
    join(common, "objects"),
    gitWorktreeDir,
    join(common, "refs/heads", branch),
    join(common, "refs/heads", `${branch}.lock`),
    join(common, "logs/refs/heads", branch),
    // Git locks packed-refs during a ref update; the file itself stays denied, so the lock cannot be renamed over it.
    join(common, "packed-refs.lock"),
  ];
}

// Git resolves the common dir from commondir and the worktree from gitdir, and reads config.worktree as config.
const adminPointers = (admin: string): string[] =>
  ["commondir", "gitdir", "config.worktree"].map((name) => join(admin, name));

const scratchWritable = (input: SandboxInput): string[] =>
  input.scratch ? [input.scratch.path, input.scratch.gitDir] : [];

// Same reasoning as the run worktree: a rewritten pointer makes git read attacker-chosen config.
const scratchPointers = (input: SandboxInput): string[] =>
  input.scratch ? [join(input.scratch.path, ".git"), ...adminPointers(input.scratch.gitDir)] : [];

const SCRUB_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|TERM|TMPDIR|LC_.*)$/;

const SRT_BIN = join(import.meta.dir, "../../../../node_modules/.bin/srt");

const unique = (items: string[]): string[] => [...new Set(items)];

function expand(path: string): string {
  const uid = String(process.getuid?.() ?? 0);
  const withHome =
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return withHome.replaceAll("<uid>", uid);
}

function presetDomains(preset: SandboxInput["preset"]): string[] {
  if (preset === "dev") return DEV_DOMAINS;
  if (preset === "open-web") return ["*"];
  return [];
}

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

function assertSafe(input: SandboxInput, allowWrite: string[]): void {
  const fixed = [
    input.runDir,
    input.worktree,
    input.harnessHome,
    input.gitCommonDir,
    input.codexHome,
  ];
  for (const path of [...fixed, ...allowWrite]) {
    if (path !== null && !isAbsolute(path))
      throw new Error(`sandbox path is not absolute: ${path}`);
  }
  for (const entry of allowWrite) {
    if (isInside(homedir(), entry)) {
      throw new Error(`sandbox allowWrite would expose the home directory: ${entry}`);
    }
    if (isInside(input.harnessHome, entry)) {
      throw new Error(`sandbox allowWrite would expose the harness home: ${entry}`);
    }
  }
}

export function buildSrtSettings(input: SandboxInput): SrtSettings {
  const git = input.gitCommonDir;
  const codex = input.codexHome;
  const allowWrite = unique([
    ...(input.readOnlyWorktree ? [] : [input.worktree, ...gitWritable(input)]),
    ...scratchWritable(input),
    ...(codex ? [codex] : []),
    ...input.agentStateWrite.map(expand),
    runTmpDir(input.runDir),
  ]);
  assertSafe(input, allowWrite);
  return {
    network: {
      allowedDomains: unique([...input.agentEgress, ...presetDomains(input.preset)]),
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: unique([
        ...DENY_READ_HOME.map(expand),
        join(input.harnessHome, "harness.db*"),
        join(input.harnessHome, "secret"),
        join(input.harnessHome, "secrets.*"),
        join(input.harnessHome, "runs"),
        join(input.harnessHome, "worktrees"),
        join(input.harnessHome, "scratch-checkouts"),
        ...otherAgentCredentials(input.agentId).map(expand),
      ]),
      allowRead: [input.runDir, input.worktree, ...(input.scratch ? [input.scratch.path] : [])],
      allowWrite,
      denyWrite: unique([
        ...(git
          ? [
              join(git, "hooks"),
              join(git, "config"),
              join(git, "modules"),
              ...adminPointers(input.gitWorktreeDir ?? git),
              join(input.worktree, ".git"),
            ]
          : []),
        ...(codex ? [join(codex, "rules"), join(codex, "config.toml")] : []),
        ...scratchPointers(input),
        join(input.worktree, ".claude"),
        join(input.worktree, ".codex"),
        ...DENY_WRITE_HOME.map(expand),
      ]),
    },
    enableWeakerNetworkIsolation: input.weakerNetworkIsolation,
  };
}

// The only scratch space a run may write. srt overrides TMPDIR inside the sandbox with CLAUDE_CODE_TMPDIR
// (default /tmp/claude), so callers set both TMPDIR and CLAUDE_CODE_TMPDIR to this path.
export const runTmpDir = (runDir: string): string => join(runDir, "tmp");

export async function writeSrtSettings(input: SandboxInput): Promise<string> {
  const path = join(input.runDir, "srt.json");
  const settings = buildSrtSettings(input);
  await mkdir(runTmpDir(input.runDir), { recursive: true });
  await Bun.write(path, JSON.stringify(settings, null, 2));
  return path;
}

export function wrapCommand(settingsPath: string, argv: string[]): string[] {
  if (!existsSync(SRT_BIN)) throw new Error(`srt not found at ${SRT_BIN}`);
  if (!existsSync(settingsPath)) throw new Error(`srt settings not found: ${settingsPath}`);
  return [SRT_BIN, "-s", settingsPath, "--", ...argv];
}

export function scrubEnv(
  env: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && SCRUB_KEEP.test(key)) kept[key] = value;
  }
  return { ...kept, ...extra };
}
