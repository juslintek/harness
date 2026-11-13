import { expect, test } from "bun:test";
import { z } from "zod";
import { taskViewSchema } from "../../../shared/board";
import type { MessageView } from "../../../shared/chat";
import { bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { ensureProjectChannel } from "../chat/api";
import { createProject } from "../orgs/api";
import { parseData } from "./apply";
import { specOf } from "./schema";

// Rows are changed with plain SQL, as an apply without the federation checks would store them.
// Each case shows that a value SQLite accepts breaks a real reader, which is why apply refuses it.
async function world() {
  const k = bootApi();
  const owner = await k.user();
  const org = k.org(owner, "acme");
  const project = createProject(k.db, { orgId: org.id, key: "web", name: "Web" });
  const channel = ensureProjectChannel(k.db, project.id);
  const add = (title: string) =>
    createTask(k.db, { projectId: project.id, title, createdBy: org.owner.id });
  const renumber = (id: string, number: number): void => {
    k.db.run("UPDATE tasks SET number = ? WHERE id = ?", [number, id]);
  };
  const mention = async (number: number): Promise<string[]> => {
    const res = await k.call(owner, "POST", `/api/channels/${channel.id}/messages`, {
      body: `see #${number}`,
    });
    return ((await res.json()) as MessageView).taskIds;
  };
  return { k, owner, project, add, renumber, mention };
}

test("a task list with one rank of 1e999 is served with a null the board cannot parse", async () => {
  const { k, owner, project, add } = await world();
  const stored = add("t");
  const board = `/api/projects/${project.id}/tasks`;
  const tasksOf = z.array(taskViewSchema);
  expect(tasksOf.safeParse(await (await k.call(owner, "GET", board)).json()).success).toBe(true);
  k.db.run("UPDATE tasks SET rank = '1e999' WHERE id = ?", [stored.id]);
  const res = await k.call(owner, "GET", board);
  expect(res.status).toBe(200);
  const listed: { rank: number | null }[] = await res.json();
  expect(listed[0]?.rank).toBeNull();
  expect(tasksOf.safeParse(listed).success).toBe(false);
});

test("a task number of 2 ** 62 gives the next tasks of the org that same number in JSON", async () => {
  const { add, renumber } = await world();
  renumber(add("first").id, 2 ** 62);
  expect(add("second").number).toBe(2 ** 62);
  expect(add("third").number).toBe(2 ** 62);
});

// The chat and the board both read `#` and at most 9 digits as a task link.
test("a task numbered past 9 digits cannot be linked from chat, a numbered 1 can", async () => {
  const { add, renumber, mention } = await world();
  const first = add("first");
  expect(await mention(first.number)).toEqual([first.id]);
  renumber(first.id, 1_000_000_000);
  expect(await mention(add("next").number)).toEqual([]);
});

// Rows the local writer produces are what an honest peer sends, and the check has to let them through.
test("tasks made and moved between neighbours through the board pass the federation check", async () => {
  const { k, owner, add } = await world();
  const spec = specOf("tasks");
  if (!spec) throw new Error("no tasks table");
  const [one, , three] = [add("one"), add("two"), add("three")];
  const move = { to: "todo", beforeId: one?.id };
  expect((await k.call(owner, "POST", `/api/tasks/${three?.id}/move`, move)).status).toBe(200);
  const rows = k.db.query(`SELECT ${spec.columns.join(", ")} FROM tasks`).all();
  expect(rows).toHaveLength(3);
  for (const row of rows as { id: string }[]) {
    const change = {
      project_id: "p",
      table_name: "tasks",
      row_id: row.id,
      op: "put" as const,
      hlc: "h",
      origin_instance: "i",
      data: JSON.stringify(row),
    };
    expect(parseData(spec, change)).not.toBeNull();
  }
});
