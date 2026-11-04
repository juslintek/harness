import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { loc } from "./index-test-kit";
import { createNote, readNote } from "./store";
import { aliceA, bobB, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { readNoteFile } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

test("the note view says whether this viewer may edit it, agent notes of their own org included", async () => {
  const human = { ...aliceA, memberId: null };
  const org = (await createNote(env.db, env.dir, ctx(aliceA), orgNote, "# Deploy\nsteps")).note;
  const agentNote = (
    await createNote(env.db, env.dir, ctx(aliceA), loc("orgs/A/agents/m1/mine.md"), "# Mine\nx")
  ).note;
  expect(org.canWrite).toBe(true);
  expect(readNote(env.db, env.dir, human, agentNote.id).canWrite).toBe(true);
  expect(readNote(env.db, env.dir, { ...human, canWrite: false }, org.id).canWrite).toBe(false);
  expect(() => readNote(env.db, env.dir, bobB, org.id)).toThrow();
});

test("a member demoted while the classifier runs gets forbidden and no file is written", async () => {
  let live: typeof aliceA | null = aliceA;
  const c = {
    ...ctx(aliceA),
    refreshViewer: () => live,
    classify: async () => {
      live = { ...aliceA, canWrite: false };
      return { type: "fact" as const, scope: "org" as const, confidence: 0.9 };
    },
  };
  await expect(createNote(env.db, env.dir, c, orgNote, "# Deploy\nsteps")).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(readNoteFile(env.dir, orgNote.disk)).toBeNull();
  live = null;
  c.classify = async () => ({ type: "fact", scope: "org", confidence: 0.9 });
  await expect(createNote(env.db, env.dir, c, orgNote, "# Deploy\nsteps")).rejects.toMatchObject({
    code: "forbidden",
  });
});
