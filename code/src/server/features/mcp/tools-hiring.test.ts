import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HireView } from "../../../shared/hiring";
import { type HiringWorld, hiringWorld } from "../../test-support/hiring-kit";
import { candidateRunEnded, getHire, listHires, pass, score, startHiring } from "../hiring/api";
import { addAgentMember, createOrg, findMemberByHandle } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { mintRunToken } from "./api";
import { call, listen } from "./test-kit";

let w: HiringWorld;
let server: ReturnType<typeof Bun.serve>;
let stop: () => void;

beforeEach(async () => {
  w = hiringWorld();
  stop = startHiring(w.db, w.deps, null);
  server = await listen(w.db);
});
afterEach(() => {
  stop();
  server.stop(true);
});

const memberToken = (memberId: string, orgId = w.orgId): string =>
  mintRunToken(w.db, Bun.randomUUIDv7(), ["report", "guard_hook", "hiring", "profile"], {
    memberId,
    orgId,
  });
const candidateToken = (candidateId: string): string =>
  mintRunToken(w.db, Bun.randomUUIDv7(), ["report", "guard_hook", "interview"], {
    candidateId,
    orgId: w.orgId,
  });

function toScoring(hire: HireView): void {
  w.answerAll(hire);
  for (const r of getHire(w.db, hire.id)?.reviewers ?? []) pass(w.db, w.deps, hire.id, r.memberId);
}

function toDeciding(hire: HireView): void {
  toScoring(hire);
  for (const r of getHire(w.db, hire.id)?.reviewers ?? []) {
    for (const c of hire.candidates) {
      score(w.db, w.deps, {
        candidateId: c.id,
        scorerId: r.memberId,
        fit: 4,
        depth: 4,
        honesty: 4,
        notes: "",
      });
    }
  }
}

test("candidate token calling board_list or chat_post is refused", async () => {
  const hire = await w.file();
  const token = candidateToken(hire.candidates[0]?.id as string);
  const board = await call(server, token, "board_list");
  expect(board).toEqual({ isError: true, text: "token lacks board scope" });
  const chat = await call(server, token, "chat_post", { channel: "x", text: "hi" });
  expect(chat.isError).toBe(true);
  const hireTool = await call(server, token, "hire_list");
  expect(hireTool).toEqual({ isError: true, text: "token lacks hiring scope" });
});

test("interview_answer stores the answer and the run end advances the request", async () => {
  const hire = await w.file();
  for (const c of hire.candidates) {
    const token = candidateToken(c.id);
    for (const q of hire.questions) {
      const out = await call(server, token, "interview_answer", {
        question: q.id,
        answer: "my answer",
      });
      expect(out.isError).toBe(false);
    }
  }
  const stored = getHire(w.db, hire.id);
  expect(stored?.candidates[0]?.answers.map((a) => a.body)).toEqual([
    "my answer",
    "my answer",
    "my answer",
  ]);
  expect(stored?.status).toBe("interviewing");
  for (const c of hire.candidates) candidateRunEnded(w.db, w.deps, c.id, true);
  expect(getHire(w.db, hire.id)?.status).toBe("followups");
});

test("interview_answer refuses another request's question", async () => {
  const hire = await w.file();
  w.db.query("UPDATE hire_requests SET status = 'cancelled'").run();
  const other = await w.file();
  const out = await call(
    server,
    candidateToken(hire.candidates[0]?.id as string),
    "interview_answer",
    {
      question: other.questions[0]?.id,
      answer: "x",
    },
  );
  expect(out).toEqual({ isError: true, text: "unknown question" });
});

test("hire_request from an agent creates a request in its team", async () => {
  const dev = w.agent("dev");
  const out = await call(server, memberToken(dev.id), "hire_request", {
    title: "Data engineer",
    specialty: "database",
    summary: "own the warehouse",
    taskTypes: ["feature"],
  });
  expect(out.isError).toBe(false);
  const made = listHires(w.db, w.orgId);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ teamId: w.teamId, requestedBy: dev.id, status: "interviewing" });
  expect(JSON.parse(out.text).hire).toBe(made[0]?.id);
});

test("hire_request is refused while the requester's budget is exhausted", async () => {
  stop();
  stop = startHiring(w.db, { ...w.deps, budgetPaused: () => true }, null);
  const dev = w.agent("dev");
  const out = await call(server, memberToken(dev.id), "hire_request", {
    title: "Data engineer",
    specialty: "database",
    summary: "x",
    taskTypes: ["feature"],
  });
  expect(out).toEqual({
    isError: true,
    text: "your budget is exhausted, so no new interviews can start",
  });
  expect(listHires(w.db, w.orgId)).toHaveLength(0);
});

test("hire_request is refused while the team has an open request", async () => {
  await w.file();
  const dev = w.agent("dev");
  const out = await call(server, memberToken(dev.id), "hire_request", {
    title: "Data engineer",
    specialty: "database",
    summary: "x",
    taskTypes: ["feature"],
  });
  expect(out).toEqual({ isError: true, text: "this team already has an open hire request" });
});

