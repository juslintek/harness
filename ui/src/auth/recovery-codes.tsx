import { createMemo, createSignal, For, type JSX, onCleanup } from "solid-js";
import { Button, Checkbox } from "../ui/atoms";
import { Notice } from "../ui/molecules";
import "./auth.css";

// The codes are shown once and never again, so the way on stays locked until the user confirms.
export function RecoveryCodes(props: { codes: string[]; onDone: () => void }): JSX.Element {
  const [saved, setSaved] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const text = (): string => `${props.codes.join("\n")}\n`;
  const file = createMemo(() => URL.createObjectURL(new Blob([text()], { type: "text/plain" })));
  onCleanup(() => URL.revokeObjectURL(file()));
  return (
    <section class="auth-form" aria-labelledby="codes-h">
      <h4 id="codes-h" class="sr-only">
        Your codes
      </h4>
      <p class="auth-note">
        A recovery code signs you in once if you lose your passkey. Use it on the sign-in page. Each
        code works one time.
      </p>
      <Notice tone="warning" title="These codes are not shown again" standing>
        Copy or download them now and keep them somewhere safe.
      </Notice>
      <ul class="codes">
        <For each={props.codes}>
          {(code) => (
            <li>
              <code>{code}</code>
            </li>
          )}
        </For>
      </ul>
      <div class="codes-tools">
        <Button
          onClick={() =>
            void navigator.clipboard.writeText(text()).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          Copy codes
        </Button>
        <a class="btn" data-tone="secondary" href={file()} download="harness-recovery-codes.txt">
          Download codes
        </a>
      </div>
      <p class="sr-only" role="status">
        {copied() ? "Copied" : ""}
      </p>
      <Checkbox checked={saved()} onChange={setSaved} label="I saved them" />
      <Button tone="primary" class="wide" disabled={!saved()} onClick={() => props.onDone()}>
        Continue
      </Button>
      <p class="auth-note">Continue turns on when the box is ticked.</p>
    </section>
  );
}
