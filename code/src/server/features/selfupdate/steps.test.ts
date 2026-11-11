import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test-support/selfupdate-kit";
import { runBuild } from "./steps";

test("a stderr line after the binary path does not replace the path", async () => {
  const dir = tempDir("build-out");
  const deps = {
    install: ["true"],
    check: ["true"],
    build: (out: string) => [
      "sh",
      "-c",
      `echo '#!/bin/sh' > "${out}.bin"; echo "${out}.bin"; echo 'warning: noisy' >&2`,
    ],
  };
  const stored = join(dir, "bin", "harness-x");
  await runBuild(deps, dir, join(dir, "dist"), stored);
  expect(existsSync(stored)).toBe(true);
});
