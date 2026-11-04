// Reads and the eight assertions of the Phase 4 gate.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTask } from "../src/server/features/board/api";
import { redact } from "../src/server/features/logs/api";
import { git } from "./gate-2-kit";
import { check, type Db, type Scene } from "./gate-4-kit";

export const SECRET = "team-larch-7";
export const HEADER: string = `// owner: ${SECRET}`;

// Only runs of the member count: a lead writing the file itself would prove nothing about memory.
export function branchesOf(db: Db, memberId: string): string[] {
  return db
    .query<{ branch: string }, [string]>(
      "SELECT DISTINCT branch FROM runs WHERE member_id = ? AND branch IS NOT NULL",
    )
    .all(memberId)
    .map((r) => r.branch);
}

export function fileOnBranch(repo: string, branch: string, file: string): string | null {
  try {
    return git(["show", `${branch}:${file}`], repo);
  } catch {
    return null;
  }
}

export function branchWith(db: Db, s: Scene, memberId: string, file: string): string | null {
  const hit = branchesOf(db, memberId).find((b) => fileOnBranch(s.repo, b, file) !== null);
  return hit ?? null;
}

export function hasLiveRun(db: Db, memberId: string): boolean {
  return (
    db
      .query("SELECT 1 FROM runs WHERE member_id = ? AND ended_at IS NULL LIMIT 1")
      .get(memberId) !== null
  );
}

interface LessonRow {
  id: string;
  author_id: string | null;
  reviewer_id: string | null;
  status: string;
  note_id: string | null;
  scope: string;
  body: string;
  task_id: string;
}

export function lessons(db: Db, orgId: string): LessonRow[] {
  return db
    .query<LessonRow, [string]>("SELECT * FROM lessons WHERE org_id = ? ORDER BY created_at")
    .all(orgId);
}

export function noteDisk(db: Db, noteId: string): string | null {
  const row = db
    .query<{ disk: string; type: string; scope: string }, [string]>(
      "SELECT disk, type, scope FROM notes WHERE id = ?",
    )
    .get(noteId);
  return row?.type === "lesson" && (row.scope === "project" || row.scope === "org")
    ? row.disk
    : null;
}

// The accepted lesson whose project or org note carries the rule; null until memory has written it.
export function acceptedLesson(db: Db, home: string, s: Scene): LessonRow | null {
  for (const l of lessons(db, s.orgId)) {
    if (l.status !== "accepted" || l.reviewer_id !== s.lead.id || l.note_id === null) continue;
    const disk = noteDisk(db, l.note_id);
    const file = disk === null ? null : join(home, "memory", disk);
    if (file !== null && existsSync(file) && readFileSync(file, "utf8").includes(SECRET)) return l;
  }
  return null;
}

export function dumpMemoryState(db: Db, s: Scene): void {
  console.error("\nlessons:");
  for (const l of lessons(db, s.orgId)) {
    console.error(
      `  ${l.id.slice(-6)} ${l.status} author=${l.author_id?.slice(-6) ?? "-"} reviewer=${l.reviewer_id?.slice(-6) ?? "-"} note=${l.note_id ?? "-"} ${l.body.slice(0, 100)}`,
    );
  }
  console.error("wakeups:");
  const rows = db
    .query<{ reason: string; handle: string; status: string; run_id: string | null }, []>(
      `SELECT w.reason, m.handle, w.status, w.run_id FROM wakeups w
       JOIN members m ON m.id = w.member_id ORDER BY w.created_at`,
    )
    .all();
  for (const w of rows)
    console.error(`  ${w.reason} @${w.handle} ${w.status} run=${w.run_id?.slice(-6) ?? "-"}`);
}

function retroRan(db: Db, s: Scene, taskId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM wakeups WHERE member_id = ? AND task_id = ? AND reason = 'retro' AND run_id IS NOT NULL",
      )
      .get(s.dev.id, taskId) !== null
  );
}

function vaultMarkdown(home: string): string[] {
  const root = join(home, "memory");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (p) => p.endsWith(".md") && !p.split("/").some((seg) => seg.startsWith(".")),
  );
}

function committed(home: string, disk: string): boolean {
  try {
    return git(["log", "--format=%H", "--", disk], join(home, "memory")) !== "";
  } catch {
    return false;
  }
}

interface ReadRow {
  note_id: string;
  via: string;
  at: number;
  started: number | null;
}

function devReads(db: Db, s: Scene, taskB: string): ReadRow[] {
  return db
    .query<ReadRow, [string, string]>(
      `SELECT nr.note_id, nr.via, nr.at, r.started_at AS started FROM note_reads nr
       JOIN runs r ON r.id = nr.run_id
       WHERE r.agent_id = 'codex' AND r.member_id = ? AND r.task_id = ? ORDER BY nr.at`,
    )
    .all(s.dev2.id, taskB);
}

