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
  loginProbe: { args: string[]; loggedInWhen: "exit0" | { stdoutIncludes: string } } | null;
  /** Full argv of the interactive login command, null when the CLI has none. */
  loginArgs: string[] | null;
  modeOption: { configId: string; value: string } | null;
  egress: string[];
  stateWrite: string[];
  claudeMeta: boolean;
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
    egress: ["api.anthropic.com", "statsig.anthropic.com", "claude.ai"],
    stateWrite: ["~/.claude", "~/.claude.json"],
    claudeMeta: true,
  },
  {
    id: "codex",
    name: "Codex",
    lane: "acp",
    bin: adapterBin("codex-acp"),
    args: [],
    versionArgs: ["codex", "--version"],
    loginProbe: { args: ["codex", "login", "status"], loggedInWhen: "exit0" },
    loginArgs: ["codex", "login"],
    modeOption: { configId: "mode", value: "workspace-write" },
    egress: ["chatgpt.com", "api.openai.com", "auth.openai.com"],
    stateWrite: ["~/.codex"],
    claudeMeta: false,
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
    claudeMeta: false,
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
    claudeMeta: false,
  },
  {
    id: "cursor",
    name: "Cursor",
    lane: "acp",
    bin: "agent",
    args: ["acp"],
    versionArgs: ["agent", "--version"],
    loginProbe: { args: ["agent", "status"], loggedInWhen: { stdoutIncludes: "Logged in" } },
    loginArgs: ["agent", "login"],
    modeOption: null,
    egress: ["api2.cursor.sh", "cursor.com"],
    stateWrite: ["~/.cursor"],
    claudeMeta: false,
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
    claudeMeta: false,
  },
  {
    id: "agy",
    name: "Antigravity",
    lane: "agy",
    bin: "agy",
    args: [],
    versionArgs: ["agy", "--version"],
    loginProbe: null,
    loginArgs: null,
    modeOption: null,
    egress: ["daily-cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
    stateWrite: ["~/.gemini"],
    claudeMeta: false,
  },
];
