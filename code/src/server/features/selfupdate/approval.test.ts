import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { until, withActor } from "../../test-support/app-kit";
import { branchWith, makeHome, makeRepo, script, tempDir } from "../../test-support/selfupdate-kit";
import { type PipelineDeps, runPipeline } from "./pipeline";
import { createRequest, getRequest, type UpdateRequest } from "./requests";
import { pipelineRoutes } from "./routes";
import { resolveCommit } from "./steps";

setDefaultTimeout(30_000);

const GUARD_FILE = "code/src/server/features/guard/x.ts";
const post = (path: string): [string, RequestInit] => [path, { method: "POST" }];

let repo = "";
let marks = "";
let home = "";
let db: ReturnType<typeof makeHome>["db"];
let deps: PipelineDeps;

function stepsDeps(build: PipelineDeps["steps"]["build"]): PipelineDeps {
  return {
    home,
    port: 1,
    pid: process.pid,
    liveBinary: "/bin/true",
    verifyMs: 5000,
    beginShutdown: () => {},
    steps: {
      install: ["true"],
      check: ["sh", "-c", `touch "${marks}/checked"`],
      build,
      expectedVersion: "2.0.0",
    },
  };
}

const failingBuild = (): string[] => ["sh", "-c", `touch "${marks}/built"; exit 1`];

async function open(branch: string): Promise<UpdateRequest> {
  const commitSha = await resolveCommit(repo, branch);
  return createRequest(db, { repo, branch, commitSha, createdBy: "u1" });
}

const api = (session: { instanceAdmin?: boolean; stepUpAt?: number | null } = {}) =>
  withActor(pipelineRoutes(db, deps), session);

beforeEach(async () => {
  repo = await makeRepo("1.0.0");
  marks = tempDir("marks");
  ({ home, db } = makeHome());
  deps = stepsDeps(failingBuild);
  await branchWith(repo, "guarded", { [GUARD_FILE]: "export {};\n" });
  await branchWith(repo, "plain", { "code/src/server/features/board/x.ts": "export {};\n" });
});

test("a flagged request stops at awaiting_approval and runs no step", async () => {
  const req = await open("guarded");
  await runPipeline(db, req.id, deps);
  const after = getRequest(db, req.id);
  expect(after?.status).toBe("awaiting_approval");
  expect(after?.flaggedPaths).toEqual([GUARD_FILE]);
  expect(after?.commitSha).toBe(req.commitSha);
  expect(existsSync(join(marks, "checked"))).toBe(false);
  expect(existsSync(join(marks, "built"))).toBe(false);
});

test("an unflagged request goes through without a human", async () => {
  const req = await open("plain");
  await runPipeline(db, req.id, deps);
  expect(existsSync(join(marks, "built"))).toBe(true);
  expect(getRequest(db, req.id)?.decidedBy).toBeNull();
});

test("review shows the flagged paths, the diff stat and the pinned sha", async () => {
  const req = await open("guarded");
  await runPipeline(db, req.id, deps);
  const res = await api().request(`/requests/${req.id}/review`);
  const body = (await res.json()) as { flagged: string[]; stat: string; commitSha: string };
  expect(body.flagged).toEqual([GUARD_FILE]);
  expect(body.stat).toContain("guard/x.ts");
  expect(body.commitSha).toBe(req.commitSha);
});

test("approve needs a fresh step-up and an instance admin", async () => {
  const req = await open("guarded");
  await runPipeline(db, req.id, deps);
  const path = `/requests/${req.id}/approve`;
  expect((await api({ stepUpAt: null }).request(...post(path))).status).toBe(403);
  expect((await api({ stepUpAt: Date.now() - 6 * 60_000 }).request(...post(path))).status).toBe(
    403,
  );
  expect((await api({ instanceAdmin: false }).request(...post(path))).status).toBe(403);
  expect((await api({ instanceAdmin: false }).request(`/requests/${req.id}/review`)).status).toBe(
    403,
  );
  expect(getRequest(db, req.id)?.status).toBe("awaiting_approval");
});

