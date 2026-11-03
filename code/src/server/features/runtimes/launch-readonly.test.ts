import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { RunOutcome } from "./adapter";
import { getRun, startRun, waitForRun } from "./api";
import { cleanup, fakeDeps, fixture } from "./manager-kit";

afterAll(cleanup);

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

test("an interview run's srt settings grant no write to its worktree or to git state", async () => {
  const x = fixture();
  const lane = async (): Promise<RunOutcome> => done;
  const id = await startRun(x.db, fakeDeps(x, [], { lane }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "answer",
    candidate: { candidateId: "c1", orgId: "o1", chargedTo: null },
  });
  await waitForRun(id);
  const run = getRun(x.db, id);
  const settings: { filesystem: { allowWrite: string[] } } = await Bun.file(
    join(x.home, "runs", id, "srt.json"),
  ).json();
  const writable = settings.filesystem.allowWrite;
  expect(run?.worktree).toBeTruthy();
  expect(writable.filter((p) => p.startsWith(run?.worktree as string))).toEqual([]);
  expect(writable.filter((p) => p.includes(".git"))).toEqual([]);
  expect(writable).toHaveLength(1);
  expect(writable[0]).toEndWith(join("runs", id, "tmp"));
});
