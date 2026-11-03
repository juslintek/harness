import { afterEach, beforeEach, expect, test } from "bun:test";
import { type HiringWorld, hiringWorld } from "../../test-support/hiring-kit";
import { candidateRunEnded, getHire } from "../hiring/api";
import { getProfile } from "../profiles/api";
import { mintRunToken } from "./api";
import { call, listen } from "./test-kit";

let w: HiringWorld;
let server: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
  w = hiringWorld();
  server = await listen(w.db);
});
afterEach(() => {
  server.stop(true);
});

const memberToken = (memberId: string): string =>
  mintRunToken(w.db, Bun.randomUUIDv7(), ["report", "guard_hook", "hiring", "profile"], {
    memberId,
    orgId: w.orgId,
  });
const candidateToken = (candidateId: string): string =>
  mintRunToken(w.db, Bun.randomUUIDv7(), ["report", "guard_hook", "interview"], {
    candidateId,
    orgId: w.orgId,
  });

const goodCard = {
  summary: "Backend dev",
  specialties: ["backend"],
  strengths: ["sql"],
  limits: ["no frontend"],
  preferredTaskTypes: ["feature"],
};

test("profile_card_submit with a bad card returns the issues, a good card is stored", async () => {
  const hire = await w.file();
  const cand = hire.candidates[0];
  const token = candidateToken(cand?.id as string);
  const bad = await call(server, token, "profile_card_submit", { card: { summary: "x" } });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("limits");
  expect(getProfile(w.db, cand?.profile.id as string)?.card).toBeNull();
  const good = await call(server, token, "profile_card_submit", { card: goodCard });
  expect(good.isError).toBe(false);
  expect(getProfile(w.db, cand?.profile.id as string)?.card?.summary).toBe("Backend dev");
});

test("a member submits its own card and reads a teammate's profile", async () => {
  const dev = w.agent("dev");
  const token = memberToken(dev.id);
  expect((await call(server, token, "profile_card_submit", { card: goodCard })).isError).toBe(
    false,
  );
  const own = JSON.parse((await call(server, token, "profile_get")).text);
  expect(own).toMatchObject({ handle: "dev", runtime: "claude", card: { summary: "Backend dev" } });
  const boss = await call(server, token, "profile_get", { handle: "boss" });
  expect(boss).toEqual({ isError: true, text: "no profile" });
  expect(
    w.db.query("SELECT 1 FROM members WHERE handle = 'boss' AND profile_id IS NOT NULL").get(),
  ).toBeNull();
  const mate = w.agent("mate");
  await call(server, memberToken(mate.id), "profile_get");
  const seen = JSON.parse((await call(server, token, "profile_get", { handle: "mate" })).text);
  expect(seen).toMatchObject({ handle: "mate", card: null });
  expect((await call(server, token, "profile_get", { handle: "nobody" })).isError).toBe(true);
});

test("profile_get with the caller's own handle behaves like no handle", async () => {
  const dev = w.agent("dev");
  const token = memberToken(dev.id);
  const own = await call(server, token, "profile_get", { handle: "dev" });
  expect(own.isError).toBe(false);
  expect(JSON.parse(own.text)).toMatchObject({ handle: "dev", card: null });
  expect(await call(server, token, "profile_get", { handle: "@dev" })).toEqual(own);
});

test("a candidate who answers the text questions and submits a card is answered", async () => {
  const hire = await w.file();
  const cand = hire.candidates[0];
  const token = candidateToken(cand?.id as string);
  for (const q of hire.questions.slice(0, 2)) {
    await call(server, token, "interview_answer", { question: q.id, answer: "my answer" });
  }
  expect((await call(server, token, "profile_card_submit", { card: goodCard })).isError).toBe(
    false,
  );
  candidateRunEnded(w.db, w.deps, cand?.id as string, true);
  const now = getHire(w.db, hire.id)?.candidates.find((c) => c.id === cand?.id);
  expect(now?.status).toBe("answered");
  expect(now?.answers).toHaveLength(3);
});
