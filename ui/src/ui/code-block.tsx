import type { JSX } from "solid-js";
import "./code-block.css";
import { CopyButton } from "./copy-button";

export function CodeBlock(props: { text: string; label: string; copy?: boolean }): JSX.Element {
  return (
    <div class="code-block">
      <pre>{props.text}</pre>
      {props.copy === false ? null : (
        <div class="code-block-actions">
          <CopyButton text={props.text} label={`Copy ${props.label}`} />
        </div>
      )}
    </div>
  );
}
