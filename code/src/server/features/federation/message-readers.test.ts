import { expect, test } from "bun:test";
import { type MessageView, messageListSchema } from "../../../shared/chat";
import { MessageItem } from "../../../web/features/chat/message-list";
import { bootApi } from "../../test-support/api-kit";
import { ensureProjectChannel } from "../chat/api";
import { createProject } from "../orgs/api";
import { parseData } from "./apply";
import { specOf } from "./schema";

// Rows are written with plain SQL, as an apply without the federation checks would store them.
// Each case shows that a value SQLite accepts breaks a real reader, which is why apply refuses it.
async function world() {
  const k = bootApi();
  const owner = await k.user();
  const org = k.org(owner, "acme");
  const project = createProject(k.db, { orgId: org.id, key: "web", name: "Web" });
  const channel = ensureProjectChannel(k.db, project.id);
  const read = (query = ""): Promise<Response> =>
    k.call(owner, "GET", `/api/channels/${channel.id}/messages${query}`);
  const add = (id: string, createdAt: number): void => {
    k.db.run(
      "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES (?, ?, ?, 'x', ?)",
      [id, channel.id, org.owner.id, createdAt],
    );
  };
  return { k, owner, channel, read, add };
}

const chatCtx = { slug: "acme", byHandle: new Map() };
const HONEST_TIME = 1_700_000_000_000;

async function firstServed(createdAt: number): Promise<MessageView> {
  const { read, add } = await world();
  add("m-one", createdAt);
  const res = await read();
  expect(res.status).toBe(200);
  const [message] = messageListSchema.parse(await res.json());
  if (!message) throw new Error("no message served");
  return message;
}

test("a message at a time inside the Date range is served and rendered", async () => {
  const message = await firstServed(HONEST_TIME);
  expect(() => MessageItem({ message, ctx: chatCtx })).not.toThrow();
});

// MessageItem puts new Date(createdAt).toISOString() on the time element, which throws past the range.
test.each([9e15, -9e15, 8.64e15 + 1])(
  "a message at %d is served and parses, then the chat view throws on it",
  async (createdAt) => {
    const message = await firstServed(createdAt);
    expect(message.createdAt).toBe(createdAt);
    expect(() => MessageItem({ message, ctx: chatCtx })).toThrow(RangeError);
  },
);

// chat-history.ts asks for older messages with `${createdAt}:${id}` of the oldest message it holds.
async function olderStatus(createdAt: number, id: string): Promise<number> {
  const { read, add } = await world();
  add(id, createdAt);
  return (await read(`?before=${createdAt}:${id}&limit=50`)).status;
}

test("the load-older cursor of an honest oldest message is accepted", async () => {
  expect(await olderStatus(HONEST_TIME, "m-ok")).toBe(200);
});

test.each<[string, number, string]>([
  ["created_at 0", 0, "m-ok"],
  ["created_at -9e15", -9e15, "m-ok"],
  ["an id with a dot", HONEST_TIME, "m.dot"],
  ["an id of 65 characters", HONEST_TIME, "a".repeat(65)],
])("the load-older cursor of an oldest message with %s is refused", async (_name, at, id) => {
  expect(await olderStatus(at, id)).toBe(400);
});

// Rows the local writer produces are what an honest peer sends, and the check has to let them through.
test("a message and a reply written through the chat route pass the federation check", async () => {
  const { k, owner, channel } = await world();
  const spec = specOf("messages");
  if (!spec) throw new Error("no messages table");
  const post = async (body: object): Promise<MessageView> =>
    (await k.call(owner, "POST", `/api/channels/${channel.id}/messages`, body)).json();
  const root = await post({ body: "root" });
  const reply = await post({ body: "re", threadRootId: root.id });
  for (const { id } of [root, reply]) {
    const row = k.db.query(`SELECT ${spec.columns.join(", ")} FROM messages WHERE id = ?`).get(id);
    const change = {
      project_id: "p",
      table_name: "messages",
      row_id: id,
      op: "put" as const,
      hlc: "h",
      origin_instance: "i",
      data: JSON.stringify(row),
    };
    expect(parseData(spec, change)).not.toBeNull();
  }
});
