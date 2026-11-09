import pkg from "../../package.json";

declare const HARNESS_VERSION: string;

// `bun build --define HARNESS_VERSION=...` replaces the identifier; unbuilt runs use package.json.
export const version: string = typeof HARNESS_VERSION === "string" ? HARNESS_VERSION : pkg.version;
