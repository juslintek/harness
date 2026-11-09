// GATE_ENGINE=codex runs every agent of a gate on Codex, which needs no Claude login or spend.
// Without it the gates keep their original Claude lead.
const codexOnly = process.env.GATE_ENGINE === "codex";

export const leadAgentId = (): string => (codexOnly ? "codex" : "claude");
export const gateAgentIds = (): string[] => (codexOnly ? ["codex"] : ["claude", "codex"]);
