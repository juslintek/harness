import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { accountEnvFor } from "../../../shared/accounts";
import { isCompiledBinary, resolvePackagedAdapter } from "../../packaged";

export interface AgentSpec {
  id: string;
  name: string;
  lane: "acp" | "agy" | "api";
  bin: string;
  args: string[];
  /** Full argv of the installed CLI (not the adapter) that prints its version. */
  versionArgs: string[];
  /** Full argv, read-only. */
  loginProbe: {
    args: string[];
    loggedInWhen: "exit0" | { stdoutIncludes: string };
    env?: Record<string, string>;
  } | null;
  /** Full argv of the interactive login command, null when the CLI has none. */
  loginArgs: string[] | null;
  /** Argv that signs the account out at the vendor, run with the account's environment. */
  logoutArgs?: string[];
  /**
   * True only when a second login in its own home is safe: it leaves the default login alone and
   * agent sandboxes cannot read the account home. Without it, adding, logging in and testing a
   * non-default account are refused.
   */
  accountIsolation?: boolean;
  modeOption: { configId: string; value: string } | null;
  egress: string[];
  stateWrite: string[];
  /** Opens com.apple.trustd.agent in srt; needed by Go and Rust TLS clients (codex, agy). */
  weakerNetworkIsolation: boolean;
  claudeMeta: boolean;
  /** Whether the CLI can call the harness MCP server; without it memory arrives as a file. */
  mcp: boolean;
}

function adapterCommand(
  runtime: "claude" | "codex",
  binName: string,
): { bin: string; args: string[] } {
  if (!isCompiledBinary()) {
    const local = join(import.meta.dir, "../../../../node_modules/.bin", binName);
    if (existsSync(local)) return { bin: local, args: [] };
  }
  if (resolvePackagedAdapter(`${binName}.mjs`)) {
    return { bin: process.execPath, args: ["acp-adapter", runtime] };
  }
  return { bin: binName, args: [] };
}

const claudeAdapter = adapterCommand("claude", "claude-agent-acp");
const codexAdapter = adapterCommand("codex", "codex-acp");

