import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { api } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

// One small world, written before the server starts: org A with an owner, a plain member and an
// agent that runs; org B with an owner and an agent; a project of org B that org A's agent runs in.
// No endpoint creates approvals or run tokens, so those rows are seeded too.
const FAR = Date.now() + 24 * 60 * 60 * 1000;
const sessions = {} as Record<
  "admin" | "adminStale" | "ownerA" | "ownerAStale" | "memberA" | "ownerB" | "plain",
  SeededSession
>;
const tokens = {} as Record<"hook" | "report" | "otherRun", string>;

const ACTION = (command: string): string => JSON.stringify({ kind: "execute", command, paths: [] });
const L1 = (reason: string, category = "shell"): string =>
  JSON.stringify({ verdict: "ask", rule: "shell.unknown", reason, category });

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function seedOrgs(db: Database): void {
  const member = db.query(
    `INSERT INTO members (id, org_id, kind, user_id, agent_id, handle, display_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  db.query("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, 1)").run(
    "org-a",
    "org-a",
    "A",
  );
  db.query("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, 1)").run(
    "org-b",
    "org-b",
    "B",
  );
  member.run("m-owner-a", "org-a", "human", sessions.ownerA.userId, null, "owner-a", "OA", "owner");
  member.run(
    "m-stale-a",
    "org-a",
    "human",
    sessions.ownerAStale.userId,
    null,
    "stale-a",
    "SA",
    "owner",
  );
  member.run(
    "m-member-a",
    "org-a",
    "human",
    sessions.memberA.userId,
    null,
    "member-a",
    "MA",
    "member",
  );
  member.run("m-agent-a", "org-a", "agent", null, "claude", "agent-a", "Agent A", "member");
  member.run("m-owner-b", "org-b", "human", sessions.ownerB.userId, null, "owner-b", "OB", "owner");
  member.run("m-agent-b", "org-b", "agent", null, "claude", "agent-b", "Agent B", "member");
  db.query(
    "INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('proj-b', 'org-b', 'PB', 'PB', 1)",
  ).run();
}

function seedRuns(db: Database): void {
  const run = db.query(
    `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, ended_at, member_id, project_id)
     VALUES (?, 'claude', '/r', 'p', 'done', 1, 2, ?, ?)`,
  );
  run.run("run-a", "m-agent-a", null);
  run.run("run-b", "m-agent-b", null);
  run.run("run-a-in-b", "m-agent-a", "proj-b");
  run.run("run-none", null, null);
}

interface SeedApproval {
  id: string;
  runId: string;
  at: number;
  action?: string;
  l1?: string;
  status?: string;
  decidedBy?: string;
  expiresAt?: number;
  decidedAt?: number;
}

function seedApprovals(db: Database): void {
  const insert = db.query(
    `INSERT INTO approvals (id, run_id, action, l1, l2, status, decided_by, created_at, expires_at, decided_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  );
  const rows: SeedApproval[] = [
    { id: "ap-01-list", runId: "run-a", at: 10 },
    {
      id: "ap-02-done",
      runId: "run-a",
      at: 11,
      action: JSON.stringify({ kind: "edit", paths: ["a.txt", "b.txt"] }),
      l1: JSON.stringify({ verdict: "ask", rule: "edit.x", category: "write" }),
      status: "approved",
      decidedBy: "user:someone",
      decidedAt: 12,
    },
    { id: "ap-03-b", runId: "run-b", at: 12, action: ACTION("make") },
    { id: "ap-04-a-in-b", runId: "run-a-in-b", at: 13, action: ACTION("make") },
    {
      id: "ap-05-net",
      runId: "run-a",
      at: 14,
      action: ACTION("curl example.test"),
      l1: L1("network", "network"),
    },
    { id: "ap-06-old", runId: "run-a", at: 15, l1: L1("old"), expiresAt: 1000 },
    { id: "ap-07-none", runId: "run-none", at: 16, action: ACTION("ls") },
    ...["approve", "deny", "twice", "stale", "member", "body", "owner", "other-org"].map(
      (name, i) => ({ id: `ap-${10 + i}-${name}`, runId: "run-a", at: 20 + i }),
    ),
  ];
  for (const row of rows) {
    insert.run(
      row.id,
      row.runId,
      row.action ?? ACTION("npm test"),
      row.l1 ?? L1("needs ok"),
      row.status ?? "pending",
      row.decidedBy ?? null,
      row.at,
      row.expiresAt ?? FAR,
      row.decidedAt ?? null,
    );
  }
}

