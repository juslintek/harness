import { expect, test } from "bun:test";
import { lineDiff } from "./line-diff";

test("identical text is all context", () => {
  expect(lineDiff("a\nb", "a\nb")).toEqual([
    { op: " ", line: "a" },
    { op: " ", line: "b" },
  ]);
});

test("an inserted line is a plus", () => {
  expect(lineDiff("a\nc", "a\nb\nc")).toEqual([
    { op: " ", line: "a" },
    { op: "+", line: "b" },
    { op: " ", line: "c" },
  ]);
});

test("a removed line is a minus", () => {
  expect(lineDiff("a\nb\nc", "a\nc")).toEqual([
    { op: " ", line: "a" },
    { op: "-", line: "b" },
    { op: " ", line: "c" },
  ]);
});

test("a changed line is a minus then a plus", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
    { op: " ", line: "a" },
    { op: "-", line: "b" },
    { op: "+", line: "B" },
    { op: " ", line: "c" },
  ]);
});

test("empty before is all additions", () => {
  expect(lineDiff("", "x")).toEqual([{ op: "+", line: "x" }]);
});

test("above 2000 lines the whole block is replaced", () => {
  const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join("\n");
  const out = lineDiff(big, `${big}\nmore`);
  expect(out.filter((d) => d.op === " ")).toHaveLength(0);
  expect(out.filter((d) => d.op === "-")).toHaveLength(2001);
  expect(out.filter((d) => d.op === "+")).toHaveLength(2002);
});
