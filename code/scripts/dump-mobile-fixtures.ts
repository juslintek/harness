import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mobileDeviceView } from "../src/shared/auth";
import { moveFailureSchema, taskDetailSchema, taskViewSchema } from "../src/shared/board";
import { channelViewSchema, chatMembersSchema, messageViewSchema } from "../src/shared/chat";
import {
  lessonViewSchema,
  noteSummarySchema,
  noteViewSchema,
  noteWriteFeedItemSchema,
} from "../src/shared/memory";
import { wsMessageSchema } from "../src/shared/realtime";
import { approvalViewSchema, runDetailSchema } from "../src/shared/runs";
import { dashboardViewSchema } from "../src/shared/tracking";
import {
  approvalsFixture,
  boardTasksFixture,
  chatMessagesFixture,
  meFixture,
  move409Fixture,
  runDetailFixture,
} from "./dump-mobile-data-a";
import {
  cryptoP256VectorFixture,
  dashboardFixture,
  memoryFixture,
  wsFramesFixture,
} from "./dump-mobile-data-b";

export const FIXTURES_DIR: string = join(import.meta.dir, "../../contract/mobile-fixtures");

function validateAuthAndRuns(): void {
  const meSchema = z.object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      instanceAdmin: z.boolean(),
      createdAt: z.number(),
    }),
    session: z.object({
      id: z.string(),
      method: z.enum(["passkey", "email", "enroll", "recovery", "mobile"]),
      stepUpAt: z.number().nullable(),
      stepUpFresh: z.boolean(),
    }),
    orgs: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        personal: z.boolean(),
        createdAt: z.number(),
        role: z.enum(["admin", "member"]).nullable(),
      }),
    ),
    devices: z.array(mobileDeviceView),
  });
  meSchema.parse(meFixture);
  z.array(approvalViewSchema).parse(approvalsFixture);
  runDetailSchema.parse(runDetailFixture);
}

function validateBoardAndChat(): void {
  z.object({
    tasks: z.array(taskViewSchema),
    deps: z.array(z.object({ taskId: z.string(), dependsOn: z.string() })),
    detail: taskDetailSchema,
  }).parse(boardTasksFixture);
  z.object({
    held: moveFailureSchema,
    depsOpen: moveFailureSchema,
    childrenOpen: moveFailureSchema,
  }).parse(move409Fixture);
  z.object({
    channels: z.array(channelViewSchema),
    members: chatMembersSchema,
    messages: z.array(messageViewSchema),
  }).parse(chatMessagesFixture);
}

function validateMemoryAndDashboard(): void {
  z.object({
    facets: z.object({
      scopes: z.record(z.string(), z.number()),
      types: z.record(z.string(), z.number()),
      tags: z.record(z.string(), z.number()),
      sources: z.record(z.string(), z.number()),
    }),
    notes: z.array(noteSummarySchema),
    note: noteViewSchema,
    conflict409: z.object({ error: z.literal("conflict"), hash: z.string() }),
    writes: z.array(noteWriteFeedItemSchema),
    lessons: z.array(lessonViewSchema),
  }).parse(memoryFixture);
  dashboardViewSchema.parse(dashboardFixture);
  z.array(wsMessageSchema).parse(wsFramesFixture);
}

async function validateCryptoVector(): Promise<void> {
  const keyBytes = Buffer.from(cryptoP256VectorFixture.publicKeySpki, "base64url");
  const cryptoKey = await crypto.subtle.importKey(
    "spki",
    keyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const sigValid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    Buffer.from(cryptoP256VectorFixture.signature, "base64url"),
    new TextEncoder().encode(cryptoP256VectorFixture.canonicalPayload),
  );
  if (!sigValid) throw new Error("crypto-p256-vector signature failed WebCrypto verification");
}

export async function validateAndEmit(): Promise<Record<string, unknown>> {
  validateAuthAndRuns();
  validateBoardAndChat();
  validateMemoryAndDashboard();
  await validateCryptoVector();

  return {
    "me.json": meFixture,
    "approvals.json": approvalsFixture,
    "run-detail.json": runDetailFixture,
    "board-tasks.json": boardTasksFixture,
    "move-409.json": move409Fixture,
    "chat-messages.json": chatMessagesFixture,
    "memory.json": memoryFixture,
    "dashboard.json": dashboardFixture,
    "ws-frames.json": wsFramesFixture,
    "crypto-p256-vector.json": cryptoP256VectorFixture,
  };
}

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const fixtures = await validateAndEmit();
  for (const [filename, data] of Object.entries(fixtures)) {
    writeFileSync(join(FIXTURES_DIR, filename), `${JSON.stringify(data, null, 2)}\n`);
  }
  console.log(`wrote ${Object.keys(fixtures).length} files to ${FIXTURES_DIR}`);
}

if (import.meta.main) {
  void main();
}
