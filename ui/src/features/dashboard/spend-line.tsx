import type { BudgetView } from "@shared/budgets";
import type { QuotaWindow } from "@shared/tracking";
import type { JSX } from "solid-js";
import { ButtonLink } from "../../ui/atoms";
import { Notice } from "../../ui/molecules";
import { budgetPercent } from "./budget-row";
import { QUOTA_WARN } from "./quota-row";

// One answer on top: is spend fine, and if not, which budget and what to do.
export function SpendLine(props: {
  budgets: BudgetView[];
  quota: QuotaWindow[];
  name: (b: BudgetView) => string;
  slug: string;
}): JSX.Element {
  const paused = (): BudgetView[] => props.budgets.filter((b) => b.state === "paused");
  const warn = (): BudgetView[] => props.budgets.filter((b) => b.state === "warn");
  const hot = (): QuotaWindow[] =>
    props.quota.filter((q) => q.usedPercent !== null && q.usedPercent >= QUOTA_WARN);
  const tone = (): "danger" | "warning" | "success" =>
    paused().length > 0 ? "danger" : warn().length > 0 || hot().length > 0 ? "warning" : "success";
  const flagged = (): BudgetView[] => (paused().length > 0 ? paused() : warn());
  const names = (): string => flagged().map(props.name).join(", ");
  const title = (): string =>
    paused().length > 0
      ? `Spend is not ok: ${names()} ${flagged().length === 1 ? "is" : "are"} paused`
      : warn().length > 0
        ? `Spend is not ok: ${names()} ${flagged().length === 1 ? "is" : "are"} near the limit`
        : hot().length > 0
          ? "A quota is nearly used"
          : "Spend is ok";
  return (
    <Notice
      tone={tone()}
      title={title()}
      actions={
        tone() === "success" ? undefined : (
          <ButtonLink href={`#/o/${props.slug}/policies`}>
            {flagged().length === 1 ? `Change ${names()}'s limit` : "Change limit"}
          </ButtonLink>
        )
      }
    >
      {[...paused(), ...warn()]
        .map(
          (b) =>
            `${props.name(b)} has used $${b.spentUsd.toFixed(2)} of $${b.monthlyUsd.toFixed(2)} this month (${budgetPercent(b)}%).`,
        )
        .concat(
          hot().map(
            (q) =>
              `${q.provider} ${q.window === "unknown" ? "" : `${q.window} `}quota is at ${Math.round(q.usedPercent ?? 0)}%.`,
          ),
        )
        .join(" ") || "No budget is near its limit."}
    </Notice>
  );
}
