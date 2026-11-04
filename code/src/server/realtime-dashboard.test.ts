import { afterAll, expect, test } from "bun:test";
import type { WsMessage } from "../shared/realtime";
import { addAgentMember, createOrg } from "./features/orgs/api";
import type { RunOutcome } from "./features/runtimes/adapter";
import { startRun, waitForRun } from "./features/runtimes/api";
import { cleanup, fakeDeps, fixture } from "./features/runtimes/manager-kit";
import { recordQuota, recordUsage } from "./features/usage/api";
import { wireDashboardNudges } from "./realtime-dashboard";

afterAll(cleanup);

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

test("a member run ending, usage and a quota snapshot nudge the dashboard topics", async () => {
  const x = fixture();
  const org = createOrg(x.db, {
    name: "A",
    slug: "acme",
    ownerUserId: "u",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const bot = addAgentMember(x.db, org.id, {
    agentId: "fake",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  });
  const sent: { topic: string; message: WsMessage }[] = [];
  const off = wireDashboardNudges(
    x.db,
    (topic, message) => sent.push({ topic, message }),
    () => [`org:${org.id}`],
  );
  const id = await startRun(x.db, fakeDeps(x, [], { lane: async () => done }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "go",
    member: { memberId: bot.id, orgId: org.id, scopes: ["report"] },
  });
  await waitForRun(id);
  // The end can publish more than one run event; a repeat only costs the client a refetch.
  expect(new Set(sent.map((s) => s.topic))).toEqual(new Set([`org:${org.id}`]));
  expect(sent.every((s) => s.message.type === "dashboard")).toBe(true);
  sent.length = 0;
  recordUsage(x.db, { id, agent: "fake" }, [
    {
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: null,
      source: "acp",
    },
  ]);
  expect(sent.map((s) => s.topic)).toEqual([`org:${org.id}`]);
  sent.length = 0;
  recordQuota(x.db, {
    provider: "codex",
    window: "5h",
    usedPercent: 40,
    resetsAt: null,
    source: "tail",
  });
  expect(sent.map((s) => s.topic)).toEqual([`org:${org.id}`]);
  off();
});