function seedTokens(db: Database): void {
  const token = (runId: string, scopes: string[]): string => {
    const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    db.query("INSERT INTO run_tokens (hash, run_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      sha256Hex(value),
      runId,
      JSON.stringify(scopes),
      Date.now(),
    );
    return value;
  };
  tokens.hook = token("run-a", ["guard_hook"]);
  tokens.report = token("run-a", ["report"]);
  tokens.otherRun = token("run-b", ["guard_hook"]);
}

function seedWorld(db: Database): void {
  seedOrgs(db);
  seedRuns(db);
  seedApprovals(db);
  seedTokens(db);
}

const lazy = lazyBoot({
  seed: (db) => {
    sessions.admin = seedSession(db, { admin: true, stepUp: true });
    sessions.adminStale = seedSession(db, { admin: true });
    sessions.ownerA = seedSession(db, { stepUp: true });
    sessions.ownerAStale = seedSession(db);
    sessions.memberA = seedSession(db, { stepUp: true });
    sessions.ownerB = seedSession(db, { stepUp: true });
    sessions.plain = seedSession(db, { stepUp: true });
    seedWorld(db);
  },
});
afterAll(() => lazy.stop());

async function post(
  who: keyof typeof sessions,
  id: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = await lazy.get();
  const res = await api(server, sessions[who]).call("POST", `/api/approvals/${id}`, { body });
  return { status: res.status, body: await res.json() };
}

async function list(
  who: keyof typeof sessions,
  query = "",
): Promise<{ status: number; body: unknown }> {
  const server = await lazy.get();
  const res = await api(server, sessions[who]).call("GET", `/api/approvals${query}`);
  return { status: res.status, body: await res.json() };
}

const idsOf = (body: unknown): string[] => (body as { id: string }[]).map((row) => row.id);

async function statusOf(id: string): Promise<string | undefined> {
  const server = await lazy.get();
  const db = new Database(join(server.home, "harness.db"), { readonly: true });
  try {
    return db
      .query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?")
      .get(id)?.status;
  } finally {
    db.close();
  }
}

test("C2-approvals-list: the instance admin sees every approval in creation order [phase:2] [slice:guard]", async () => {
  const all = await list("admin");
  expect(all.status).toBe(200);
  expect(idsOf(all.body).slice(0, 7)).toEqual([
    "ap-01-list",
    "ap-02-done",
    "ap-03-b",
    "ap-04-a-in-b",
    "ap-05-net",
    "ap-06-old",
    "ap-07-none",
  ]);
  const rows = all.body as Record<string, unknown>[];
  expect(rows[0]).toEqual({
    id: "ap-01-list",
    runId: "run-a",
    command: "npm test",
    reason: "needs ok",
    status: "pending",
    decidedBy: null,
    createdAt: 10,
    expiresAt: FAR,
    decidedAt: null,
  });
  expect(rows[1]).toEqual({
    id: "ap-02-done",
    runId: "run-a",
    command: "a.txt b.txt",
    reason: null,
    status: "approved",
    decidedBy: "user:someone",
    createdAt: 11,
    expiresAt: FAR,
    decidedAt: 12,
  });
  const approved = await list("admin", "?status=approved");
  expect(idsOf(approved.body)).toEqual(["ap-02-done"]);
  const denied = await list("admin", "?status=denied");
  expect(denied).toEqual({ status: 200, body: [] });
});

test("C2-approvals-list: an invalid status is 400 and the org gate comes first [phase:2] [slice:guard]", async () => {
  for (const query of ["?status=nope", "?status=", "?status=PENDING"]) {
    expect(await list("admin", query)).toEqual({ status: 400, body: { error: "invalid status" } });
  }
  for (const who of ["memberA", "plain"] as const) {
    expect(await list(who)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await list(who, "?status=nope")).toEqual({ status: 403, body: { error: "forbidden" } });
  }
});

test("C2-approvals-list: an org owner sees only the runs of its own org [phase:2] [slice:guard]", async () => {
  const mine = idsOf((await list("ownerA")).body);
  expect(mine.slice(0, 4)).toEqual(["ap-01-list", "ap-02-done", "ap-05-net", "ap-06-old"]);
  // The run of org A's agent in org B's project, and a run without a member, are not org A's.
  for (const id of ["ap-03-b", "ap-04-a-in-b", "ap-07-none"]) expect(mine).not.toContain(id);
  const theirs = idsOf((await list("ownerB")).body);
  expect(theirs).toEqual(["ap-03-b", "ap-04-a-in-b"]);
});

