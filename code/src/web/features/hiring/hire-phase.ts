import type { HireView } from "../../../shared/hiring";

// The server rejects scores outside "scoring" and decisions outside "deciding", so the forms only show then.
export const hirePhase = (status: HireView["status"]): { scoring: boolean; deciding: boolean } => ({
  scoring: status === "scoring",
  deciding: status === "deciding",
});
