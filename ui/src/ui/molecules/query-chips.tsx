import { For, type JSX } from "solid-js";
import { Button } from "../atoms";
import "./query-chips.css";

// Ready-made searches: a click fills the field and runs the search.
export function QueryChips(props: {
  queries: string[];
  onPick: (query: string) => void;
}): JSX.Element {
  return (
    <div class="query-chips">
      <span>Try</span>
      <ul aria-label="Suggested searches">
        <For each={props.queries}>
          {(q) => (
            <li>
              <Button size="sm" onClick={() => props.onPick(q)}>
                {q}
              </Button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
