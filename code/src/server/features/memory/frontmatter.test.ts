import { expect, test } from "bun:test";
import { hashText, noteTitle, parseNote, serializeNote, wikilinks } from "./frontmatter";

test("round trip keeps every key and unknown keys", () => {
  const meta = {
    id: "0192-abc",
    type: "lesson" as const,
    scope: "project" as const,
    tags: ["a", "123", "y"],
    sourceAgent: "human:u1",
    created: "2026-11-04T10:00:00.000Z",
    updated: "2026-11-04T11:00:00.000Z",
    confidence: 0.75,
    extra: { owner: "x", nested: { k: [1, 2] } },
  };
  const text = serializeNote(meta, "# T\n\nbody\n\n\n");
  expect(text.startsWith("---\nid: ")).toBe(true);
  expect(text.endsWith("body\n")).toBe(true);
  expect(parseNote(text)).toEqual({ meta, body: "# T\n\nbody\n" });
});

test("no or broken frontmatter returns the whole text", () => {
  const empty = { tags: [], extra: {} };
  expect(parseNote("# Hi\n")).toEqual({ meta: empty, body: "# Hi\n" });
  const broken = "---\na: [\n---\n\nbody\n";
  expect(parseNote(broken)).toEqual({ meta: empty, body: broken });
  const list = "---\n- a\n---\n\nbody\n";
  expect(parseNote(list).body).toBe(list);
});

test("wikilinks lowercases, drops alias and heading, ignores code fences", () => {
  expect(wikilinks("see [[Foo Bar]] and [[x|y]] ```[[no]]```")).toEqual(["foo bar", "x"]);
  expect(wikilinks("[[Page#Head]] [[page]]")).toEqual(["page"]);
});

test("title falls back to the file name; hash is sha256 hex", () => {
  expect(noteTitle("text\n# Real title\n", "a/b.md")).toBe("Real title");
  expect(noteTitle("no heading", "a/deploy-notes.md")).toBe("deploy-notes");
  expect(hashText("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
