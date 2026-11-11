// GATE_ENGINE=codex runs every agent of a gate on Codex, which needs no Claude login or spend.
// GATE_ENGINE=codex-claude-failover keeps every member on Codex but also links Claude, so a
// quota failover (gate 3) has a different runtime to land on. Without it the gates keep their
// original Claude lead.
const engine = process.env.GATE_ENGINE;
const codexMembers = engine === "codex" || engine === "codex-claude-failover";

export const leadAgentId = (): string => (codexMembers ? "codex" : "claude");
export const gateAgentIds = (): string[] => (engine === "codex" ? ["codex"] : ["claude", "codex"]);
export const maxClaudeUsd = (): number => (engine === "codex-claude-failover" ? 2 : 2.5);
