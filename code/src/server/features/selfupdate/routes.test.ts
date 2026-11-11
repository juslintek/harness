import { expect, setDefaultTimeout, test } from "bun:test";
import { withActor } from "../../test-support/app-kit";
import { makeHome, makeRepo } from "../../test-support/selfupdate-kit";
import { createRequest } from "./requests";
import { pipelineRoutes } from "./routes";
import { resolveCommit } from "./steps";

setDefaultTimeout(30_000);

async function app(admin: boolean) {
  const { home, db } = makeHome();
  const repo = await makeRepo("1.0.0");
  const deps = {
    home,
    port: 1,
    pid: process.pid,
    liveBinary: "/bin/true",
    runningCommit: await resolveCommit(repo, "main"),
    verifyMs: 1000,
    beginShutdown: () => {},
    steps: { install: ["sleep", "3"], check: ["false"], build: () => ["false"] },
  };
  return { db, repo, api: withActor(pipelineRoutes(db, deps), { instanceAdmin: admin }) };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("a non-admin gets 403", async () => {
  const { api, repo } = await app(false);
  expect((await api.request("/requests", post({ repo, branch: "main" }))).status).toBe(403);
  expect((await api.request("/requests/x")).status).toBe(403);
});

test("an admin queues a request pinned to the branch commit", async () => {
  const { api, repo } = await app(true);
  const res = await api.request("/requests", post({ repo, branch: "main" }));
  expect(res.status).toBe(202);
  const body = (await res.json()) as { id: string; commitSha: string };
  expect(body.commitSha).toMatch(/^[0-9a-f]{40}$/);
  expect((await api.request(`/requests/${body.id}`)).status).toBe(200);
});

test("an unknown branch is 400 and a second request while one is busy is 409", async () => {
  const { api, repo, db } = await app(true);
  expect((await api.request("/requests", post({ repo, branch: "nope" }))).status).toBe(400);
  expect((await api.request("/requests", post({ repo, branch: "--all" }))).status).toBe(400);
  createRequest(db, { repo, branch: "main", commitSha: "a".repeat(40), createdBy: "u1" });
  expect((await api.request("/requests", post({ repo, branch: "main" }))).status).toBe(409);
});

test("two concurrent requests start one pipeline: one 202, one 409", async () => {
  const { api, repo } = await app(true);
  const codes = (
    await Promise.all([
      api.request("/requests", post({ repo, branch: "main" })),
      api.request("/requests", post({ repo, branch: "main" })),
    ])
  )
    .map((res) => res.status)
    .sort();
  expect(codes).toEqual([202, 409]);
});
