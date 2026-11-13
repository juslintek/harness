import type { JSX } from "solid-js";
import { ButtonLink } from "../../ui/atoms";
import { EmptyPanel, State } from "../../ui/molecules";

export function QuietState(props: { slug: string; halted: boolean }): JSX.Element {
  return props.halted ? (
    <State
      kind="empty"
      title="Agents are stopped"
      message="Nothing starts until agents are resumed. Work that is waiting will start then."
    />
  ) : (
    <EmptyPanel
      title="Nothing is running"
      message="Agents start when you assign them a task, mention them in chat or press Run now on a task."
    >
      <ButtonLink href={`#/o/${props.slug}/board`}>Open board</ButtonLink>
      <ButtonLink href={`#/o/${props.slug}/chat`}>Open chat</ButtonLink>
    </EmptyPanel>
  );
}
