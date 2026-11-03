import type { AgentView } from "../features/agents/api";

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