// The task part of a run prompt is the wake list; the memory notice that follows may name notes.
function wakePart(prompt: string): string {
  const from = prompt.indexOf("You were woken because:");
  if (from < 0) return prompt;
  const end = prompt.indexOf("\n\n", from);
  return end < 0 ? prompt.slice(from) : prompt.slice(from, end);
}

function leakedBefore(db: Db, s: Scene, taskB: string, cutoff: number): string[] {
  const task = getTask(db, taskB);
  const out: string[] = [];
  if (`${task?.title} ${task?.description}`.includes(SECRET)) out.push("task B text");
  const prompts = db
    .query<{ prompt: string }, [string, string]>(
      "SELECT prompt FROM runs WHERE member_id = ? AND task_id = ?",
    )
    .all(s.dev2.id, taskB);
  if (prompts.some((p) => wakePart(p.prompt).includes(SECRET)))
    out.push("dev2 run prompt task part");
  const chat = db
    .query<{ n: number }, [string, number]>(
      `SELECT count(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id
       WHERE c.org_id = ? AND m.created_at < ? AND m.body LIKE '%${SECRET}%'`,
    )
    .get(s.orgId, cutoff);
  if ((chat?.n ?? 0) > 0) out.push("chat message");
  return out;
}

// Codex drops a tool whose schema it cannot parse and only says so in its own log database.
function skippedMcpTools(home: string): string[] {
  const out: string[] = [];
  const runs = join(home, "runs");
  if (!existsSync(runs)) return out;
  for (const run of readdirSync(runs)) {
    const dir = join(runs, run, "codex-home");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => /^logs_\d+\.sqlite$/.test(n))) {
      const db = new Database(join(dir, f), { readonly: true });
      try {
        const rows = db
          .query<{ feedback_log_body: string }, []>(
            "SELECT feedback_log_body FROM logs WHERE feedback_log_body LIKE '%Skipping MCP tool%'",
          )
          .all();
        for (const r of rows)
          out.push(/Skipping MCP tool '([^']+)'/.exec(r.feedback_log_body)?.[1] ?? "?");
      } finally {
        db.close();
      }
    }
  }
  return [...new Set(out)];
}

export function assertOutcome(db: Db, s: Scene, home: string, taskA: string, taskB: string): void {
  const lesson = lessons(db, s.orgId).find(
    (l) => l.author_id === s.dev.id && l.status === "accepted",
  );
  check(retroRan(db, s, taskA), "1 a retro wake ran for @dev");
  check(
    lesson !== undefined && lesson.reviewer_id === s.lead.id,
    "2 a lesson by @dev was decided by @lead",
  );
  const disk = lesson?.note_id == null ? null : noteDisk(db, lesson.note_id);
  const inDir =
    disk?.startsWith(`orgs/${s.orgId}/projects/${s.projectId}/lessons/`) === true ||
    disk?.startsWith(`orgs/${s.orgId}/org/lessons/`) === true;
  check(
    disk !== null &&
      inDir &&
      existsSync(join(home, "memory", disk)) &&
      readFileSync(join(home, "memory", disk), "utf8").includes(SECRET) &&
      committed(home, disk),
    "3 the lesson note file is in the project or org lessons dir, carries the rule and is in the vault git log",
  );
  const reads = devReads(db, s, taskB);
  const first = reads.at(0);
  const firstStart = Math.min(...reads.map((r) => r.started ?? Number.POSITIVE_INFINITY));
  const used = reads.some(
    (r) =>
      r.note_id === lesson?.note_id && ["view", "search"].includes(r.via) && r.at >= firstStart,
  );
  check(used, "4 a codex run of @dev2 read the lesson note by view or search during task B");
  const dev2Files = branchesOf(db, s.dev2.id).map((b) => fileOnBranch(s.repo, b, "src/clamp.js"));
  const head = dev2Files.find((f) => f !== null)?.split("\n")[0];
  check(head === HEADER, `5 @dev2's src/clamp.js starts with "${HEADER}"`);
  const leaks = leakedBefore(db, s, taskB, first?.at ?? Date.now() + 1);
  check(
    leaks.length === 0,
    `6 ${SECRET} reached @dev2 only through memory (before its first memory read: ${leaks.join(", ") || "none"})`,
  );
  const dirty = vaultMarkdown(home).filter((p) => {
    const text = readFileSync(join(home, "memory", p), "utf8");
    return redact(text) !== text;
  });
  check(dirty.length === 0, `7 no secrets in vault files (${dirty.join(", ") || "clean"})`);
  const skipped = skippedMcpTools(home);
  check(
    skipped.length === 0,
    `8 codex kept every MCP tool (skipped: ${skipped.join(", ") || "none"})`,
  );
}
