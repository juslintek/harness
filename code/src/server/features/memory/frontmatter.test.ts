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

test("invalid known-key values survive a rewrite through extra", () => {
  const text = '---\nid: 5\ntype: note\ntags: foo\nconfidence: "0.8"\nscope: org\n---\n\nbody\n';
  const first = parseNote(text);
  expect(first.meta.scope).toBe("org");
  expect(first.meta.extra).toEqual({ id: 5, type: "note", tags: "foo", confidence: "0.8" });
  const second = parseNote(serializeNote(first.meta, first.body));
  expect(second).toEqual(first);
});

test("extra keys named like Object.prototype members are kept", () => {
  const text = '---\nconstructor: foo\ntoString: x\nvalueOf: 1\n"__proto__": bar\n---\n\nbody\n';
  const first = parseNote(text);
  expect(Object.keys(first.meta.extra).sort()).toEqual([
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
  ]);
  expect(Object.getPrototypeOf(first.meta.extra)).toBe(Object.prototype);
  const second = parseNote(serializeNote(first.meta, first.body));
  expect(Object.keys(second.meta.extra).sort()).toEqual(Object.keys(first.meta.extra).sort());
  expect(Object.getOwnPropertyDescriptor(second.meta.extra, "constructor")?.value).toBe("foo");
  expect(Object.getOwnPropertyDescriptor(second.meta.extra, "__proto__")?.value).toBe("bar");
});

test("confidence outside 0..1 is kept as an unknown key, not indexed", () => {
  const { meta } = parseNote("---\nconfidence: 7\n---\n\nbody\n");
  expect(meta.confidence).toBeUndefined();
  expect(meta.extra).toEqual({ confidence: 7 });
});

test("an invalid value in extra never overwrites the canonical field set later", () => {
  const { meta } = parseNote("---\nid: n1\ntype: bogus\n---\n\nbody\n");
  expect(meta.type).toBeUndefined();
  expect(meta.extra["type"]).toBe("bogus");
  expect(parseNote(serializeNote(meta, "body")).meta.extra["type"]).toBe("bogus");
  const fixed = parseNote(serializeNote({ ...meta, type: "fact" }, "body")).meta;
  expect(fixed.type).toBe("fact");
  expect(fixed.id).toBe("n1");
  expect(fixed.extra["type"]).toBeUndefined();
});

test("an id that is empty or has a slash is not accepted; a rewrite replaces it", () => {
  for (const bad of ['""', "a/b", "-x", "a b"]) {
    const { meta } = parseNote(`---\nid: ${bad}\n---\n\nbody\n`);
    expect(meta.id).toBeUndefined();
    expect(Object.hasOwn(meta.extra, "id")).toBe(true);
    const fixed = parseNote(serializeNote({ ...meta, id: "fresh-1" }, "body")).meta;
    expect(fixed.id).toBe("fresh-1");
    expect(Object.hasOwn(fixed.extra, "id")).toBe(false);
  }
  expect(parseNote(`---\nid: ${"a".repeat(65)}\n---\n\nbody\n`).meta.id).toBeUndefined();
  expect(parseNote(`---\nid: ${"a".repeat(64)}\n---\n\nbody\n`).meta.id).toBe("a".repeat(64));
});
