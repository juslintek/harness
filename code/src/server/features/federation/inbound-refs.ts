import type { Row } from "./schema";

// The columns that say which project a row belongs to. A number or a missing value there is
// refused, not read as "no claim".
const PROJECT_REFS: Record<string, string[]> = {
  tasks: ["project_id"],
  channels: ["project_id"],
  notes: ["project_id"],
  grants: ["project_id"],
  comments: ["task_id"],
  messages: ["channel_id"],
  task_deps: ["task_id", "depends_on"],
};

export const refsAreStrings = (table: string, row: Row): boolean =>
  (PROJECT_REFS[table] ?? []).every((col) => typeof row[col] === "string");