test("C2-approvals-decide: approve with a fresh step-up answers the refreshed view [phase:2] [slice:guard]", async () => {
  const res = await post("admin", "ap-10-approve", { decision: "approve" });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    id: "ap-10-approve",
    runId: "run-a",
    command: "npm test",
    status: "approved",
    decidedBy: `user:${sessions.admin.userId}`,
  });
  expect(typeof (res.body as { decidedAt: unknown }).decidedAt).toBe("number");
  expect(await statusOf("ap-10-approve")).toBe("approved");
  const denied = await post("ownerA", "ap-11-deny", { decision: "deny" });
  expect(denied.status).toBe(200);
  expect(denied.body).toMatchObject({
    status: "denied",
    decidedBy: `user:${sessions.ownerA.userId}`,
  });
});

test("C2-approvals-decide: without a fresh step-up nothing is read or changed [phase:2] [slice:guard]", async () => {
  expect(await post("adminStale", "ap-13-stale", { decision: "approve" })).toEqual({
    status: 403,
    body: { error: "step_up_required" },
  });
  expect(await post("adminStale", "nope", "garbage")).toEqual({
    status: 403,
    body: { error: "step_up_required" },
  });
  expect(await post("ownerAStale", "ap-13-stale", { decision: "approve" })).toEqual({
    status: 403,
    body: { error: "step_up_required" },
  });
  expect(await statusOf("ap-13-stale")).toBe("pending");
});

test("C2-approvals-decide: a second decision is 409, an unknown id 404, an expired one 409 [phase:2] [slice:guard]", async () => {
  expect((await post("admin", "ap-12-twice", { decision: "deny" })).status).toBe(200);
  expect(await post("admin", "ap-12-twice", { decision: "approve" })).toEqual({
    status: 409,
    body: { error: "not pending" },
  });
  expect(await statusOf("ap-12-twice")).toBe("denied");
  expect(await post("admin", "ap-02-done", { decision: "deny" })).toEqual({
    status: 409,
    body: { error: "not pending" },
  });
  for (const who of ["admin", "ownerA"] as const) {
    expect(await post(who, "no-such-approval", { decision: "approve" })).toEqual({
      status: 404,
      body: { error: "unknown approval" },
    });
  }
  expect(await post("admin", "ap-06-old", { decision: "approve" })).toEqual({
    status: 409,
    body: { error: "not pending" },
  });
  expect(await statusOf("ap-06-old")).toBe("expired");
});

test("C2-approvals-decide: a row that lapses while the server runs is 409 and ends expired [phase:2] [slice:guard]", async () => {
  // ap-06-old is seeded before boot, so the boot sweep expires it and decide never sees it pending.
  // This row is written after boot and lapses 5 ms later, then the decision arrives 15 ms after
  // that, long before the next one-second sweep in almost every run. When the sweep does win the
  // race the result is the same, 409 and an expired row, so the test cannot flake. The Zig unit
  // test of decide pins the path where the decision itself marks the row expired.
  const server = await lazy.get();
  const db = new Database(join(server.home, "harness.db"));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.query(
      `INSERT INTO approvals (id, run_id, action, l1, l2, status, decided_by, created_at, expires_at, decided_at)
       VALUES ('ap-19-lapsed', 'run-a', ?, ?, NULL, 'pending', NULL, ?, ?, NULL)`,
    ).run(ACTION("npm test"), L1("lapses"), now, now + 5);
  } finally {
    db.close();
  }
  await Bun.sleep(20);
  expect(await post("admin", "ap-19-lapsed", { decision: "approve" })).toEqual({
    status: 409,
    body: { error: "not pending" },
  });
  expect(await statusOf("ap-19-lapsed")).toBe("expired");
});

test("C2-approvals-decide: a plain member and the admin of another org are refused [phase:2] [slice:guard]", async () => {
  for (const who of ["memberA", "plain"] as const) {
    expect(await post(who, "ap-14-member", { decision: "approve" })).toEqual({
      status: 403,
      body: { error: "forbidden" },
    });
    // The org gate is first: a bad body and an unknown id are 403 too.
    expect(await post(who, "nope", "garbage")).toEqual({
      status: 403,
      body: { error: "forbidden" },
    });
  }
  expect(await post("ownerB", "ap-17-other-org", { decision: "approve" })).toEqual({
    status: 403,
    body: { error: "forbidden" },
  });
  expect(await post("ownerA", "ap-04-a-in-b", { decision: "approve" })).toEqual({
    status: 403,
    body: { error: "forbidden" },
  });
  expect(await post("ownerA", "ap-07-none", { decision: "approve" })).toEqual({
    status: 403,
    body: { error: "forbidden" },
  });
  for (const id of ["ap-14-member", "ap-17-other-org", "ap-04-a-in-b", "ap-07-none"]) {
    expect(await statusOf(id)).toBe("pending");
  }
});

