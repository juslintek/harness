import type { JSX } from "solid-js";

export function Fact(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  );
}
