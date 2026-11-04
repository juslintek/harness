import { expect, test } from "bun:test";
import type { RoleSpec } from "../../../shared/hiring";
import { hiringWorld } from "../../test-support/hiring-kit";
import { createTeam } from "../orgs/api";
import { fileRequest } from "./api";

const refused = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "filed",
    (err: Error) => err.message,
  );

test("a team can have one open hire request at a time", async () => {
  const w = hiringWorld();
  const first = await w.file();
  expect(await refused(w.file())).toBe("this team already has an open hire request");
  w.db.query("UPDATE hire_requests SET status = 'rejected' WHERE id = ?").run(first.id);
  expect(await refused(w.file())).toBe("filed");
});

test("an org gets 3 hire requests per rolling 24 hours", async () => {
  const w = hiringWorld();
  for (let n = 0; n < 3; n++) {
    await w.file();
    w.db.query("UPDATE hire_requests SET status = 'rejected'").run();
    w.clock.now += 60_000;
  }
  expect(await refused(w.file())).toBe(
    "this org already filed 3 hire requests in the last 24 hours",
  );
  w.clock.now += 24 * 60 * 60 * 1000;
  expect(await refused(w.file())).toBe("filed");
});

test("a requester whose budget is exhausted cannot file, a person without a member can", async () => {
  const w = hiringWorld();
  const paused = { ...w.deps, budgetPaused: (id: string) => id === w.boss.id };
  const spec: RoleSpec = {
    title: "Backend Engineer",
    specialty: "backend",
    summary: "own the billing API",
    mustHave: [],
    taskTypes: ["feature"],
  };
  const input = { orgId: w.orgId, teamId: w.teamId, spec };
  expect(await refused(fileRequest(w.db, paused, { ...input, requestedBy: w.boss.id }))).toBe(
    "your budget is exhausted, so no new interviews can start",
  );
  expect(await refused(fileRequest(w.db, paused, { ...input, requestedBy: "user:u1" }))).toBe(
    "filed",
  );
});

test("two requests filed at the same moment for one team make exactly one request", async () => {
  const w = hiringWorld();
  const results = await Promise.all([refused(w.file()), refused(w.file())]);
  expect(results.sort()).toEqual(["filed", "this team already has an open hire request"]);
  expect(w.db.query("SELECT COUNT(*) AS n FROM hire_requests").get()).toEqual({ n: 1 });
});

test("parallel requests across teams still respect the org's daily limit", async () => {
  const w = hiringWorld();
  const teams = [w.teamId, ...[1, 2, 3].map((n) => createTeam(w.db, w.orgId, `t${n}`).id)];
  const spec: RoleSpec = {
    title: "Dev",
    specialty: "backend",
    summary: "x",
    mustHave: [],
    taskTypes: ["feature"],
  };
  const results = await Promise.all(
    teams.map((teamId) =>
      refused(fileRequest(w.db, w.deps, { orgId: w.orgId, teamId, requestedBy: "user:u1", spec })),
    ),
  );
  expect(results.filter((r) => r === "filed")).toHaveLength(3);
});
