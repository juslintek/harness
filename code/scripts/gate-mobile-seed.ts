import { createEnrollment } from "../src/server/features/auth/api";
import { enrollAdmin, type Instance, stepUp } from "./gate-5-kit";

export interface SeededState {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectKey: string;
  channelId: string;
  approvalId: string;
  activeRunId: string;
  completedRunId: string;
  iosEnrollCode: string;
  androidEnrollCode: string;
  iosPairCode: string;
  androidPairCode: string;
  androidPairCodeDark: string;
  adminCookie: string;
  adminUserId: string;
}

async function apiJson<T>(
  inst: Instance,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<T> {
  const res = await inst.client.call(method, path, {
    cookie,
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function seedBoard(inst: Instance, projectId: string, cookie: string): Promise<string[]> {
  const specs: Array<[string, string, string]> = [
    ["done", "Design onboarding flow", "Finalized QR pairing and enrollment screens."],
    ["in_review", "Implement P-256 device key signer", "Hardware-backed ECDSA P-256 signing."],
    ["in_progress", "Wire push relay notifications", "Subscribe APNs/FCM tokens."],
    ["todo", "Verify offline approval banner", "Show expiry countdown for Guard approvals."],
    ["backlog", "Audit multi-instance switcher", "Switch between Tailscale and local dev."],
  ];

  const taskIds: string[] = [];
  for (const [status, title, description] of specs) {
    const created = await apiJson<{ id: string }>(
      inst,
      "POST",
      `/api/projects/${projectId}/tasks`,
      cookie,
      { title, description, status },
    );
    taskIds.push(created.id);
  }
  await apiJson(inst, "POST", `/api/tasks/${taskIds[2]}/deps`, cookie, { dependsOn: taskIds[1] });
  return taskIds;
}

const EVENT_SQL = `INSERT INTO events (id, ts, run_id, task_id, agent, kind, gen_ai_operation_name, gen_ai_tool_name, command, exit_code, duration_ms, guard_layer, guard_verdict, guard_rule, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gate-seed')`;

interface SeedEvent {
  ts: number;
  runId: string;
  taskId?: string | undefined;
  agent: string;
  kind: string;
  op?: string;
  tool?: string;
  cmd?: string;
  exit?: number;
  ms: number;
  layer?: string;
  verdict?: string;
  rule?: string;
}

function insertSeedEvent(stmt: ReturnType<Instance["db"]["prepare"]>, e: SeedEvent): void {
  stmt.run(
    Bun.randomUUIDv7(),
    e.ts,
    e.runId,
    e.taskId ?? null,
    e.agent,
    e.kind,
    e.op ?? null,
    e.tool ?? null,
    e.cmd ?? null,
    e.exit ?? null,
    e.ms,
    e.layer ?? null,
    e.verdict ?? null,
    e.rule ?? null,
  );
}

function seedRunEvents(
  inst: Instance,
  activeRunId: string,
  completedRunId: string,
  taskIds: string[],
  now: number,
): void {
  const stmt = inst.db.prepare(EVENT_SQL);
  const items: SeedEvent[] = [
    {
      ts: now - 70_000,
      runId: activeRunId,
      taskId: taskIds[2],
      agent: "claude",
      kind: "tool_call",
      op: "execute_tool",
      tool: "read_file",
      ms: 42,
    },
    {
      ts: now - 50_000,
      runId: activeRunId,
      taskId: taskIds[2],
      agent: "claude",
      kind: "command",
      cmd: "bun test tools/push-relay/relay.test.ts",
      exit: 0,
      ms: 610,
    },
    {
      ts: now - 20_000,
      runId: activeRunId,
      taskId: taskIds[2],
      agent: "claude",
      kind: "guard",
      cmd: "curl -X POST https://api.push.apple.com/3/device/test",
      ms: 12,
      layer: "l2",
      verdict: "ask",
      rule: "external-network-egress",
    },
    {
      ts: now - 200_000,
      runId: completedRunId,
      taskId: taskIds[1],
      agent: "codex",
      kind: "command",
      cmd: "swift test --filter DeviceKeySignerTests",
      exit: 0,
      ms: 1420,
    },
  ];
  for (const item of items) insertSeedEvent(stmt, item);
}

function seedRunsAndApproval(
  inst: Instance,
  orgId: string,
  projectId: string,
  taskIds: string[],
): { activeRunId: string; completedRunId: string; approvalId: string } {
  const now = Date.now();
  const activeRunId = Bun.randomUUIDv7();
  const completedRunId = Bun.randomUUIDv7();
  const approvalId = Bun.randomUUIDv7();

  inst.db.run(
    `INSERT INTO runs (id, task_id, project_id, org_id, agent_id, model, repo, branch, prompt, state, created_at, started_at)
     VALUES (?, ?, ?, ?, 'claude', 'claude-sonnet-4-6', '/tmp/mobile-app', 'feat/push-relay', 'Wire push relay endpoints and tests', 'running', ?, ?)`,
    [activeRunId, taskIds[2] ?? null, projectId, orgId, now - 90_000, now - 85_000],
  );
  inst.db.run(
    `INSERT INTO runs (id, task_id, project_id, org_id, agent_id, model, repo, branch, prompt, state, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'codex', 'gpt-5-codex', '/tmp/mobile-app', 'feat/device-signer', 'Implement P-256 SPKI signer', 'completed', ?, ?, ?)`,
    [
      completedRunId,
      taskIds[1] ?? null,
      projectId,
      orgId,
      now - 300_000,
      now - 295_000,
      now - 180_000,
    ],
  );
  seedRunEvents(inst, activeRunId, completedRunId, taskIds, now);
  inst.db.run(
    `INSERT INTO approvals (id, run_id, action, l1, l2, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'Host api.push.apple.com is outside local sandbox allowlist', 'pending', ?, ?)`,
    [
      approvalId,
      activeRunId,
      JSON.stringify({ command: "Allow outbound APNs push relay test request" }),
      JSON.stringify({ reason: "Host api.push.apple.com is outside local sandbox allowlist" }),
      now - 15_000,
      now + 600_000,
    ],
  );
  return { activeRunId, completedRunId, approvalId };
}

async function seedChatAndMemory(
  inst: Instance,
  orgSlug: string,
  projectId: string,
  cookie: string,
): Promise<string> {
  const channels = await apiJson<Array<{ id: string; kind: string; projectId?: string | null }>>(
    inst,
    "GET",
    `/api/orgs/${orgSlug}/channels`,
    cookie,
  );
  const channelId =
    channels.find((ch) => ch.kind === "project" && ch.projectId === projectId)?.id ??
    channels[0]?.id ??
    (
      await apiJson<{ id: string }>(inst, "POST", `/api/orgs/${orgSlug}/groups`, cookie, {
        name: "mobile-release",
        memberIds: [],
      })
    ).id;

  const rootMsg = await apiJson<{ id: string }>(
    inst,
    "POST",
    `/api/channels/${channelId}/messages`,
    cookie,
    { body: "Kicked off mobile release checklist for Studio North." },
  );
  await apiJson(inst, "POST", `/api/channels/${channelId}/messages`, cookie, {
    body: "Push relay conformance and Guard approval smoke are seeded.",
    threadRootId: rootMsg.id,
  });

  await apiJson(inst, "POST", `/api/orgs/${orgSlug}/memory/notes`, cookie, {
    scope: "project",
    projectId,
    rel: "mobile-architecture.md",
    type: "decision",
    tags: ["mobile", "security"],
    body: "# Mobile Architecture\n\nAll mobile sessions use P-256 hardware-backed keys for enrollment and step-up.",
  });
  await apiJson(inst, "POST", `/api/orgs/${orgSlug}/memory/notes`, cookie, {
    scope: "org",
    rel: "release-runbook.md",
    type: "howto",
    tags: ["release", "ops"],
    body: "# Release Runbook\n\nRun `bun scripts/gate-mobile.ts` before tagging a mobile release.",
  });
  return channelId;
}

export async function seedMobileGate(inst: Instance): Promise<SeededState> {
  const admin = await enrollAdmin(inst);
  await stepUp(inst, admin.cookie);

  const org = await apiJson<{ id: string; slug: string }>(inst, "POST", "/api/orgs", admin.cookie, {
    slug: "studio-north",
    name: "Studio North",
  });
  const project = await apiJson<{ id: string; key: string }>(
    inst,
    "POST",
    `/api/orgs/${org.slug}/projects`,
    admin.cookie,
    { key: "mobile-app", name: "Mobile App" },
  );

  const taskIds = await seedBoard(inst, project.id, admin.cookie);
  const runs = seedRunsAndApproval(inst, org.id, project.id, taskIds);
  const channelId = await seedChatAndMemory(inst, org.slug, project.id, admin.cookie);

  const pairCode = async (): Promise<string> =>
    (await apiJson<{ code: string }>(inst, "POST", "/api/auth/mobile/pair/start", admin.cookie, {}))
      .code;
  const [iosPairCode, androidPairCode, androidPairCodeDark] = await Promise.all([
    pairCode(),
    pairCode(),
    pairCode(),
  ]);

  return {
    orgId: org.id,
    orgSlug: org.slug,
    projectId: project.id,
    projectKey: project.key,
    channelId,
    ...runs,
    iosEnrollCode: createEnrollment(inst.db, { userId: admin.userId, ttlMs: 600_000 }),
    androidEnrollCode: createEnrollment(inst.db, { userId: admin.userId, ttlMs: 600_000 }),
    iosPairCode,
    androidPairCode,
    androidPairCodeDark,
    adminCookie: admin.cookie,
    adminUserId: admin.userId,
  };
}
