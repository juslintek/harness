import type { BudgetView } from "@shared/budgets";
import type { JSX } from "solid-js";
import { Meter, statusWord } from "../atoms";

// A budget's spend against its monthly limit, coloured by the budget's state.
export function BudgetMeter(props: { budget: BudgetView }): JSX.Element {
  const pct = (): number =>
    props.budget.monthlyUsd > 0 ? (props.budget.spentUsd / props.budget.monthlyUsd) * 100 : 0;
  return (
    <Meter
      tone={statusWord(props.budget.state, "budget").tone}
      label={`$${props.budget.spentUsd.toFixed(2)} of $${props.budget.monthlyUsd.toFixed(2)} (USD)`}
      value={`${Math.round(props.budget.ratio * 100)}% this month`}
      pct={pct()}
    />
  );
}
