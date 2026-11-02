import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { decide, layaHealth, resetLayaCircuit } from "./client";

let hits = { n: 0 };

async function stub(handler: (req: Request) => Response | Promise<Response>): Promise<void> {
  const started = await startStub(handler);
  hits = started.calls;
  process.env.OLLAYA_URL = started.url;
}

const questions = { d: { type: "noul" as const, instructions: "Is it bad?" } };
const okBody = {
  model: "laya:en",
  answers: { d: { type: "noul", noul: 0.3 } },
  state_truncated: false,
};

beforeEach(() => {
  hits = { n: 0 };
  resetLayaCircuit();
});

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
});

describe("decide", () => {
  test("returns validated answers and the routed model", async () => {
    await stub(() => Response.json({ ...okBody, routing: { model: "laya:multilingual" } }));
    const res = await decide({ a: 1 }, questions, 1000);
    expect(res).toEqual({
      ok: true,
      answers: { d: { type: "noul", noul: 0.3 } },
      model: "laya:multilingual",
    });
  });

  test("maps failures to reasons", async () => {
    await stub(() => new Response("nope", { status: 500 }));
    expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "http" });
    await stub(() => Response.json({ model: "x", answers: { d: { type: "noul" } } }));
    expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "bad_body" });
    await stub(() => Response.json({ ...okBody, state_truncated: true }));
    expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "truncated" });
    await stub(async () => {
      await Bun.sleep(300);
      return Response.json(okBody);
    });
    expect(await decide({}, questions, 50)).toEqual({ ok: false, reason: "timeout" });
  });

  test("reports down when nothing listens", async () => {
    process.env.OLLAYA_URL = "http://127.0.0.1:1";
    expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "down" });
  });
});

describe("circuit breaker", () => {
  test("opens the circuit after 3 failures and skips the fetch", async () => {
    await stub(() => new Response("nope", { status: 500 }));
    for (let i = 0; i < 3; i++) await decide({}, questions, 1000);
    expect(hits.n).toBe(3);
    expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "circuit_open" });
    expect(hits.n).toBe(3);
  });

  test("the circuit closes again once the open window has passed", async () => {
    let fail = true;
    await stub(() => (fail ? new Response("x", { status: 500 }) : Response.json(okBody)));
    const opened = Date.now();
    for (let i = 0; i < 3; i++) await decide({}, questions, 1000);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(opened + 29_000);
      expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "circuit_open" });
      clock.mockReturnValue(opened + 31_000);
      fail = false;
      expect((await decide({}, questions, 1000)).ok).toBe(true);
      expect(hits.n).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  test("a failed probe after the window opens the circuit again", async () => {
    await stub(() => new Response("x", { status: 500 }));
    const opened = Date.now();
    for (let i = 0; i < 3; i++) await decide({}, questions, 1000);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(opened + 31_000);
      expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "http" });
      expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "circuit_open" });
      expect(hits.n).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  test("a success resets the failure count", async () => {
    let fail = true;
    await stub(() => (fail ? new Response("x", { status: 500 }) : Response.json(okBody)));
    await decide({}, questions, 1000);
    await decide({}, questions, 1000);
    fail = false;
    expect((await decide({}, questions, 1000)).ok).toBe(true);
    fail = true;
    await decide({}, questions, 1000);
    await decide({}, questions, 1000);
    expect(await decide({}, questions, 1000)).toEqual({ ok: false, reason: "http" });
  });
});

describe("layaHealth", () => {
  test("reads the version", async () => {
    await stub(() => Response.json({ version: "0.17.0" }));
    expect(await layaHealth()).toEqual({ up: true, version: "0.17.0" });
  });

  test("reports down", async () => {
    process.env.OLLAYA_URL = "http://127.0.0.1:1";
    expect(await layaHealth()).toEqual({ up: false, version: null });
  });
});
