import { useState } from "preact/hooks";

// The clipboard API needs a secure context; on plain http the text stays selectable in its field.
export function CopyButton({ text, label }: { text: string; label: string }): preact.JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => setState("done"),
      () => setState("failed"),
    );
  };
  return (
    <>
      <button type="button" onClick={copy} aria-label={label}>
        Copy
      </button>
      <span class="muted" role="status">
        {state === "done" && "Copied"}
        {state === "failed" && "Copy failed, select the text and copy it by hand"}
      </span>
    </>
  );
}
