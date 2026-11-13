import type { JSX } from "solid-js";
import "./code-block.css";
import { CopyButton } from "../atoms";

export function CodeBlock(props: {
  text: string;
  label: string;
  copy?: boolean;
  prompt?: boolean;
}): JSX.Element {
  return (
    <div class="code-block">
      <pre>
        {props.prompt ? <span aria-hidden="true">$ </span> : null}
        {props.text}
      </pre>
      {props.copy === false ? null : (
        <div class="code-block-actions">
          <CopyButton text={props.text} label={`Copy ${props.label}`} tone="ghost" />
        </div>
      )}
    </div>
  );
}
