import { homedir } from "node:os";
import { join } from "node:path";

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
  modeOption: { configId: string; value: string } | null;
  egress: string[];
  stateWrite: string[];
  /** Opens com.apple.trustd.agent in srt; needed by Go and Rust TLS clients (codex, agy). */
  weakerNetworkIsolation: boolean;
  claudeMeta: boolean;
  /** Whether the CLI can call the harness MCP server; without it memory arrives as a file. */
  mcp: boolean;
}

const adapterBin = (name: string): string =>
  join(import.meta.dir, "../../../../node_modules/.bin", name);

export const agentSpecs: readonly AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    lane: "acp",
    bin: adapterBin("claude-agent-acp"),
    args: [],
    versionArgs: ["claude", "--version"],
    loginProbe: {
      args: ["claude", "auth", "status"],
      loggedInWhen: { stdoutIncludes: '"loggedIn": true' },
    },
    loginArgs: ["claude", "auth", "login"],
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
    bin: adapterBin("codex-acp"),
    args: [],
    versionArgs: ["codex", "--version"],
    loginProbe: {
      args: ["codex", "login", "status"],
      loggedInWhen: { stdoutIncludes: "Logged in using ChatGPT" },
      // Runs get a private CODEX_HOME that only symlinks ~/.codex/auth.json, so the login that
      // matters is the one in ~/.codex, even if the server was started with another CODEX_HOME.
      env: { CODEX_HOME: join(homedir(), ".codex") },
    },
    loginArgs: ["codex", "login"],
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
