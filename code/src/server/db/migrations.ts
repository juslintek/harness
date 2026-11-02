import type { Migration } from "./db";
import instance from "./migrations/001_instance.sql" with { type: "text" };
import logs from "./migrations/002_logs.sql" with { type: "text" };
import agents from "./migrations/003_agents.sql" with { type: "text" };
import mcp from "./migrations/004_mcp.sql" with { type: "text" };
import usage from "./migrations/005_usage.sql" with { type: "text" };
import runs from "./migrations/006_runs.sql" with { type: "text" };
import runPid from "./migrations/007_run_pid.sql" with { type: "text" };

export const migrations: readonly Migration[] = [
  { version: 1, sql: instance },
  { version: 2, sql: logs },
  { version: 3, sql: agents },
  { version: 4, sql: mcp },
  { version: 5, sql: usage },
  { version: 6, sql: runs },
  { version: 7, sql: runPid },
];
