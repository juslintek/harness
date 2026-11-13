import { type TaskView, taskViewSchema } from "@shared/board";
import { hireListSchema } from "@shared/hiring";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { proposalListSchema } from "@shared/policies";
import { type ApprovalView, approvalViewSchema, type RunView, runViewSchema } from "@shared/runs";
import { dashboardViewSchema } from "@shared/tracking";
import { createEffect, createMemo, createSignal } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { canDecideApprovals, me } from "../../auth/me";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { statusWord, type Tone } from "../../ui/atoms";
import { createHalt, useNow } from "../../ui/organisms";
import { type Wakeup, wakeupList } from "../../wakeups";

export interface NeedRow {
  key: string;
  category: string;
  badge: { word: string; tone: Tone };
  title: string;
  line: string;
  action: { label: string; href: string };
}

export interface NowOrg {
  id: string;
  slug: string;
  name: string;
  role: string;
}

const taskList = z.array(taskViewSchema);
const LIVE = new Set(["queued", "starting", "running"]);
const ENDED = new Set(["completed", "failed", "blocked", "cancelled", "killed"]);

const startOfToday = (): number => new Date().setHours(0, 0, 0, 0);

// Everything the Now page shows, loaded once and shared by its blocks. A load a role may not make
// is not made at all, so its block is absent rather than empty.
export function createNowData(org: NowOrg) {
  const current = me();
  const instanceAdmin = current?.user.instanceAdmin === true;
  const manager = org.role === "owner" || org.role === "admin";
  const topic = [`org:${org.id}`];
  const detail = createLoad(`/api/orgs/${org.slug}`, orgDetailSchema, topic);
  // Wakeups are not pushed: the org topic and (for admins) the runs topic only nudge a refetch.
  const wakeups = createLoad(
    `/api/orgs/${org.slug}/wakeups?limit=200`,
    wakeupList,
    instanceAdmin ? [...topic, "runs"] : topic,
  );
  const runs = instanceAdmin ? createLoad("/api/runs", z.array(runViewSchema), ["runs"]) : null;
  const approvals =
    current && canDecideApprovals(current)
      ? createLoad(
          "/api/approvals?status=pending",
          z.array(approvalViewSchema),
          instanceAdmin ? ["approvals"] : [],
        )
      : null;
  const dashboard = createLoad(`/api/orgs/${org.slug}/dashboard`, dashboardViewSchema, topic);
  const hires = manager ? createLoad(`/api/orgs/${org.slug}/hires`, hireListSchema, topic) : null;
  const proposals = manager
    ? createLoad(`/api/orgs/${org.slug}/policy-proposals?status=open`, proposalListSchema, topic)
    : null;
  const passkeys = manager ? createLoad("/api/auth/passkeys", z.array(z.unknown())) : null;
  const targets = manager ? createLoad("/api/notify/targets", z.array(z.unknown())) : null;
  const halt = createHalt();
  const now = useNow();

  // Tasks are listed per project, so blocked ones cost one request for each.
  const [blocked, setBlocked] = createSignal<TaskView[]>([]);
  const loadBlocked = async (): Promise<void> => {
    const projects = detail.data()?.projects ?? [];
    const lists = await Promise.all(
      projects.map((p) => api(`/api/projects/${p.id}/tasks`, taskList).catch(() => [])),
    );
    setBlocked(lists.flat().filter((t) => t.status === "blocked"));
  };
  createEffect(() => {
    detail.data();
    void loadBlocked();
  });
  createTopic(topic[0] as string, (frame) => {
    if (frame !== null) void loadBlocked();
  });

  const members = (): OrgDetail["members"] => detail.data()?.members ?? [];
  const handleOf = (memberId: string | null): string | undefined =>
    members().find((m) => m.id === memberId)?.handle;
  const memberIds = createMemo(() => new Set(members().map((m) => m.id)));
  // A run started from the Runs page has no member and so no organisation (RunView carries no org
  // id): it is shown to instance admins here. A run of any member belongs to that member's org.
  const ownRuns = (): RunView[] =>
    (runs?.data() ?? []).filter((r) => r.memberId === null || memberIds().has(r.memberId));
  const wakeList = (): Wakeup[] => wakeups.data() ?? [];
  // Runs without a member have no wakeup, so a live one gets a stand-in row.
  const memberless = (): Wakeup[] =>
    ownRuns()
      .filter((r) => r.memberId === null && LIVE.has(r.state))
      .map((r) => ({
        id: `run-${r.id}`,
        memberId: "",
        reason: "run_now",
        taskId: null,
        taskNumber: null,
        channelId: null,
        channelName: null,
        causedBy: null,
        status: "started" as const,
        runId: r.id,
        createdAt: r.createdAt,
        startedAt: r.startedAt ?? r.createdAt,
        endedAt: null,
      }));
  const working = (): Wakeup[] =>
    [...wakeList().filter((w) => w.status === "started"), ...memberless()].sort(
      (a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt),
    );
  const agentOf = (w: Wakeup): string =>
    handleOf(w.memberId) ?? runs?.data()?.find((r) => r.id === w.runId)?.agentId ?? "agent";
  const queued = (): Wakeup[] =>
    wakeList()
      .filter((w) => w.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  // An approval belongs here unless its run is known to belong to another organisation.
  const pendingApprovals = () =>
    (approvals?.data() ?? []).filter((a) => {
      const run = runs?.data()?.find((r) => r.id === a.runId);
      return !run || run.memberId === null || memberIds().has(run.memberId);
    });
  const finished = (): RunView[] =>
    ownRuns()
      .filter((r) => ENDED.has(r.state) && (r.endedAt ?? 0) >= startOfToday())
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const myBlocked = (): TaskView[] =>
    manager ? blocked() : blocked().filter((t) => t.assignee?.handle === detail.data()?.me.handle);
  const budgets = () => dashboard.data()?.budgets ?? [];
  const quota = () => dashboard.data()?.quota ?? [];
  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const scopeName = (kind: string, id: string): string =>
    kind === "member"
      ? `@${handleOf(id) ?? "member"}`
      : kind === "team"
        ? (detail.data()?.teams.find((t) => t.id === id)?.name ?? "Team")
        : "The whole org";
  // The page's urgency order after approvals: budgets, hires, rule changes, blocked tasks.
  const needRows = (): NeedRow[] => {
    const home = `#/o/${org.slug}`;
    const rows: NeedRow[] = [];
    if (manager) {
      const byState = (state: string) => budgets().filter((b) => b.state === state);
      for (const b of [...byState("paused"), ...byState("warn")]) {
        const paused = b.state === "paused";
        rows.push({
          key: `budget-${b.id}`,
          category: "Budget",
          badge: statusWord(b.state, "budget"),
          title: `${scopeName(b.scopeKind, b.scopeId)} ${paused ? "is paused" : "is near the limit"}`,
          line: `${usd(b.spentUsd)} of ${usd(b.monthlyUsd)} used this month.${paused ? " Runs for this budget are stopped." : ""}`,
          action: { label: "Open Usage & budgets", href: `${home}/dashboard` },
        });
      }
      for (const h of hires?.data()?.filter((x) => x.status === "deciding") ?? []) {
        rows.push({
          key: `hire-${h.id}`,
          category: "Hiring",
          badge: statusWord("deciding", "hire"),
          title: h.spec.title,
          line: "Interviews are scored. Pick a candidate or reject the request.",
          action: { label: "Open request", href: `${home}/hiring/${h.id}` },
        });
      }
      for (const p of proposals?.data() ?? []) {
        rows.push({
          key: `proposal-${p.id}`,
          category: "Policy",
          badge: { word: "open", tone: "warning" },
          title: `Rule change proposed by @${handleOf(p.proposedBy) ?? "an agent"}`,
          line: `${p.key.replaceAll("_", " ")} would become ${String(p.value)}. "${p.reason}"`,
          action: { label: "Open Policies", href: `${home}/policies` },
        });
      }
    }
    for (const t of myBlocked()) {
      rows.push({
        key: `task-${t.id}`,
        category: "Task",
        badge: { word: "blocked", tone: "danger" },
        title: `#${t.number} ${t.title}`,
        line: `${t.assignee ? `Assigned to @${t.assignee.handle}. ` : ""}It is blocked and no agent will pick it up until someone unblocks it.`,
        action: { label: "Open task", href: `${home}/board/${t.projectId}/${t.number}` },
      });
    }
    return rows;
  };
  // A decided approval stays until the page is left, so the result of the decision has a place.
  const [kept, setKept] = createSignal<ApprovalView[]>([]);
  const approvalRows = (): ApprovalView[] => {
    const rows = new Map(
      pendingApprovals()
        .filter((a) => a.expiresAt > now())
        .map((a) => [a.id, a]),
    );
    for (const a of kept()) if (!rows.has(a.id)) rows.set(a.id, a);
    return [...rows.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  };
  const needsCount = (): number => approvalRows().length + needRows().length;
  const failedToday = (): number => finished().filter((r) => r.state === "failed").length;
  const running = (): number => ownRuns().filter((r) => LIVE.has(r.state)).length;

  return {
    instanceAdmin,
    manager,
    detail,
    wakeups,
    runs,
    approvals,
    hires,
    proposals,
    passkeys,
    targets,
    dashboard,
    halted: () => halt.halted() === true,
    handleOf,
    agentOf,
    working,
    queued,
    pendingApprovals,
    finished,
    myBlocked,
    needRows,
    scopeName,
    approvalRows,
    needsCount,
    keep: (a: ApprovalView) => setKept([...kept(), a]),
    budgets,
    quota,
    failedToday,
    running,
    reload: async (): Promise<void> => {
      await Promise.all([approvals?.reload(), wakeups.reload(), runs?.reload()]);
    },
  };
}
export type NowData = ReturnType<typeof createNowData>;
