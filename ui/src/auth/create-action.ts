import { createSignal } from "solid-js";
import { errorText } from "../format";

export interface Action {
  busy: () => boolean;
  error: () => string | null;
  run: (fn: () => Promise<void>) => Promise<void>;
}

export function createAction(): Action {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
