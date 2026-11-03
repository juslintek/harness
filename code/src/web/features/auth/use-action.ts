import { useState } from "preact/hooks";
import { errorText } from "../../format";

export interface Action {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<void>) => Promise<void>;
}

export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
