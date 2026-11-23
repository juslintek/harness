import { type EffectivePolicy, type Layer, type PolicyKey, policyKeys } from "@shared/policies";
import type { Scope } from "./scope-picker";

export type ScopeLayer = Exclude<Layer, "harness">;

export type Field = { kind: "choice"; options: string[] } | { kind: "number" } | { kind: "list" };

export const fields: Record<PolicyKey, Field> = {
  autonomy: { kind: "choice", options: ["full", "supervised", "strict"] },
  "hiring.decision": { kind: "choice", options: ["auto", "manager", "human"] },
  "hiring.autoMinScore": { kind: "number" },
  "router.allowedRuntimes": { kind: "list" },
  "router.failover": { kind: "choice", options: ["true", "false"] },
  "router.accountPolicy": { kind: "choice", options: ["spread", "drain", "expiring"] },
  "heartbeat.maxRunsPerHour": { kind: "number" },
};

export function show(value: unknown): string {
  if (value === null || value === undefined) return "no restriction";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

// The text a form control holds for a value; a null list is an empty box.
export const toText = (value: unknown): string =>
  value === null || value === undefined ? "" : show(value);

export type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

export function parseValue(key: PolicyKey, text: string): Parsed {
  const field = fields[key];
  if (field.kind === "number") {
    // Number("") is 0, which would silently be a valid score.
    return text.trim() === "" || Number.isNaN(Number(text))
      ? { ok: false, message: "Enter a number." }
      : { ok: true, value: Number(text) };
  }
  if (field.kind === "list") {
    const names = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { ok: true, value: names.length === 0 ? null : names };
  }
  return { ok: true, value: key === "router.failover" ? text === "true" : text };
}

export const handleOf = (id: string, members: { id: string; handle: string }[]): string =>
  members.find((m) => m.id === id)?.handle ?? id;

export const layerName: Record<Layer | "default", string> = {
  harness: "harness",
  org: "organisation",
  team: "team",
  agent: "agent",
  task: "task",
  default: "default",
};

const AUTONOMY_WORDS = {
  full: "Full",
  supervised: "Supervised",
  strict: "Strict",
} as const;

// The word a person reads for a stored value; the raw value stays what the server and the form use.
export function valueWord(key: PolicyKey, value: unknown): string {
  if (key === "autonomy")
    return AUTONOMY_WORDS[value as keyof typeof AUTONOMY_WORDS] ?? show(value);
  if (key === "hiring.decision")
    return (
      { auto: "Automatic", manager: "Manager", human: "A person" }[String(value)] ?? show(value)
    );
  if (key === "router.failover") return value ? "On" : "Off";
  if (key === "router.accountPolicy")
    return (
      { spread: "Spread", drain: "Drain", expiring: "Expiring first" }[String(value)] ?? show(value)
    );
  if (key === "router.allowedRuntimes") return value === null ? "No limit" : show(value);
  return show(value);
}

export const optionWord = (key: PolicyKey, option: string): string =>
  valueWord(key, key === "router.failover" ? option === "true" : option);

export interface PolicyMeta {
  name: string;
  help: string;
  explain: (value: unknown) => string;
}

const none = (): string => "";

export const policyMeta: Record<PolicyKey, PolicyMeta> = {
  autonomy: {
    name: "Agent autonomy",
    help: "How much agents may do without asking a person.",
    explain: (v) =>
      ({
        full: "The guard works as usual. Manager agents may approve their team's commands.",
        supervised: "Manager agents may not approve commands. People decide.",
        strict: "Every command that is not a plain read asks for approval. People decide.",
      })[String(v)] ?? "",
  },
  "hiring.decision": {
    name: "Who decides hires",
    help: "When interviews end, who picks the new agent.",
    explain: (v) =>
      ({
        auto: "The best candidate is hired if its total reaches the minimum score.",
        manager: "The team's manager agent is asked. An admin can still decide.",
        human: "Nobody is asked. An admin decides.",
      })[String(v)] ?? "",
  },
  "hiring.autoMinScore": {
    name: "Auto-hire minimum score",
    help: "Used only when hires are decided automatically. The best candidate's total, 0 to 5, must reach it.",
    explain: () => "Out of 5. Below it, nobody is hired.",
  },
  "router.allowedRuntimes": {
    name: "Allowed runtimes",
    help: "Agents and hire candidates can only run on these. Empty means no limit.",
    explain: (v) => (v === null ? "Any runtime may be used." : "Other runtimes are never used."),
  },
  "router.failover": {
    name: "Fail over to another runtime",
    help: "If a run fails, the next attempt moves to another allowed runtime and continues in the same worktree.",
    explain: none,
  },
  "router.accountPolicy": {
    name: "Account selection policy",
    help: "How the router chooses among eligible accounts of the winning runtime.",
    explain: (v) =>
      ({
        spread: "Picks the account with the most headroom, breaking ties by least recently used.",
        drain: "Uses accounts in priority order and moves on only at exhaustion.",
        expiring: "Spends quota whose window resets soonest among accounts with headroom.",
      })[String(v)] ?? "",
  },
  "heartbeat.maxRunsPerHour": {
    name: "Runs per agent per hour",
    help: "The most runs one agent may start in an hour, 1 to 200. Extra wake-ups are skipped and a line is written to Logs.",
    explain: none,
  },
};

const ORDER: readonly string[] = policyKeys.autonomy.tightenOnly ?? [];

// What applies once this layer stops setting the key: the strictest other layer for autonomy,
// the nearest other layer for the rest, else the built-in default.
export function inheritedFrom(
  item: EffectivePolicy,
  own: Scope,
): { value: unknown; layers: boolean } {
  const others = item.chain.filter((c) => !(c.layer === own.layer && c.targetId === own.targetId));
  if (others.length === 0) return { value: policyKeys[item.key].default, layers: false };
  const pick =
    item.key === "autonomy"
      ? others.reduce((a, b) =>
          ORDER.indexOf(b.value as never) > ORDER.indexOf(a.value as never) ? b : a,
        )
      : (others[others.length - 1] as (typeof others)[number]);
  return { value: pick.value, layers: true };
}
