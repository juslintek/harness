import { createSignal, For, type JSX } from "solid-js";

// The codes are shown once and never again, so the way on stays locked until the user confirms.
export function RecoveryCodes(props: { codes: string[]; onDone: () => void }): JSX.Element {
  const [saved, setSaved] = createSignal(false);
  return (
    <section aria-labelledby="codes-h">
      <h4 id="codes-h">Your codes</h4>
      <p>Each code signs you in once if you lose your passkey. They are not shown again.</p>
      <ul class="codes">
        <For each={props.codes}>
          {(code) => (
            <li>
              <code>{code}</code>
            </li>
          )}
        </For>
      </ul>
      <label class="inline">
        <input
          type="checkbox"
          checked={saved()}
          onChange={(e) => setSaved(e.currentTarget.checked)}
        />
        I saved them
      </label>
      <button type="button" disabled={!saved()} onClick={() => props.onDone()}>
        Continue
      </button>
    </section>
  );
}
