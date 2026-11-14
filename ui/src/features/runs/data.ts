import { type RunView, runViewSchema } from "@shared/runs";
import { z } from "zod";
import { createLoad } from "../../load";
import { selectedSlug } from "../../orgs";
import { type Wakeup, wakeReason, wakeupList } from "../../wakeups";

const usageSchema = z.object({
  key: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reportedCostUsd: z.number().nullable(),
  events: z.number(),
});
export type Usage = z.infer<typeof usageSchema>;

export const runList = z.array(runViewSchema);

// A wakeup or usage load that fails (not a member of the org, say) just leaves its facts out.
export function createRunContext(): {
  wakeupOf: (runId: string) => Wakeup | undefined;
  usageOf: (runId: string) => Usage | undefined;
} {
  const wakeups = createLoad(
    () => `/api/orgs/${selectedSlug() ?? "-"}/wakeups?limit=200`,
    wakeupList,
    ["runs"],
  );
  const usage = createLoad("/api/usage?by=run", z.array(usageSchema), ["runs"]);
  return {
    wakeupOf: (runId) => wakeups.data()?.find((w) => w.runId === runId),
    usageOf: (runId) => usage.data()?.find((u) => u.key === runId),
  };
}

export interface Why {
  text: string;
  href?: string;
}

// `long` is the run page wording; the list uses the short one. Links go to the org's board and
// chat: the wakeup has a task number and a channel name but no ids the routes accept.
export function whyStarted(w: Wakeup | undefined, long: boolean): Why | undefined {
  if (!w) return undefined;
  const slug = selectedSlug();
  const text = wakeReason(w, undefined, long);
  if (!slug) return { text };
  if (w.reason === "assignment") return { text, href: `#/o/${slug}/board` };
  if (w.reason === "mention") return { text, href: `#/o/${slug}/chat` };
  return { text };
}

const SHORT: Record<string, string> = {
  killed_by_user: "Stopped by a person",
  halted: "All agents were stopped",
  rate_limited: "Hit a provider rate limit",
  budget_exhausted: "Budget used up",
  guard_denied: "The guard denied a command",
  approval_timeout: "Nobody decided the approval in time",
  circuit_breaker: "Stopped after repeated failures",
  quota_exhausted: "Provider quota used up",
  harness_shutdown: "The harness shut down",
  max_tokens: "The model hit its output limit",
  refusal: "The model refused the task",
};

export const isLive = (state: RunView["state"]): boolean =>
  state === "queued" || state === "starting" || state === "running";

// Only a run that has ended has a reason worth showing; an unknown one stays as the server wrote it.
export const reasonText = (run: RunView): string | undefined =>
  run.reason && !isLive(run.state) ? (SHORT[run.reason] ?? run.reason) : undefined;
