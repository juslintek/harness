import { afterAll, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
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

// Read-only git classification assumes git never runs a pager or external diff driver; hooks and
// config stay unwritable so the agent cannot plant one, and the env overrides a configured pager.
test("a normal run cannot write the main repo's git config or hooks and gets no git pager", async () => {
  const x = fixture();
  const seen: { env: Record<string, string> } = { env: {} };
  const lane = async (ctx: { env: Record<string, string> }): Promise<RunOutcome> => {
    seen.env = ctx.env;
    return done;
  };
  const id = await startRun(x.db, fakeDeps(x, [], { lane }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "go",
  });
  await waitForRun(id);
  const settings: { filesystem: { allowWrite: string[]; denyWrite: string[] } } = await Bun.file(
    join(x.home, "runs", id, "srt.json"),
  ).json();
  const common = (await realpath(join(x.repo, ".git"))).toString();
  expect(settings.filesystem.denyWrite).toEqual(
    expect.arrayContaining([join(common, "config"), join(common, "hooks")]),
  );
  expect(settings.filesystem.allowWrite).not.toContain(common);
  expect(seen.env.GIT_PAGER).toBe("cat");
  expect(seen.env.PAGER).toBe("cat");
});
