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
import profiles from "./migrations/016_profiles.sql" with { type: "text" };
import policies from "./migrations/017_policies.sql" with { type: "text" };
import triageRegistry from "./migrations/018_triage_registry.sql" with { type: "text" };
import hiring from "./migrations/019_hiring.sql" with { type: "text" };
import router from "./migrations/020_router.sql" with { type: "text" };
import budgets from "./migrations/021_budgets.sql" with { type: "text" };
import tracking from "./migrations/022_tracking.sql" with { type: "text" };
import wakeReasons from "./migrations/023_wake_reasons.sql" with { type: "text" };

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
  { version: 16, sql: profiles },
  { version: 17, sql: policies },
  { version: 18, sql: triageRegistry },
  { version: 19, sql: hiring },
  { version: 20, sql: router },
  { version: 21, sql: budgets },
  { version: 22, sql: tracking },
  { version: 23, sql: wakeReasons },
];
