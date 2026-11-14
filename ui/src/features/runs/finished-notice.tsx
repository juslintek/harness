import type { EventView, RunView } from "@shared/runs";
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { selectedSlug } from "../../orgs";
import { Notice, Panel } from "../../ui/molecules";
import { isLive } from "./data";

interface Outcome {
  sentence: string;
  next?: { text: string; href: string };
}

// The reason sentence and the next step for each end the server can write. An unknown reason
// is shown as written.
function outcome(run: RunView): Outcome {
  const slug = selectedSlug();
  const org = (page: string): string => (slug ? `#/o/${slug}/${page}` : "#/");
  switch (run.reason) {
    case "killed_by_user":
      return { sentence: "A person stopped this run." };
    case "halted":
      return { sentence: "All agents were stopped. Resume them and run the task again." };
    case "rate_limited":
      return {
        sentence: "The provider limited this run. Run it again in a few minutes.",
        next: { text: "Open Usage & budgets", href: org("dashboard") },
      };
    case "budget_exhausted":
      return {
        sentence: "The budget ran out, so the run was stopped.",
        next: { text: "Open Policies", href: org("policies") },
      };
    case "guard_denied":
      return {
        sentence: "The guard denied a command and the run ended.",
        next: { text: "See the rule in Logs", href: org("logs") },
      };
    case "approval_timeout":
      return {
        sentence: "Nobody decided the approval in time, so the run ended as blocked.",
        next: { text: "Open approvals", href: "#/approvals" },
      };
    case "circuit_breaker":
      return { sentence: "The run was stopped after repeated failures." };
    case "quota_exhausted":
      return { sentence: "The provider quota ran out, so the run was stopped." };
    case "harness_shutdown":
      return { sentence: "The harness shut down while this run was working." };
    case "max_tokens":
      return { sentence: "The model reached its output limit and the run failed." };
    case "refusal":
      return { sentence: "The model refused the task and the run failed." };
    case null:
      return { sentence: `The run ended as ${run.state}.` };
    default:
      return { sentence: run.reason };
  }
}

export function FinishedNotice(props: { run: RunView; events: EventView[] }): JSX.Element {
  const result = (): EventView | undefined =>
    [...props.events].reverse().find((e) => e.kind === "message" && e.body);
  return (
    <Show when={!isLive(props.run.state)}>
      <Show
        when={props.run.state === "completed"}
        fallback={
          <Notice
            tone={props.run.state === "killed" ? "warning" : "danger"}
            title={`Run ${props.run.state}`}
          >
            {outcome(props.run).sentence}
            <Show when={outcome(props.run).next}>
              {(next) => (
                <>
                  {" "}
                  <a href={next().href}>{next().text}</a>
                </>
              )}
            </Show>
          </Notice>
        }
      >
        <Notice tone="success" title="Run completed">
          The agent finished its work.
        </Notice>
        <Show when={result()}>
          {(last) => (
            <Panel title="Result">
              <p class="result-body">{last().body}</p>
              <Show when={props.run.branch}>
                {(branch) => (
                  <p class="muted">
                    Branch <span class="mono">{branch()}</span>
                  </p>
                )}
              </Show>
            </Panel>
          )}
        </Show>
      </Show>
    </Show>
  );
}
