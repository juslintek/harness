import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, hostTarget, parseTarget } from "./build";

const VERSION = "9.9.9-test";
const BUILD_TIMEOUT_MS = 120_000;
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-build-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function readPort(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`binary exited before listening: ${seen}`);
    seen += chunk.value;
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(seen);
    if (match?.[1]) return Number(match[1]);
  }
}

describe("host binary", () => {
  test(
    "serves health version, ui and pwa assets without the source tree",
    async () => {
      const bin = await build({ target: hostTarget(), out: join(dir, "host"), version: VERSION });
      const home = mkdtempSync(join(dir, "home-"));
      const proc = Bun.spawn([bin], {
        cwd: home,
        env: { PATH: process.env.PATH ?? "", HARNESS_HOME: home, HARNESS_PORT: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const base = `http://127.0.0.1:${await readPort(proc)}`;
        const health = (await (await fetch(`${base}/api/health`)).json()) as { version: string };
        expect(health.version).toBe(VERSION);
        const app = await fetch(`${base}/_app`);
        expect(app.status).toBe(200);
        expect(await app.text()).toContain("<script");
        for (const path of ["/manifest.webmanifest", "/sw.js", "/icon.svg"]) {
          const res = await fetch(`${base}${path}`);
          expect(res.status).toBe(200);
          expect((await res.text()).length).toBeGreaterThan(0);
        }
      } finally {
        proc.kill();
        await proc.exited;
      }
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("cross targets", () => {
  for (const name of ["linux-x64", "linux-arm64"]) {
    test(
      `${name} builds a nonempty ELF`,
      async () => {
        const bin = await build({ target: parseTarget(name), out: join(dir, name) });
        const file = Bun.file(bin);
        expect(file.size).toBeGreaterThan(0);
        const magic = Buffer.from(await file.slice(0, 4).arrayBuffer()).toString("hex");
        expect(magic).toBe("7f454c46");
      },
      BUILD_TIMEOUT_MS,
    );
  }
});