test("C2-approvals-decide: an org owner may not decide a network action, the instance admin may [phase:2] [slice:guard]", async () => {
  const refused = {
    status: 403,
    body: {
      error: "instance_admin_required",
      reason: "network and secret actions need a human",
    },
  };
  expect(await post("ownerA", "ap-05-net", { decision: "approve" })).toEqual(refused);
  expect(await post("ownerA", "ap-05-net", { decision: "deny" })).toEqual(refused);
  expect(await statusOf("ap-05-net")).toBe("pending");
  expect((await post("admin", "ap-05-net", { decision: "approve" })).status).toBe(200);
  expect(await statusOf("ap-05-net")).toBe("approved");
  expect((await post("ownerA", "ap-16-owner", { decision: "approve" })).status).toBe(200);
});

test("C2-approvals-decide: the body must be exactly approve or deny [phase:2] [slice:guard]", async () => {
  const bad: unknown[] = [
    {},
    { decision: "maybe" },
    { decision: 1 },
    { decision: 0 },
    // The bytes of "approve": a JSON array is not a string.
    { decision: [97, 112, 112, 114, 111, 118, 101] },
    { decision: "APPROVE" },
    { decision: null },
    "approve",
    [],
    null,
  ];
  for (const body of bad) {
    expect(await post("admin", "ap-15-body", body)).toEqual({
      status: 400,
      body: { error: "invalid body" },
    });
  }
  expect(await statusOf("ap-15-body")).toBe("pending");
  // A bad body wins over an unknown id.
  expect((await post("admin", "no-such-approval", {})).status).toBe(400);
});

async function hook(
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = await lazy.get();
  const res = await fetch(`http://127.0.0.1:${server.port}/api/guard/hook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const REPORT = {
  runId: "run-a",
  verdict: "deny",
  rule: "git.push",
  command: "git push origin main",
};

test("C2-guard-hook: a run token with the guard_hook scope reports for its own run only [phase:2] [slice:guard]", async () => {
  const unauthorized = { status: 401, body: { error: "unauthorized" } };
  expect(await hook(null, REPORT)).toEqual(unauthorized);
  expect(await hook("not-a-token", REPORT)).toEqual(unauthorized);
  const forbidden = { status: 403, body: { error: "forbidden" } };
  expect(await hook(tokens.report, REPORT)).toEqual(forbidden);
  // The scope is checked before the body.
  expect(await hook(tokens.report, "garbage")).toEqual(forbidden);
  expect(await hook(tokens.otherRun, REPORT)).toEqual(forbidden);
  const invalid = { status: 400, body: { error: "invalid body" } };
  for (const body of [
    "garbage",
    {},
    { ...REPORT, runId: "" },
    { ...REPORT, verdict: "block" },
    { ...REPORT, verdict: 0 },
    { ...REPORT, verdict: [100, 101, 110, 121] },
    { ...REPORT, runId: [...Buffer.from("run-a")] },
    { ...REPORT, rule: [...Buffer.from("git.push")] },
    { ...REPORT, command: [...Buffer.from("git push origin main")] },
    { ...REPORT, rule: "r".repeat(201) },
    { ...REPORT, command: "c".repeat(20001) },
    // zod counts code points, so 10001 emoji are fine and 20001 are not.
    { ...REPORT, command: "\u{1F600}".repeat(20001) },
  ]) {
    expect(await hook(tokens.hook, body)).toEqual(invalid);
  }
  expect(await hook(tokens.hook, { ...REPORT, runId: "run-b" })).toEqual(forbidden);
  expect(await hook(tokens.hook, REPORT)).toEqual({ status: 200, body: { ok: true } });
  const edge = { ...REPORT, rule: "r".repeat(200), command: "\u{1F600}".repeat(20000) };
  expect(await hook(tokens.hook, edge)).toEqual({ status: 200, body: { ok: true } });

  const server = await lazy.get();
  const db = new Database(join(server.home, "harness.db"), { readonly: true });
  try {
    const events = db
      .query<{ run_id: string; command: string; guard_verdict: string; guard_rule: string }, []>(
        "SELECT run_id, command, guard_verdict, guard_rule FROM events WHERE kind = 'guard' AND source = 'hook' ORDER BY ts, id",
      )
      .all();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      run_id: "run-a",
      command: "git push origin main",
      guard_verdict: "deny",
      guard_rule: "git.push",
    });
  } finally {
    db.close();
  }
});
