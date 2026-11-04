import { expect, test } from "bun:test";
import { liveProcesses } from "../kit/fixtures";
import { boot, commandFor } from "../kit/server";

test("C0-kit-live-processes [phase:0] [slice:kit]", () => {
  expect(liveProcesses(`no-such-process-${crypto.randomUUID()}`)).toBe(0);
});

test("C0-kit-zig-bin-from-opts [phase:0] [slice:kit]", async () => {
  const missing = `/nonexistent/${crypto.randomUUID()}/harness`;
  await expect(boot({ target: "zig", env: { HARNESS_ZIG_BIN: missing } })).rejects.toThrow(
    `zig binary not found: ${missing}`,
  );
});

test("C0-kit-zig-argv [phase:0] [slice:kit]", () => {
  const bin = process.execPath;
  const { argv } = commandFor("zig", { HARNESS_ZIG_BIN: bin });
  expect(argv).toEqual([bin, "serve"]);
});
