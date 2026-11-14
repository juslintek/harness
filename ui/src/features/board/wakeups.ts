import { z } from "zod";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { type Wakeup, wakeupList } from "../../wakeups";

// What a card says about an agent at work on a task. `waiting` needs the run's pending approval,
// which only instance admins can read; for everyone else it stays false and the card says "working".
export interface Work {
  runId: string | null;
  since: number | null;
  waiting: boolean;
  command: string | null;
}

export const isInstanceAdmin = (): boolean => me()?.user.instanceAdmin === true;

export function createWakeups(slug: string): {
  all: () => Wakeup[];
  of: (taskId: string) => Wakeup[];
  work: (taskId: string) => Work | undefined;
  reload: () => Promise<void>;
} {
  const wakeups = createLoad(`/api/orgs/${slug}/wakeups?limit=200`, wakeupList);
  const pending = isInstanceAdmin()
    ? createLoad(
        "/api/approvals?status=pending",
        z.array(z.object({ runId: z.string(), command: z.string() })),
        ["approvals"],
      )
    : null;
  const all = (): Wakeup[] => wakeups.data() ?? [];
  const of = (taskId: string): Wakeup[] =>
    all()
      .filter((w) => w.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt);
  const work = (taskId: string): Work | undefined => {
    const started = of(taskId).find((w) => w.status === "started");
    if (!started) return undefined;
    const ask = pending?.data()?.find((a) => a.runId === started.runId);
    return {
      runId: started.runId,
      since: started.startedAt,
      waiting: ask !== undefined,
      command: ask?.command ?? null,
    };
  };
  return {
    all,
    of,
    work,
    reload: async () => {
      await Promise.all([wakeups.reload(), pending?.reload()]);
    },
  };
}
