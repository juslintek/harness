import { expect, test } from "bun:test";
import { parseMessage } from "./api";

test("handle and task number", () => {
  expect(parseMessage("@codex please fix #12")).toEqual({ handles: ["codex"], taskNumbers: [12] });
});

test("email address is not a mention", () => {
  expect(parseMessage("write to a@b.com").handles).toEqual([]);
});

test("code spans and fences are skipped", () => {
  expect(parseMessage("`@x` and `#5`")).toEqual({ handles: [], taskNumbers: [] });
  expect(parseMessage("```\n@x #5\n```\n@yy")).toEqual({ handles: ["yy"], taskNumbers: [] });
});

test("duplicates collapse, punctuation ends a handle", () => {
  expect(parseMessage("@bob, @bob! #3 #3.")).toEqual({ handles: ["bob"], taskNumbers: [3] });
});

test("one-letter handles and word-attached hashes are ignored", () => {
  expect(parseMessage("@a abc#4 &#39;")).toEqual({ handles: [], taskNumbers: [] });
});
