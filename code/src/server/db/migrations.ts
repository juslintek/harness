import type { Migration } from "./db";
import instance from "./migrations/001_instance.sql" with { type: "text" };
import logs from "./migrations/002_logs.sql" with { type: "text" };
import agents from "./migrations/003_agents.sql" with { type: "text" };
import mcp from "./migrations/004_mcp.sql" with { type: "text" };
import usage from "./migrations/005_usage.sql" with { type: "text" };
import runs from "./migrations/006_runs.sql" with { type: "text" };
import runPid from "./migrations/007_run_pid.sql" with { type: "text" };
import runPidIdentity from "./migrations/008_run_pid_identity.sql" with { type: "text" };
import auth from "./migrations/009_auth.sql" with { type: "text" };
import orgs from "./migrations/010_orgs.sql" with { type: "text" };
import board from "./migrations/011_board.sql" with { type: "text" };
import chat from "./migrations/012_chat.sql" with { type: "text" };
import wake from "./migrations/013_wake.sql" with { type: "text" };
import identity from "./migrations/014_identity.sql" with { type: "text" };
import wakeSubtask from "./migrations/015_wake_subtask.sql" with { type: "text" };

export const migrations: readonly Migration[] = [
  { version: 1, sql: instance },
  { version: 2, sql: logs },
  { version: 3, sql: agents },
  { version: 4, sql: mcp },
  { version: 5, sql: usage },
  { version: 6, sql: runs },
  { version: 7, sql: runPid },
  { version: 8, sql: runPidIdentity },
  { version: 9, sql: auth },
  { version: 10, sql: orgs },
  { version: 11, sql: board },
  { version: 12, sql: chat },
  { version: 13, sql: wake },
  { version: 14, sql: identity },
  { version: 15, sql: wakeSubtask },
];
