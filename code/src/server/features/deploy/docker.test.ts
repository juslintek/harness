import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverDocker } from "./docker";

const FAKE_BIN = join(import.meta.dir, "../../test-support/fake-bin-dist");

afterEach(() => {
  delete process.env.FAKE_DOCKER_RAW;
});

test("one JSON object per line becomes a context", async () => {
  expect((await discoverDocker(FAKE_BIN)).map((c) => c.name)).toEqual(["default", "build-box"]);
});

test("bad lines are ignored and good ones kept", async () => {
  process.env.FAKE_DOCKER_RAW = 'garbage\n{"Name":"ok","DockerEndpoint":"ssh://h"}\n{"x":1}';
  expect(await discoverDocker(FAKE_BIN)).toEqual([
    { name: "ok", endpoint: "ssh://h", description: "" },
  ]);
});

test("an absent binary gives an empty list", async () => {
  expect(await discoverDocker(join(import.meta.dir, "no-such-bin"))).toEqual([]);
});
