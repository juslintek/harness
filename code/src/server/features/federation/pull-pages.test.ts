import { afterAll, beforeAll, expect, test } from "bun:test";
import { DomainError } from "../../route-kit";
import { BodyTooLarge, readJsonCapped } from "./client";
import { MAX_PAGE_BYTES, PAGE_LIMIT } from "./feed";
import { type PullStats, pullPeer } from "./pull";
import {
  answerFeed,
  beeTask,
  cursorOf,
  feedOf,
  type Node,
  peerOn,
  rowsOf,
  type Seed,
  writePair,
} from "./sync-kit";

const MIB = 1024 * 1024;

interface Probe {
  pulled: number;
  cancelled: boolean;
}

// A body of `total` bytes in 1 MiB chunks that records how far the reader got before letting go.
function chunked(total: number, probe: Probe): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(MIB).fill(0x20);
  return new ReadableStream({
    pull(controller) {
      if (probe.pulled * MIB >= total) return controller.close();
      probe.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      probe.cancelled = true;
    },
  });
}

const declaring = (length: number, body?: BodyInit): Response =>
  new Response(body ?? "{}", { headers: { "content-length": String(length) } });

test("a body at the cap parses and one byte over is refused", async () => {
  expect(await readJsonCapped(new Response('{"a":1}'), 7)).toEqual({ a: 1 });
  await expect(readJsonCapped(new Response('{"a":1} '), 7)).rejects.toBeInstanceOf(BodyTooLarge);
});

test("a declared length at the cap is read and one byte over is refused", async () => {
  expect(await readJsonCapped(declaring(7, '{"a":1}'), 7)).toEqual({ a: 1 });
  await expect(readJsonCapped(declaring(8, '{"a":1} '), 7)).rejects.toBeInstanceOf(BodyTooLarge);
});

test("a declared length over the cap is refused without reading the body", async () => {
  const probe = { pulled: 0, cancelled: false };
  const res = declaring(100, chunked(10 * MIB, probe));
  await expect(readJsonCapped(res, 99)).rejects.toBeInstanceOf(BodyTooLarge);
  expect(probe.pulled).toBeLessThanOrEqual(2);
  expect(probe.cancelled).toBe(true);
});

test("a body that is not JSON is a plain DomainError, not a size error", async () => {
  const failure = await readJsonCapped(new Response("not json"), 100).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(DomainError);
  expect(failure).not.toBeInstanceOf(BodyTooLarge);
  expect((failure as Error).message).toBe("peer sent an unreadable page");
});

let a: Node;
let b: Node;
let seed: Seed;

beforeAll(async () => {
  ({ a, b, seed } = await writePair());
});

afterAll(() => {
  a.stop();
  b.stop();
});

async function pullFrom(answer: (url: URL) => Response): Promise<PullStats> {
  const restore = answerFeed(answer);
  try {
    return await pullPeer(a.db, a.home, peerOn(a, b));
  } finally {
    restore();
  }
}

const limitOf = (url: URL): number => Number(url.searchParams.get("limit"));
const sinceOf = (url: URL): number => Number(url.searchParams.get("since"));

test("a page with more changes than the limit is refused whole", async () => {
  const changes = Array.from({ length: PAGE_LIMIT + 1 }, (_, i) =>
    feedOf(i + 1, beeTask(b, `many-${i}`, seed)),
  );
  const tasks = rowsOf(a.db, "tasks").length;
  const cursor = cursorOf(a, b);
  const asked: number[] = [];
  const pulled = pullFrom((url) => {
    asked.push(limitOf(url));
    return Response.json({ changes, next: changes.length });
  });
  await expect(pulled).rejects.toThrow("peer sent an unreadable page");
  // Only a page that was too big to read is asked again smaller, never one that was unusable.
  expect(asked).toEqual([PAGE_LIMIT]);
  expect(rowsOf(a.db, "tasks")).toHaveLength(tasks);
  expect(cursorOf(a, b)).toBe(cursor);
});

test("a peer that answers 503 is asked once and its error is the one raised", async () => {
  const cursor = cursorOf(a, b);
  const asked: number[] = [];
  const pulled = pullFrom((url) => {
    asked.push(limitOf(url));
    return new Response("busy", { status: 503 });
  });
  await expect(pulled).rejects.toThrow("peer answered 503");
  expect(asked).toEqual([PAGE_LIMIT]);
  expect(cursorOf(a, b)).toBe(cursor);
});

test("a page that declares more than the byte cap is never read", async () => {
  const cursor = cursorOf(a, b);
  const probes: Probe[] = [];
  const pulled = pullFrom(() => {
    const probe = { pulled: 0, cancelled: false };
    probes.push(probe);
    return declaring(MAX_PAGE_BYTES + 1, chunked(40 * MIB, probe));
  });
  await expect(pulled).rejects.toBeInstanceOf(BodyTooLarge);
  expect(probes.length).toBeGreaterThan(0);
  for (const probe of probes) {
    expect(probe.pulled).toBeLessThanOrEqual(2);
    expect(probe.cancelled).toBe(true);
  }
  expect(cursorOf(a, b)).toBe(cursor);
});

test("a page that streams past the byte cap is dropped long before its end", async () => {
  const cursor = cursorOf(a, b);
  const probes: Probe[] = [];
  const pulled = pullFrom(() => {
    const probe = { pulled: 0, cancelled: false };
    probes.push(probe);
    return new Response(chunked(40 * MIB, probe));
  });
  await expect(pulled).rejects.toBeInstanceOf(BodyTooLarge);
  expect(probes.length).toBeGreaterThan(0);
  for (const probe of probes) {
    expect(probe.pulled).toBeLessThanOrEqual(MAX_PAGE_BYTES / MIB + 2);
    expect(probe.cancelled).toBe(true);
  }
  expect(cursorOf(a, b)).toBe(cursor);
});

