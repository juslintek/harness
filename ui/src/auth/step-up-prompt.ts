import { createSignal } from "solid-js";

const [pendingAction, setAction] = createSignal<string | null>(null);
let current: Promise<void> | null = null;
let answer: { ok: () => void; cancel: () => void } | null = null;

// Resolves when the person agrees to the passkey check, rejects when they cancel. Calls that overlap
// share one prompt, since one fresh check covers them all.
export function askStepUp(what: string): Promise<void> {
  current ??= new Promise<void>((ok, fail) => {
    answer = { ok, cancel: () => fail(new Error("Passkey check cancelled.")) };
    setAction(what);
  }).finally(() => {
    current = null;
    setAction(null);
  });
  return current;
}

export { pendingAction };

export function answerStepUp(agreed: boolean): void {
  if (agreed) answer?.ok();
  else answer?.cancel();
}
