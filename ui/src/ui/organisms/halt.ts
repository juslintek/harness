import { haltBody } from "@shared/runs";
import { createSignal } from "solid-js";
import { api } from "../../api";
import { me } from "../../auth/me";
import { errorText } from "../../format";
import { createLoad } from "../../load";

export interface Halt {
  // undefined until the server answered, and always for people who cannot read it.
  halted: () => boolean | undefined;
  failure: () => string | null;
  toggle: () => Promise<void>;
}

// Instance admins only: GET /api/halt is an admin route. A POST may need a passkey (api() handles
// that); afterwards the state is read again, so a refused change snaps back.
export function createHalt(): Halt {
  const state = me()?.user.instanceAdmin ? createLoad("/api/halt", haltBody, ["runs"]) : null;
  const [failure, setFailure] = createSignal<string | null>(null);
  const halted = (): boolean | undefined => state?.data()?.halted;
  const toggle = async (): Promise<void> => {
    try {
      await api("/api/halt", haltBody, { method: "POST", body: { halted: !halted() } });
      setFailure(null);
    } catch (err) {
      setFailure(errorText(err));
    }
    await state?.reload();
  };
  return { halted, failure, toggle };
}