test("approve queues the request and the pipeline then continues", async () => {
  const req = await open("guarded");
  await runPipeline(db, req.id, deps);
  const res = await api().request(...post(`/requests/${req.id}/approve`));
  expect(res.status).toBe(202);
  const body = (await res.json()) as UpdateRequest;
  expect(body).toMatchObject({ status: "queued", decidedBy: "u1" });
  expect(body.decidedAt).not.toBeNull();
  await until(() => getRequest(db, req.id)?.status === "failed");
  expect(existsSync(join(marks, "checked"))).toBe(true);
  expect(existsSync(join(marks, "built"))).toBe(true);
});

test("approve is refused with 409 when the branch moved, and nothing changes", async () => {
  const req = await open("guarded");
  await runPipeline(db, req.id, deps);
  await branchWith(repo, "guarded", { "code/src/server/features/guard/y.ts": "export {};\n" });
  const res = await api().request(...post(`/requests/${req.id}/approve`));
  expect(res.status).toBe(409);
  const after = getRequest(db, req.id);
  expect(after?.status).toBe("awaiting_approval");
  expect(after?.decidedBy).toBeNull();
});

test("deny is final", async () => {
  const req = await open("guarded");
  await runPipeline(db, req.id, deps);
  const denied = await api().request(...post(`/requests/${req.id}/deny`));
  expect(denied.status).toBe(200);
  expect(getRequest(db, req.id)).toMatchObject({ status: "denied", decidedBy: "u1" });
  expect((await api().request(...post(`/requests/${req.id}/approve`))).status).toBe(409);
  expect((await api().request(...post(`/requests/${req.id}/deny`))).status).toBe(409);
  expect((await api({ stepUpAt: null }).request(...post(`/requests/${req.id}/deny`))).status).toBe(
    403,
  );
});

test("approve and deny of an unknown id are 404, and a queued request cannot be approved", async () => {
  expect((await api().request(...post("/requests/nope/approve"))).status).toBe(404);
  expect((await api().request(...post("/requests/nope/deny"))).status).toBe(404);
  const req = await open("plain");
  expect((await api().request(...post(`/requests/${req.id}/approve`))).status).toBe(409);
});

function healthyBinary(): string {
  const js = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, version: "2.0.0" }) }); console.log("listening on http://127.0.0.1:" + s.port);`;
  return script(tempDir("healthy"), "harness-healthy", `exec ${process.execPath} -e '${js}'`);
}

test("a changed pinned sha is failed right before the swap", async () => {
  const req = await open("plain");
  const other = await resolveCommit(repo, "guarded");
  const binary = healthyBinary();
  deps = stepsDeps(() => {
    db.query("UPDATE update_requests SET commit_sha = ? WHERE id = ?").run(other, req.id);
    return ["echo", binary];
  });
  await runPipeline(db, req.id, deps);
  expect(getRequest(db, req.id)).toMatchObject({ status: "failed" });
  expect(getRequest(db, req.id)?.reason).toContain("pinned commit changed");
  expect(existsSync(join(home, "bin", "current"))).toBe(false);
});

test("the diff is classified again before the swap and an unapproved guard change fails", async () => {
  // The request is clean while main already contains the change; main then moves back, so the
  // same commit now differs from the default branch in a guard path.
  const guarded = await resolveCommit(repo, "guarded");
  const initial = await resolveCommit(repo, "main");
  Bun.spawnSync(["git", "update-ref", "refs/heads/main", guarded], { cwd: repo });
  const req = createRequest(db, { repo, branch: "guarded", commitSha: guarded, createdBy: "u1" });
  const binary = healthyBinary();
  deps = stepsDeps(() => {
    Bun.spawnSync(["git", "update-ref", "refs/heads/main", initial], { cwd: repo });
    return ["echo", binary];
  });
  await runPipeline(db, req.id, deps);
  expect(getRequest(db, req.id)).toMatchObject({ status: "failed" });
  expect(getRequest(db, req.id)?.reason).toContain("without approval");
  expect(existsSync(join(home, "bin", "current"))).toBe(false);
});
