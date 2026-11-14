import type { BudgetView } from "@shared/budgets";
import type { HireView } from "@shared/hiring";
import type { OrgDetail } from "@shared/orgs";
import type { EffectivePolicy } from "@shared/policies";
import { For, type JSX } from "solid-js";
import { Help } from "../../ui/atoms";
import { layerName, valueWord } from "../policies/policies-data";

// What the new agent will be allowed to do and spend, read from the team's effective rules today.
export function HireTerms(props: {
  detail: OrgDetail;
  hire: HireView;
  policies: EffectivePolicy[];
  budgets: BudgetView[];
}): JSX.Element {
  const slug = (): string => props.detail.org.slug;
  const team = (): string =>
    props.detail.teams.find((t) => t.id === props.hire.teamId)?.name ?? props.hire.teamId;
  const rule = (key: EffectivePolicy["key"]): string => {
    const item = props.policies.find((p) => p.key === key);
    if (!item) return "unknown";
    const word = valueWord(key, item.value);
    const from = item.layer === "default" ? "default" : `from ${layerName[item.layer]}`;
    return `${key === "autonomy" ? word.toLowerCase() : word} (${from})`;
  };
  const counted = (): string[] =>
    props.budgets
      .filter(
        (b) => b.scopeKind === "org" || (b.scopeKind === "team" && b.scopeId === props.hire.teamId),
      )
      .map((b) => {
        const name = b.scopeKind === "org" ? "Whole organisation" : `Team ${team()}`;
        return `${name} $${b.spentUsd.toFixed(2)} of $${b.monthlyUsd.toFixed(2)} (${Math.round(b.ratio * 100)}%)`;
      });
  const lines = (): [string, string][] => [
    [
      "Joins",
      `team ${team()} as a member. It reports to the team manager, or to the team's admins when no manager is an agent.`,
    ],
    ["Autonomy", rule("autonomy")],
    ["Runtimes", rule("router.allowedRuntimes")],
    ["Runs per hour", rule("heartbeat.maxRunsPerHour")],
  ];
  return (
    <div class="hire-terms">
      <h3 class="sub-title">If you hire a candidate</h3>
      <For each={lines()}>
        {([name, text]) => (
          <p>
            <strong>{name}.</strong> {text}
          </p>
        )}
      </For>
      <p>
        <strong>Budgets that count.</strong>{" "}
        {counted().length === 0
          ? "No budget is set for the organisation or the team."
          : counted().join(". ")}
      </p>
      <p class="hire-links">
        <a class="hire-link" href={`#/o/${slug()}/policies`}>
          Change these in Policies
        </a>
        <a class="hire-link" href={`#/o/${slug()}/dashboard`}>
          Open Usage &amp; budgets
        </a>
      </p>
      <Help>
        Values are the ones in force for team {team()} today. An agent's own rules or budget can be
        added later.
      </Help>
    </div>
  );
}
