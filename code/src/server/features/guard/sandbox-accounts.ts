import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SandboxAccount {
  home: string | null;
}

// Where agents/accounts-ops.ts keeps one home per extra login. A run never needs another
// account's credential file, so every guard layer denies this whole directory.
export const accountsRoot = (harnessHome: string): string => join(harnessHome, "accounts");

export const CLAUDE_DENY_WRITE: readonly string[] = [
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
];

export const CODEX_DENY_WRITE: readonly string[] = ["config.toml", "rules", "hooks.json"];

export function homeDenyWrite(home: string): string[] {
  return [...new Set([...CLAUDE_DENY_WRITE, ...CODEX_DENY_WRITE])].map((name) => join(home, name));
}

const GEMINI_CREDENTIALS = [
  "~/.gemini/oauth_creds.json",
  "~/.gemini/google_accounts.json",
  "~/.gemini/jetski-standalone-oauth-token",
  "~/.gemini/antigravity-cli/antigravity-oauth-token",
];

// A run on the default account may read its own agent's credentials and no other agent's.
// Non-default account runs must not read any default login credentials either.
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

export function credentialsDenyRead(
  agentId: string | null | undefined,
  account: SandboxAccount | null | undefined,
): string[] {
  const all = [...new Set(Object.values(AGENT_CREDENTIALS).flat())];
  if (account?.home != null) return all;
  const own = new Set(agentId ? (AGENT_CREDENTIALS[agentId] ?? []) : []);
  return all.filter((p) => !own.has(p));
}

const AGENT_CONFIG_DIRS: Record<string, string[]> = {
  claude: ["~/.claude"],
  codex: ["~/.codex"],
  junie: ["~/.junie"],
  copilot: ["~/.copilot"],
  gemini: ["~/.gemini"],
  agy: ["~/.gemini"],
  cursor: ["~/.cursor"],
};

export function filterAgentStateWrite(
  agentId: string | null | undefined,
  stateWrite: string[],
  account: SandboxAccount | null | undefined,
  expandPath: (p: string) => string,
): string[] {
  const expanded = stateWrite.map(expandPath);
  if (account?.home == null) return expanded;
  const drop = new Set((agentId ? (AGENT_CONFIG_DIRS[agentId] ?? []) : []).map(expandPath));
  return expanded.filter((p) => !drop.has(p));
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function validateAccountHome(home: string, harnessHome: string): string {
  if (!isAbsolute(home)) throw new Error(`sandbox path is not absolute: ${home}`);
  try {
    if (lstatSync(home).isSymbolicLink()) {
      throw new Error(`sandbox account home must not be a symlink: ${home}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const root = accountsRoot(harnessHome);
  const realHome = tryRealpath(home);
  const realRoot = tryRealpath(root);
  const [resolvedRoot, resolvedHome] =
    realHome !== null && realRoot !== null ? [realRoot, realHome] : [resolve(root), resolve(home)];
  const rel = relative(resolvedRoot, resolvedHome);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`sandbox account home must be inside the accounts directory: ${home}`);
  }
  return resolvedHome;
}

// Paired nested access builder: allowWrite can never emit an account home without allowRead.
export function accountHomeAccess(
  harnessHome: string,
  account: SandboxAccount | null | undefined,
  codexHome: string | null,
): { allowRead: string[]; allowWrite: string[]; denyWrite: string[] } {
  if (account?.home == null) return { allowRead: [], allowWrite: [], denyWrite: [] };
  const resolvedHome = validateAccountHome(account.home, harnessHome);
  if (codexHome !== null) return { allowRead: [], allowWrite: [], denyWrite: [] };
  return {
    allowRead: [resolvedHome],
    allowWrite: [resolvedHome],
    denyWrite: homeDenyWrite(resolvedHome),
  };
}
