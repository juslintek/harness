import "../../test-support/no-git-env";
import { afterEach, expect, test } from "bun:test";
import { removeMember } from "../orgs/api";
import { searchNotes } from "./index-search";
import { proposeLessons } from "./lessons";
import { decideLesson } from "./lessons-decide";
import { close, GOOD, type World, world } from "./lessons-test-kit";
import { agentViewer } from "./viewer";

let w: World;
afterEach(async () => {
  await close(w);
});

const asAgent = (memberId: string) => ({ memberId, userId: null });

async function pending() {
  const dev = w.agent("dev");
  const task = w.doneTask(dev);
  const lessons = await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: task.id }, [
    GOOD,
  ]);
  return { dev, lessons };
}

test("a removed author's org and project lessons are written under the reviewer, sourced to the stored handle", async () => {
  for (const scope of ["org", "project"]) {
    w = world();
    const { dev, lessons } = await pending();
    w.db.query("UPDATE lessons SET scope = ? WHERE id = ?").run(scope, lessons[0]?.id as string);
    removeMember(w.db, dev.id);
    const lead = w.agent("lead");
    const out = await decideLesson(
      w.db,
      w.home,
      lessons[0]?.id as string,
      asAgent(lead.id),
      "accept",
      "ok",
    );
    const hit = searchNotes(w.db, agentViewer(w.db, lead.id), { type: "lesson" }).find(
      (n) => n.id === out.noteId,
    );
    expect(hit).toMatchObject({ sourceAgent: "dev", scope });
    await close(w);
  }
});
