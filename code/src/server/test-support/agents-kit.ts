import { join } from "node:path";
import { type AgentSpec, type AgentView, getSpec } from "../features/agents/api";

// Route discovery would spawn every installed agent CLI, so tests hand the router fixed ones.
export const fakeAgents = (...ids: string[]): { agents: () => Promise<AgentView[]> } => ({
  agents: () =>
    Promise.resolve(
      ids.map((id) => ({
        id,
        name: id,
        lane: "acp" as const,
        installed: true,
        path: null,
        version: null,
        loggedIn: true,
        error: null,
        canLogin: true,
        enabled: true,
        models: [],
      })),
    ),
});

const FAKE_BIN = join(import.meta.dir, "fake-bin");

// The built-in spec data (probe rule, argv) with the binary swapped for the fake executable in
// fake-bin, which keeps its login marker in the account's CLAUDE_CONFIG_DIR or CODEX_HOME.
export function fakeCliSpec(id: "claude" | "codex"): AgentSpec {
  const spec = getSpec(id) as AgentSpec;
  const swap = (argv: string[]): string[] => [join(FAKE_BIN, id), ...argv.slice(1)];
  return {
    ...spec,
    // The fakes keep each account in its own directory by construction.
    accountIsolation: true,
    versionArgs: swap(spec.versionArgs),
    loginArgs: spec.loginArgs && swap(spec.loginArgs),
    ...(spec.logoutArgs && { logoutArgs: swap(spec.logoutArgs) }),
    loginProbe: spec.loginProbe && { ...spec.loginProbe, args: swap(spec.loginProbe.args) },
  };
}

// A spec that passes the isolation gate and has no vendor logout, for tests that add and remove
// accounts without wanting a CLI called.
export function isolatedStubSpec(): AgentSpec {
  const spec = { ...(getSpec("claude") as AgentSpec), accountIsolation: true };
  delete spec.logoutArgs;
  return spec;
}