const builtinSpecs: readonly AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    lane: "acp",
    bin: claudeAdapter.bin,
    args: claudeAdapter.args,
    versionArgs: ["claude", "--version"],
    loginProbe: {
      args: ["claude", "auth", "status"],
      loggedInWhen: { stdoutIncludes: '"loggedIn": true' },
    },
    loginArgs: ["claude", "auth", "login"],
    // Stays false until the accounts directory is denied in srt and L1 (slice P1.5a) and spike S1
    // (working-docs/plans/multi-account.md) shows that a login or logout under another
    // CLAUDE_CONFIG_DIR leaves the default macOS Keychain login alone.
    // No logout command either: it could sign the owner's default login out.
    accountIsolation: false,
    modeOption: { configId: "mode", value: "default" },
    egress: ["api.anthropic.com"],
    stateWrite: ["~/.claude", "/private/tmp/claude-<uid>", "/private/tmp/claude-*-cwd"],
    weakerNetworkIsolation: false,
    claudeMeta: true,
    mcp: true,
  },
  {
    id: "codex",
    name: "Codex",
    lane: "acp",
    bin: codexAdapter.bin,
    args: codexAdapter.args,
    versionArgs: ["codex", "--version"],
    loginProbe: {
      args: ["codex", "login", "status"],
      loggedInWhen: { stdoutIncludes: "Logged in using ChatGPT" },
      // Runs get a private CODEX_HOME that only symlinks ~/.codex/auth.json, so the login that
      // matters is the one in ~/.codex, even if the server was started with another CODEX_HOME.
      env: { CODEX_HOME: join(homedir(), ".codex") },
    },
    loginArgs: ["codex", "login"],
    logoutArgs: ["codex", "logout"],
    // Runs deny <HARNESS_HOME>/accounts in srt and in the L1 secret guard, so no run can read
    // another account's auth.json.
    accountIsolation: true,
    modeOption: { configId: "mode", value: "workspace-write" },
    egress: ["chatgpt.com"],
    stateWrite: [],
    weakerNetworkIsolation: true,
    claudeMeta: false,
    mcp: true,
  },
  {
    id: "junie",
    name: "Junie",
    lane: "acp",
    bin: "junie",
    args: ["--acp=true"],
    versionArgs: ["junie", "--version"],
    loginProbe: null,
    loginArgs: null,
    modeOption: null,
    egress: ["junie.jetbrains.com", "api.jetbrains.ai"],
    stateWrite: ["~/.junie"],
    weakerNetworkIsolation: false,
    claudeMeta: false,
    mcp: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    lane: "acp",
    bin: "copilot",
    args: ["--acp", "--stdio"],
    versionArgs: ["copilot", "--version"],
    loginProbe: null,
    loginArgs: ["copilot", "login"],
    modeOption: null,
    egress: ["api.github.com", "api.githubcopilot.com", "github.com"],
    stateWrite: ["~/.copilot"],
    weakerNetworkIsolation: false,
    claudeMeta: false,
    mcp: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    lane: "acp",
    bin: "agent",
    args: ["acp"],
    versionArgs: ["agent", "--version"],
    loginProbe: null,
    loginArgs: ["agent", "login"],
    modeOption: null,
    egress: ["api2.cursor.sh", "cursor.com"],
    stateWrite: ["~/.cursor"],
    weakerNetworkIsolation: false,
    claudeMeta: false,
    mcp: true,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    lane: "acp",
    bin: "gemini",
    args: ["--acp"],
    versionArgs: ["gemini", "--version"],
    loginProbe: null,
    loginArgs: null,
    modeOption: null,
    egress: ["generativelanguage.googleapis.com"],
    stateWrite: ["~/.gemini"],
    weakerNetworkIsolation: false,
    claudeMeta: false,
    mcp: true,
  },
  {
    id: "agy",
    name: "Antigravity",
    lane: "agy",
    bin: "agy",
    args: [],
    versionArgs: ["agy", "--version"],
    loginProbe: { args: ["agy", "models"], loggedInWhen: "exit0" },
    loginArgs: null,
    modeOption: null,
    egress: ["daily-cloudcode-pa.googleapis.com", "www.googleapis.com"],
    stateWrite: ["~/.gemini"],
    weakerNetworkIsolation: true,
    claudeMeta: false,
    mcp: false,
  },
];

// Environment that points one CLI at an account's own home. A NULL home is the CLI's default
// login and gets nothing, so its behaviour (and the Keychain item it uses) stays as it was.
export function accountEnv(
  spec: Pick<AgentSpec, "id">,
  account: { home: string | null },
): Record<string, string> {
  return accountEnvFor(spec.id, account.home);
}

const specSchema: z.ZodType<AgentSpec> = z.object({
  id: z.string().min(1),
  name: z.string(),
  lane: z.enum(["acp", "agy", "api"]),
  bin: z.string().min(1),
  args: z.array(z.string()),
  versionArgs: z.array(z.string()),
  loginProbe: z
    .object({
      args: z.array(z.string()),
      loggedInWhen: z.union([z.literal("exit0"), z.object({ stdoutIncludes: z.string() })]),
      env: z.exactOptional(z.record(z.string(), z.string())),
    })
    .nullable(),
  loginArgs: z.array(z.string()).nullable(),
  logoutArgs: z.exactOptional(z.array(z.string())),
  accountIsolation: z.exactOptional(z.boolean()),
  modeOption: z.object({ configId: z.string(), value: z.string() }).nullable(),
  egress: z.array(z.string()),
  stateWrite: z.array(z.string()),
  weakerNetworkIsolation: z.boolean(),
  claudeMeta: z.boolean(),
  mcp: z.boolean().default(false),
});

// The black-box suite swaps in a stub agent this way. Outside HARNESS_TEST=1 the variable is
// ignored, so a stray value in a real environment cannot replace the installed agents.
export function loadAgentSpecs(env: Record<string, string | undefined>): readonly AgentSpec[] {
  const override = env.HARNESS_TEST === "1" ? env.HARNESS_TEST_AGENTS : undefined;
  if (!override) return builtinSpecs;
  return z.array(specSchema).parse(JSON.parse(override));
}

export const agentSpecs: readonly AgentSpec[] = loadAgentSpecs(process.env);
