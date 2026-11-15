import { join } from "node:path";

// Where agents/accounts-ops.ts keeps one home per extra login. A run never needs another
// account's credential file, so every guard layer denies this whole directory.
export const accountsRoot = (harnessHome: string): string => join(harnessHome, "accounts");
