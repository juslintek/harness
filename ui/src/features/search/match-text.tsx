import { For, type JSX } from "solid-js";

// Splits on the query (case-insensitive) so the match can be marked without innerHTML.
export function MatchText(props: { text: string; query: string }): JSX.Element {
  const parts = (): string[] => {
    const q = props.query.trim();
    if (!q) return [props.text];
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return props.text.split(new RegExp(`(${escaped})`, "i"));
  };
  return <For each={parts()}>{(part, i) => (i() % 2 === 1 ? <mark>{part}</mark> : part)}</For>;
}
