import type { Database } from "bun:sqlite";
import { checkAction, type Scope } from "../guard/api";
import type { NewEvent } from "../logs/api";
import type { PermissionAsk } from "./adapter";
import type { RunDeps } from "./launch";
import type { Live } from "./shutdown";

interface DecideInput {
  db: Database;
  deps: RunDeps;
  input: { id: string; prompt: string };
  scope: Scope;
  run: Live;
  base: Pick<NewEvent, "runId" | "agent" | "taskId">;
  ask: PermissionAsk;
  emit: (e: NewEvent) => void;
}

export async function decideAsk(i: DecideInput): Promise<"allow" | "deny"> {
  const { db, deps, input, run, base, emit } = i;
  try {
    const out = await checkAction(
      db,
      { id: input.id, prompt: input.prompt, scope: i.scope },
      i.ask,
      {
        ...(deps.approvalTimeoutMs === undefined
          ? {}
          : { approvalTimeoutMs: deps.approvalTimeoutMs }),
        onApprovalPending: (approvalId) =>
          emit({ ...base, kind: "approval", body: `pending ${approvalId}` }),
      },
    );
    if (out.verdict === "deny") run.denied = true;
    return out.verdict;
  } catch (err) {
    // A guard that cannot decide must not let the action through.
    run.denied = true;
    emit({ ...base, kind: "error", body: `guard failed: ${String(err)}` });
    return "deny";
  }
}
