import { type Case, defineCases, type Fixture, type Ids, makeNote, SECRET } from "./isolation-kit";
import { seedLesson } from "./isolation-seed";

const rand = (): string => Bun.randomUUIDv7().slice(-8);

// Update and delete need the note's current hash, and both change it, so each run gets its own.
async function freshNote(f: Fixture): Promise<Ids> {
  const n = await makeNote(f, `${SECRET} fresh`);
  return { fresh: n.id, freshHash: n.hash };
}

// A revert is only allowed for the newest write of a note, so edit once and take that write.
async function revertable(f: Fixture): Promise<Ids> {
  const { fresh, freshHash } = await freshNote(f);
  const url = `/api/orgs/alpha/memory/notes/${fresh}`;
  const edit = await f.kit.call(f.a, "PUT", url, { baseHash: freshHash, body: `${SECRET} edited` });
  if (edit.status !== 200) throw new Error(`seed edit failed: ${edit.status}`);
  const feed = (await (await f.kit.call(f.a, "GET", "/api/orgs/alpha/memory/writes")).json()) as {
    id: string;
    noteId: string;
    op: string;
  }[];
  const write = feed.find((w) => w.noteId === fresh && w.op === "update");
  if (!write) throw new Error("seed write missing from feed");
  return { write: write.id };
}

const M = "/api/orgs/alpha/memory";
const cases: Case[] = [
  { name: "memory notes", method: "GET", path: () => `${M}/notes` },
  { name: "memory facets", method: "GET", path: () => `${M}/facets` },
  { name: "memory note", method: "GET", path: (i) => `${M}/notes/${i.note}` },
  { name: "memory backlinks", method: "GET", path: (i) => `${M}/notes/${i.target}/backlinks` },
  {
    name: "memory link",
    method: "GET",
    path: (i) => `${M}/notes/${i.note}/link?target=elsewhere`,
  },
  {
    name: "memory create",
    method: "POST",
    path: () => `${M}/notes`,
    body: () => ({ scope: "org", rel: `new-${rand()}.md`, body: "x" }),
  },
  {
    name: "memory update",
    method: "PUT",
    path: (i) => `${M}/notes/${i.fresh}`,
    body: (i) => ({ baseHash: i.freshHash, body: "changed" }),
    fresh: freshNote,
  },
  {
    name: "memory delete",
    method: "DELETE",
    path: (i) => `${M}/notes/${i.fresh}?baseHash=${i.freshHash}`,
    fresh: freshNote,
  },
  { name: "memory writes", method: "GET", path: () => `${M}/writes` },
  {
    name: "memory revert",
    method: "POST",
    path: (i) => `${M}/writes/${i.write}/revert`,
    fresh: revertable,
  },
  { name: "memory lessons", method: "GET", path: () => `${M}/lessons` },
  {
    name: "memory decide lesson",
    method: "POST",
    path: (i) => `${M}/lessons/${i.lesson}`,
    body: () => ({ decision: "reject", reason: "not useful" }),
    fresh: (f) => ({ lesson: seedLesson(f.kit.db, f.scope, f.ids.task as string) }),
  },
  {
    name: "lesson id under own slug",
    method: "POST",
    path: (i) => `${M}/lessons/${i.lesson}`,
    attackPath: (i) => `/api/orgs/bravo/memory/lessons/${i.lesson}`,
    body: () => ({ decision: "reject", reason: "not useful" }),
    fresh: (f) => ({ lesson: seedLesson(f.kit.db, f.scope, f.ids.task as string) }),
  },
  {
    name: "write id under own slug",
    method: "POST",
    path: (i) => `${M}/writes/${i.write}/revert`,
    attackPath: (i) => `/api/orgs/bravo/memory/writes/${i.write}/revert`,
    fresh: revertable,
  },
  {
    name: "memory note id under own slug",
    method: "GET",
    path: (i) => `${M}/notes/${i.note}`,
    attackPath: (i) => `/api/orgs/bravo/memory/notes/${i.note}`,
  },
];

defineCases("org isolation: memory", cases);
