import type { LessonView, NoteSummary, NoteView, NoteWriteFeedItem } from "../src/shared/memory";
import type { WsMessage } from "../src/shared/realtime";
import type { DashboardView } from "../src/shared/tracking";
import {
  approvalsFixture,
  channelItem,
  meFixture,
  messageItem,
  runDetailFixture,
  taskItem,
} from "./dump-mobile-data-a";

const noteItem: NoteSummary = {
  id: "not_019318894978701388bb69b7f5256040",
  path: "architecture/mobile-auth.md",
  scope: "org",
  orgId: meFixture.orgs[0]?.id ?? "org_019318894978701388bb69b7f5256003",
  projectId: null,
  memberId: meFixture.user.id,
  type: "decision",
  title: "Mobile Device Authentication",
  tags: ["mobile", "auth", "p256"],
  sourceAgent: "claude-code",
  confidence: 1,
  created: "2026-11-13T10:00:00.000Z",
  updated: "2026-11-13T10:00:00.000Z",
  hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

const noteWriteItem: NoteWriteFeedItem = {
  id: "wrt_019318894978701388bb69b7f5256041",
  noteId: noteItem.id,
  path: noteItem.path,
  op: "create",
  actor: "alice",
  runId: runDetailFixture.run.id,
  at: 1700000000000,
  beforeHash: null,
  afterHash: noteItem.hash,
  before: null,
  after: "# Mobile Device Authentication\n\nP-256 IEEE P1363 signatures.",
  canRevert: false,
};

const lessonItem: LessonView = {
  id: "lsn_019318894978701388bb69b7f5256042",
  taskId: taskItem.id,
  orgId: meFixture.orgs[0]?.id ?? "org_019318894978701388bb69b7f5256003",
  projectId: null,
  authorId: meFixture.user.id,
  authorHandle: "alice",
  body: "Always verify P-256 signature length is exactly 64 bytes IEEE P1363",
  scope: "org",
  type: "lesson",
  status: "accepted",
  reviewerId: meFixture.user.id,
  reason: "Valid mobile security rule",
  noteId: noteItem.id,
  createdAt: 1700000000000,
  decidedAt: 1700000010000,
  task: { number: 1, projectId: taskItem.projectId, title: taskItem.title },
};

export interface MemoryFixture {
  facets: {
    scopes: Record<string, number>;
    types: Record<string, number>;
    tags: Record<string, number>;
    sources: Record<string, number>;
  };
  notes: NoteSummary[];
  note: NoteView;
  conflict409: { error: "conflict"; hash: string };
  writes: NoteWriteFeedItem[];
  lessons: LessonView[];
}

export const memoryFixture: MemoryFixture = {
  facets: {
    scopes: { global: 2, org: 5 },
    types: { decision: 3, lesson: 4 },
    tags: { mobile: 2, auth: 2 },
    sources: { "claude-code": 5 },
  },
  notes: [noteItem],
  note: { ...noteItem, body: noteWriteItem.after ?? "", canWrite: true },
  conflict409: { error: "conflict", hash: noteItem.hash },
  writes: [noteWriteItem],
  lessons: [lessonItem],
};

export const dashboardFixture: DashboardView = {
  members: [
    {
      memberId: meFixture.user.id,
      handle: "alice",
      runs: 10,
      completed: 9,
      inputTokens: 50000,
      outputTokens: 12000,
      cacheReadTokens: 4000,
      costUsd: 0.45,
      costEstimated: false,
      unpricedEvents: 0,
      wallMs: 600000,
      activeMs: 450000,
      waitingMs: 150000,
      plannerMinutes: 5,
      reviewerMinutes: 2,
      tasksDone: 3,
      tools: [{ name: "bash", count: 24 }],
      stack: ["bun", "typescript"],
    },
  ],
  budgets: [],
  quota: [
    {
      provider: "anthropic",
      window: "hourly",
      usedPercent: 42.5,
      resetsAt: 1700003600000,
      source: "api_headers",
      ts: 1700000000000,
    },
  ],
  tasks: [
    {
      number: 1,
      title: "Setup Mobile Fixtures",
      status: "in_progress",
      assignee: "alice",
      plannerMinutes: 5,
      reviewerMinutes: 2,
      agentActiveMinutes: 10,
    },
  ],
};

export const wsFramesFixture: WsMessage[] = [
  {
    type: "event",
    runId: runDetailFixture.run.id,
    event: { kind: "command", ts: 1700000005000 },
  },
  { type: "run", run: runDetailFixture.run },
  { type: "approval", approval: approvalsFixture[0] as never },
  {
    type: "task",
    projectId: taskItem.projectId,
    taskId: taskItem.id,
    kind: "updated",
  },
  {
    type: "chat",
    channelId: channelItem.id,
    messageId: messageItem.id,
    threadRootId: null,
  },
  { type: "dashboard" },
  { type: "memory", orgId: meFixture.orgs[0]?.id ?? "org_019318894978701388bb69b7f5256003" },
];

export interface CryptoVector {
  rpOrigin: string;
  sessionId: string;
  challengeId: string;
  nonce: string;
  canonicalPayload: string;
  publicKeySpki: string;
  signature: string;
}

export const cryptoP256VectorFixture: CryptoVector = {
  rpOrigin: "http://localhost:4100",
  sessionId: "01931889-4978-7013-88bb-69b7f5256e65",
  challengeId: "ch_019318894978701388bb69b7f5256e65",
  nonce: "test_nonce_123456789012345678901234567890",
  canonicalPayload:
    "harness-mobile-stepup-v1|http://localhost:4100|01931889-4978-7013-88bb-69b7f5256e65|ch_019318894978701388bb69b7f5256e65|test_nonce_123456789012345678901234567890",
  publicKeySpki:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQut1gHTXG14xqB_NMo5yzITaBb3g1Lcdk4-SKvFTKAC6UAwXWozTLyomUkXHWzG51WjRHzgr0aXDjJ9_le7jwg",
  signature:
    "ifSjq9lyHJRMWQugiBJ8XeIjjxg8E3xGGCjL7g0HI__VtunTXGEm7n9ucMD9eb5R_hZeb3bYUGQRSFo5XQMyKQ",
};
