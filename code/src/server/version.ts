import pkg from "../../package.json";

declare const HARNESS_VERSION: string;
declare const HARNESS_COMMIT: string;

// `bun build --define HARNESS_VERSION=...` replaces the identifier; unbuilt runs use package.json.
export const version: string = typeof HARNESS_VERSION === "string" ? HARNESS_VERSION : pkg.version;

// The git commit the binary was built from. Unbuilt runs and builds outside a checkout have none.
export const commit: string | null =
  typeof HARNESS_COMMIT === "string" && HARNESS_COMMIT !== "" ? HARNESS_COMMIT : null;