test("a peer that is too big even for a page of one is refused after halving down to it", async () => {
  const cursor = cursorOf(a, b);
  const asked: number[] = [];
  const pulled = pullFrom((url) => {
    asked.push(limitOf(url));
    return declaring(MAX_PAGE_BYTES + 1);
  });
  await expect(pulled).rejects.toBeInstanceOf(BodyTooLarge);
  expect(asked).toEqual([500, 250, 125, 62, 31, 15, 7, 3, 1]);
  expect(cursorOf(a, b)).toBe(cursor);
});

test("an honest peer with big rows is caught up on a halved limit, every row and page", async () => {
  const feed = Array.from({ length: 25 }, (_, i) => feedOf(i + 1, beeTask(b, `row-${i}`, seed)));
  const tasks = rowsOf(a.db, "tasks").length;
  const asked: number[] = [];
  const stats = await pullFrom((url) => {
    asked.push(limitOf(url));
    // Pages of up to 10 rows fit, anything asked for beyond that is too big to send.
    if (limitOf(url) > 10) return declaring(MAX_PAGE_BYTES + 1);
    const changes = feed.filter((c) => c.seq > sinceOf(url)).slice(0, limitOf(url));
    return Response.json({ changes, next: changes.at(-1)?.seq ?? sinceOf(url) });
  });
  // Every page that fits doubles the limit, and 14 rows are too big here, so each page of 7 is
  // followed by one refused probe at 14.
  expect(asked).toEqual([500, 250, 125, 62, 31, 15, 7, 14, 7, 14, 7, 14, 7]);
  expect(stats).toEqual({ applied: 25, stale: 0, rejected: 0 });
  expect(rowsOf(a.db, "tasks")).toHaveLength(tasks + 25);
  expect(cursorOf(a, b)).toBe("25");
});

test("a peer that declares exactly the byte cap is read", async () => {
  const stats = await pullFrom(() =>
    declaring(MAX_PAGE_BYTES, JSON.stringify({ changes: [], next: 0 })),
  );
  expect(stats).toEqual({ applied: 0, stale: 0, rejected: 0 });
});

test("a page of exactly the limit is taken in whole", async () => {
  const base = Number(cursorOf(a, b) ?? 0);
  const feed = Array.from({ length: PAGE_LIMIT }, (_, i) =>
    feedOf(base + i + 1, beeTask(b, `full-${i}`, seed)),
  );
  const tasks = rowsOf(a.db, "tasks").length;
  const asked: number[] = [];
  const stats = await pullFrom((url) => {
    asked.push(limitOf(url));
    const changes = feed.filter((c) => c.seq > sinceOf(url)).slice(0, limitOf(url));
    return Response.json({ changes, next: changes.at(-1)?.seq ?? sinceOf(url) });
  });
  expect(asked).toEqual([PAGE_LIMIT, PAGE_LIMIT]);
  expect(stats).toEqual({ applied: PAGE_LIMIT, stale: 0, rejected: 0 });
  expect(rowsOf(a.db, "tasks")).toHaveLength(tasks + PAGE_LIMIT);
  expect(cursorOf(a, b)).toBe(String(base + PAGE_LIMIT));
});

// A feed of `total` rows in which two adjacent notes each fit a page but not together: only a page
// holding both is too big. Returns the limits the puller asked for, after checking that no row or
// page was lost.
async function pullPastBigPair(name: string, total: number, first: number): Promise<number[]> {
  const base = Number(cursorOf(a, b) ?? 0);
  const feed = Array.from({ length: total }, (_, i) =>
    feedOf(base + i + 1, beeTask(b, `${name}-${i}`, seed)),
  );
  const together = new Set([base + first, base + first + 1]);
  const tasks = rowsOf(a.db, "tasks").length;
  const asked: number[] = [];
  const stats = await pullFrom((url) => {
    asked.push(limitOf(url));
    const changes = feed.filter((c) => c.seq > sinceOf(url)).slice(0, limitOf(url));
    if (changes.filter((c) => together.has(c.seq)).length === 2) {
      return declaring(MAX_PAGE_BYTES + 1);
    }
    return Response.json({ changes, next: changes.at(-1)?.seq ?? sinceOf(url) });
  });
  expect(stats).toEqual({ applied: total, stale: 0, rejected: 0 });
  expect(rowsOf(a.db, "tasks")).toHaveLength(tasks + total);
  expect(cursorOf(a, b)).toBe(String(base + total));
  return asked;
}

// The big pair sits in the middle of a long feed, so the limit has to come back up once it is
// behind the puller.
test("the limit grows back after the big rows, without losing a row or a page", async () => {
  expect(await pullPastBigPair("grow", 700, 100)).toEqual([
    ...[500, 250, 125, 62, 124, 62, 31, 62, 31, 15, 7],
    ...[14, 28, 56, 112, 224, 448],
  ]);
});

// With the pair at the very start the climb has to go all the way back to the cap, not stop short.
test("the limit climbs back up to the cap after big rows at the start of the feed", async () => {
  expect(await pullPastBigPair("climb", 1300, 1)).toEqual([
    ...[500, 250, 125, 62, 31, 15, 7, 3, 1, 2, 4, 8, 16, 32, 64, 128, 256],
    ...[PAGE_LIMIT, PAGE_LIMIT],
  ]);
});