test("hire_request names a team the caller is not in is refused", async () => {
  const loner = w.agent("loner", false);
  const out = await call(server, memberToken(loner.id), "hire_request", {
    title: "Data engineer",
    specialty: "database",
    summary: "x",
    taskTypes: ["feature"],
  });
  expect(out).toEqual({ isError: true, text: "you are in no team" });
});

test("hire_list shows open hires of my teams with answers and cards", async () => {
  const dev = w.agent("dev");
  const hire = await w.file();
  w.answerAll(hire, [0]);
  const out = JSON.parse((await call(server, memberToken(dev.id), "hire_list")).text);
  expect(out).toHaveLength(1);
  expect(out[0].candidates[0].answers[0]).toEqual({
    question: hire.questions[0]?.body,
    answer: "an answer",
  });
  expect(out[0].candidates[0].card.summary).toBe("Backend dev");
  const outsider = w.agent("outsider", false);
  expect(JSON.parse((await call(server, memberToken(outsider.id), "hire_list")).text)).toEqual([]);
});

test("interview_ask and interview_pass work for an invited reviewer only", async () => {
  const dev = w.agent("dev");
  const outsider = w.agent("outsider", false);
  const hire = await w.file();
  w.answerAll(hire);
  const target = hire.candidates[0]?.id;
  const refused = await call(server, memberToken(outsider.id), "interview_pass", { hire: hire.id });
  expect(refused).toEqual({ isError: true, text: "not a reviewer of this request" });
  const asked = await call(server, memberToken(dev.id), "interview_ask", {
    hire: hire.id,
    candidate: target,
    question: "why sql?",
  });
  expect(asked.isError).toBe(false);
  const passed = await call(server, memberToken(w.boss.id), "interview_pass", { hire: hire.id });
  expect(passed.isError).toBe(false);
});

test("interview_score from a member not invited, or from another org, is refused", async () => {
  w.agent("rev1");
  const hire = await w.file();
  toScoring(hire);
  const outsider = w.agent("outsider", false);
  const args = {
    hire: hire.id,
    candidate: hire.candidates[0]?.id,
    fit: 4,
    depth: 4,
    honesty: 4,
    notes: "",
  };
  const notInvited = await call(server, memberToken(outsider.id), "interview_score", args);
  expect(notInvited).toEqual({ isError: true, text: "not allowed to score this request" });
  const orgB = createOrg(w.db, {
    name: "B",
    slug: "bb",
    ownerUserId: "u2",
    ownerName: "O2",
    ownerHandle: "owner2",
  });
  const spy = addAgentMember(w.db, orgB.id, {
    agentId: "claude",
    handle: "spy",
    displayName: "spy",
    specialties: [],
  });
  const crossOrg = await call(server, memberToken(spy.id, orgB.id), "interview_score", args);
  expect(crossOrg).toEqual({ isError: true, text: "unknown hire" });
  const reviewer = getHire(w.db, hire.id)?.reviewers[0]?.memberId as string;
  expect((await call(server, memberToken(reviewer), "interview_score", args)).isError).toBe(false);
});

test("hire_decide by a non-manager is refused, by the woken manager hires once", async () => {
  const dev = w.agent("dev");
  const hire = await w.file(dev.id);
  toDeciding(hire);
  const args = { hire: hire.id, candidate: hire.candidates[0]?.id, reason: "best answers" };
  const refused = await call(server, memberToken(dev.id), "hire_decide", args);
  expect(refused).toEqual({ isError: true, text: "not allowed to decide" });
  const [first, second] = await Promise.all([
    call(server, memberToken(w.boss.id), "hire_decide", args),
    call(server, memberToken(w.boss.id), "hire_decide", args),
  ]);
  expect([first.isError, second.isError].sort()).toEqual([false, true]);
  expect([first, second].find((r) => r.isError)?.text).toBe("already decided");
  const done = getHire(w.db, hire.id);
  expect(done?.status).toBe("hired");
  expect(findMemberByHandle(w.db, w.orgId, "backend-engineer")?.id).toBe(
    done?.hiredMemberId as string,
  );
});

test("hire_decide none rejects, and the human policy keeps agents out", async () => {
  const dev = w.agent("dev");
  const hire = await w.file(dev.id);
  toDeciding(hire);
  setPolicy(w.db, {
    layer: "org",
    targetId: w.orgId,
    key: "hiring.decision",
    value: "human",
    setBy: "u1",
  });
  const args = { hire: hire.id, candidate: "none", reason: "nobody fits" };
  const blocked = await call(server, memberToken(w.boss.id), "hire_decide", args);
  expect(blocked).toEqual({ isError: true, text: "this org lets only a person decide hires" });
  setPolicy(w.db, {
    layer: "org",
    targetId: w.orgId,
    key: "hiring.decision",
    value: "manager",
    setBy: "u1",
  });
  expect((await call(server, memberToken(w.boss.id), "hire_decide", args)).isError).toBe(false);
  expect(getHire(w.db, hire.id)?.status).toBe("rejected");
});
