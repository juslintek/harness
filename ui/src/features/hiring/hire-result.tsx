import type { HireView } from "@shared/hiring";
import type { OrgDetail } from "@shared/orgs";
import { type JSX, Show } from "solid-js";
import { filedStamp } from "../../format";
import { ButtonLink, Help } from "../../ui/atoms";
import { CodeBlock, Notice } from "../../ui/molecules";
import { engineName } from "./score-table";

// What a closed request ended in: who was hired, who decided, and what the new agent was told.
export function HireResult(props: { view: HireView; detail: OrgDetail }): JSX.Element {
  const slug = (): string => props.detail.org.slug;
  const handle = (id: string | null): string | undefined =>
    props.detail.members.find((m) => m.id === id || (id !== null && m.userId === id))?.handle;
  const hired = (): HireView["candidates"][number] | undefined =>
    props.view.candidates.find((c) => c.status === "hired");
  const hiredName = (): string => {
    const c = hired();
    return c ? engineName(c) : "a candidate";
  };
  const agent = (): string | undefined => handle(props.view.hiredMemberId);
  const decider = (): string => {
    const by = handle(props.view.decidedBy);
    return by ? `@${by}` : "the team manager agent";
  };
  return (
    <>
      <Show when={props.view.status === "hired"}>
        <Notice
          tone="success"
          title={
            agent()
              ? `Hired: ${hiredName()} is now @${agent()}`
              : "Request closed, a candidate was hired"
          }
          actions={
            <>
              <ButtonLink href={`#/o/${slug()}/settings`}>
                {agent() ? `Open @${agent()} in Settings` : "Open Settings"}
              </ButtonLink>
              <ButtonLink href={`#/o/${slug()}/policies`}>See its rules in Policies</ButtonLink>
            </>
          }
        >
          Request closed. The agent was added to its team as a member and woke up with its
          onboarding pack.
        </Notice>
      </Show>
      <Show when={props.view.status === "rejected"}>
        <Notice tone="info" title="Request closed, nobody hired">
          All candidates were rejected. No agent was added.
        </Notice>
      </Show>
      <Show when={props.view.decidedBy}>
        <p class="hire-decision">
          {`Decided by ${decider()}, ${filedStamp(props.view.phaseStartedAt)}.`}
          {props.view.decisionReason ? ` Reason: ${props.view.decisionReason}` : ""}
        </p>
      </Show>
      <Show when={props.view.onboarding}>
        {(pack) => (
          <section class="stack" aria-label="What the agent was told">
            <h3 class="sub-title">What the agent was told</h3>
            <Help>
              The onboarding pack the server sent on its first wake-up. It lists the rules that
              apply to the agent.
            </Help>
            <CodeBlock text={pack()} label="onboarding pack" />
          </section>
        )}
      </Show>
    </>
  );
}
