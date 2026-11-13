import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, headersFor } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

// zod 4.6.7 counts code points in `.min()` and `.max()` and accepts only a JSON string for a string
// field; `std.json` on the Zig side counts UTF-16 units by default and reads a byte array or an
// integer into a string. Both servers must answer the same on every input below.

// Saving a key must never reach a real Keychain: the server runs with stubs for the tools the
// agents code shells out to, as in c2-agents.
const bin = realpathSync(mkdtempSync(join(tmpdir(), "harness-body-parity-bin-")));
for (const [name, body] of [
  ["which", 'command -v "$1"'],
  ["security", "exit 44"],
  ["tmutil", "exit 0"],
] as const) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

let admin: SeededSession;
const lazy = lazyBoot({
  seed: (db) => {
    admin = seedSession(db, { admin: true, stepUp: true });
  },
  env: { PATH: bin },
});
afterAll(async () => {
  try {
    await lazy.stop();
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// One code point, two UTF-16 units.
const emoji = (n: number): string => "\u{1F600}".repeat(n);
const bytesOf = (text: string): number[] => [...new TextEncoder().encode(text)];

const raw = async (
  method: string,
  path: string,
  body: Blob | string,
  anon = false,
): Promise<Response> => {
  // The session is seeded while the server boots, so it is only known after `get()`.
  const server = await lazy.get();
  return fetch(`${server.base}${path}`, {
    method,
    redirect: "manual",
    headers: headersFor(server, anon ? undefined : admin, { "content-type": "application/json" }),
    body,
  });
};

const invalidBody = async (res: Response): Promise<void> => {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid body" });
};

const quota = (over: Record<string, unknown>): Promise<Response> =>
  raw(
    "POST",
    "/api/quota",
    JSON.stringify({ provider: "p", window: "w", usedPercent: 10, ...over }),
  );

test("C2-body-parity: string limits count code points, not UTF-16 units [phase:2] [slice:parity]", async () => {
  // usage: provider and window are min(1).max(40).
  for (const field of ["provider", "window"]) {
    expect((await quota({ [field]: emoji(40) })).status).toBe(200);
    await invalidBody(await quota({ [field]: emoji(41) }));
    await invalidBody(await quota({ [field]: "" }));
  }

  // search: q is trimmed, then min(1).max(200).
  const search = async (q: string): Promise<Response> => {
    const server = await lazy.get();
    return api(server, admin).call("GET", `/api/search?q=${encodeURIComponent(q)}`);
  };
  expect((await search(emoji(200))).status).toBe(200);
  const over = await search(emoji(201));
  expect(over.status).toBe(400);
  expect(await over.json()).toEqual({ error: "invalid query" });

  // auth: the email-code `code` is trimmed, then min(1).max(64). A code that fits is refused later
  // for being wrong, so the answer is anything but the validation error.
  const verify = (code: unknown): Promise<Response> =>
    raw("POST", "/api/auth/email/verify", JSON.stringify({ email: "a@example.com", code }), true);
  expect((await verify(emoji(64))).status).not.toBe(400);
  await invalidBody(await verify(emoji(65)));
  await invalidBody(await verify("   "));

  // auth: the login challenge id is min(1).max(64).
  const login = (challengeId: string): Promise<Response> =>
    raw(
      "POST",
      "/api/auth/login/verify",
      JSON.stringify({
        challengeId,
        response: {
          id: "a",
          rawId: "a",
          type: "public-key",
          clientExtensionResults: {},
          response: { clientDataJSON: "a", authenticatorData: "a", signature: "a" },
        },
      }),
      true,
    );
  expect((await login(emoji(64))).status).not.toBe(400);
  await invalidBody(await login(emoji(65)));
});

test("C2-body-parity: a string field takes a JSON string and nothing else [phase:2] [slice:parity]", async () => {
  const secret = "sk-0123456789abcdefghij";
  // The key as the bytes of a valid key: std.json would read this into a []const u8.
  const asBytes = await raw(
    "POST",
    "/api/agents/keys/openai",
    JSON.stringify({ key: bytesOf(secret) }),
  );
  expect(asBytes.status).toBe(400);
  expect(await asBytes.json()).toEqual({ error: "invalid key" });
  for (const key of [123456, 1.5, true, ["a"], {}, null]) {
    const res = await raw("POST", "/api/agents/keys/openai", JSON.stringify({ key }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid key" });
  }

  for (const provider of [bytesOf("p"), 7, 3, true, null, {}, ["p"]]) {
    await invalidBody(await quota({ provider }));
  }
  await invalidBody(await quota({ usedPercent: "10" }));
  await invalidBody(await quota({ usedPercent: [10] }));

  // auth: byte arrays and numbers where a string belongs.
  for (const code of [bytesOf("123456"), 123456, true, null]) {
    await invalidBody(
      await raw(
        "POST",
        "/api/auth/email/verify",
        JSON.stringify({ email: "a@example.com", code }),
        true,
      ),
    );
  }
  await invalidBody(
    await raw(
      "POST",
      "/api/auth/email/verify",
      JSON.stringify({ email: bytesOf("a@example.com"), code: "123456" }),
      true,
    ),
  );
});

test("C2-body-parity: bodies that are not objects, not JSON or not UTF-8 are refused alike [phase:2] [slice:parity]", async () => {
  for (const body of ["[]", "null", '"text"', "7", "", "{", '{"provider":"p",}']) {
    await invalidBody(await raw("POST", "/api/quota", body));
  }
  // A byte that cannot start any JSON token. Invalid UTF-8 inside a string is a known gap: Bun
  // decodes it to U+FFFD first, the Zig server refuses it.
  const stray = new Uint8Array([0x7b, 0xff, 0x7d]);
  await invalidBody(await raw("POST", "/api/quota", new Blob([stray])));
  // Duplicate keys: the last one wins, and unknown keys do not matter to the agents route.
  expect((await quota({ extra: 1 })).status).toBe(400);
  const dup = '{"provider":"x","provider":"y","window":"w","usedPercent":1}';
  expect((await raw("POST", "/api/quota", dup)).status).toBe(200);
});
