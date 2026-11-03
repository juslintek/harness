import { expect, test } from "bun:test";
import type { HireView } from "../../../shared/hiring";
import { type HiringWorld, hiringWorld } from "../../test-support/hiring-kit";
import { createProject, findMemberByHandle, listPositions, updateMember } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { profileOfMember } from "../profiles/api";
import { candidateOfRun, decide, getHire, pass, score, teamLacks } from "./api";

function policy(w: HiringWorld, value: string): void {
  setPolicy(w.db, { layer: "org", targetId: w.orgId, key: "hiring.decision", value, setBy: "u1" });
}

// Reviewers pass on follow-ups and then give each candidate the marks in `marks[reviewerIndex][candidateIndex]`.
function toDeciding(w: HiringWorld, hire: HireView, marks: [number, number, number][][]): void {
  w.answerAll(hire, [0]);
  const reviewers = getHire(w.db, hire.id)?.reviewers ?? [];
  for (const r of reviewers) pass(w.db, w.deps, hire.id, r.memberId);
  for (const [ri, r] of reviewers.entries()) {
    for (const [ci, c] of hire.candidates.entries()) {
      const [fit, depth, honesty] = marks[ri]?.[ci] ?? [3, 3, 3];
      score(w.db, w.deps, {
        candidateId: c.id,
        scorerId: r.memberId,
        fit,
        depth,
        honesty,
        notes: "",
      });
    }
  }
}

const firstCandidate = (w: HiringWorld, hire: HireView): string => {
  const id = getHire(w.db, hire.id)?.candidates[0]?.id;
  if (!id) throw new Error("no candidate");
  return id;
};

test("auto policy hires the best candidate under the manager and wakes the new member", () => {
  const w = hiringWorld();
  w.agent("rev1");
  policy(w, "auto");
  const hire = w.file();
  toDeciding(w, hire, [
    [
      [4, 4, 3],
      [1, 1, 1],
    ],
    [
      [3, 3, 4],
      [1, 1, 1],
    ],
  ]);
  const done = getHire(w.db, hire.id);
  expect(done?.status).toBe("hired");
  expect(done?.candidates[0]?.total).toBeCloseTo(4.1);
  expect(done?.candidates[1]?.total).toBeCloseTo(1.4);
  expect(done?.decidedBy).toBe("policy:auto");
  const member = findMemberByHandle(w.db, w.orgId, "backend-engineer");
  expect(done?.hiredMemberId).toBe(member?.id as string);
  expect(member?.specialties).toContain("backend");
  expect(profileOfMember(w.db, member?.id as string)?.id).toBe(
    done?.candidates[0]?.profile.id as string,
  );
  const positions = listPositions(w.db, w.orgId);
  const lead = positions.find((p) => p.memberId === w.boss.id);
  expect(positions.find((p) => p.memberId === member?.id)?.reportsTo).toBe(lead?.id as string);
  expect(w.wakes).toContainEqual({
    memberId: member?.id as string,
    reason: "onboarding",
    detail: { requestId: hire.id },
    causedBy: `hire:${hire.id}`,
  });
  expect(w.wakes.find((x) => x.reason === "approval_resolved")?.detail).toEqual({
    kind: "hire",
    requestId: hire.id,
    outcome: "hired",
  });
});

test("auto policy rejects everyone when nobody reaches the minimum", () => {
  const w = hiringWorld();
  policy(w, "auto");
  const hire = w.file();
  toDeciding(w, hire, [
    [
      [1, 1, 1],
      [1, 1, 1],
    ],
  ]);
  expect(getHire(w.db, hire.id)?.status).toBe("rejected");
  expect(findMemberByHandle(w.db, w.orgId, "backend-engineer")).toBeNull();
});

test("manager policy wakes the manager, human policy waits", () => {
  const w = hiringWorld();
  const rev = w.agent("rev1");
  const hire = w.file(rev.id);
  toDeciding(w, hire, []);
  expect(getHire(w.db, hire.id)?.status).toBe("deciding");
  const asked = w.wakes.filter((x) => x.reason === "hire_decision");
  expect(asked).toEqual([
    {
      memberId: w.boss.id,
      reason: "hire_decision",
      detail: { requestId: hire.id },
      causedBy: `hire:${hire.id}`,
    },
  ]);

  const other = hiringWorld();
  policy(other, "human");
  const waiting = other.file();
  toDeciding(other, waiting, []);
  expect(getHire(other.db, waiting.id)?.status).toBe("deciding");
  expect(other.wakes.some((x) => x.reason === "hire_decision")).toBe(false);
});

test("two decide calls make one member and the second is told it was already decided", () => {
  const w = hiringWorld();
  policy(w, "human");
  const hire = w.file();
  toDeciding(w, hire, []);
  const input = {
    requestId: hire.id,
    candidateId: firstCandidate(w, hire),
    decidedBy: "u1",
    reason: "ok",
  };
  const first = decide(w.db, w.deps, input);
  expect(first.ok).toBe(true);
  expect(decide(w.db, w.deps, input)).toEqual({ ok: false, reason: "already decided" });
  const count = w.db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM members WHERE handle LIKE 'backend-engineer%'",
    )
    .get();
  expect(count?.n).toBe(1);
});

test("a decision before the scoring is done is refused", () => {
  const w = hiringWorld();
  const hire = w.file();
  const result = decide(w.db, w.deps, {
    requestId: hire.id,
    candidateId: null,
    decidedBy: "u1",
    reason: "",
  });
  expect(result).toEqual({ ok: false, reason: "not ready to decide" });
});

test("a clashing handle gets a number", () => {
  const w = hiringWorld();
  w.agent("backend-engineer");
  policy(w, "human");
  const hire = w.file();
  toDeciding(w, hire, []);
  decide(w.db, w.deps, {
    requestId: hire.id,
    candidateId: firstCandidate(w, hire),
    decidedBy: "u1",
    reason: "",
  });
  expect(findMemberByHandle(w.db, w.orgId, "backend-engineer-2")).not.toBeNull();
});

test("the onboarding pack names the manager and the team projects", () => {
  const w = hiringWorld();
  policy(w, "human");
  createProject(w.db, { orgId: w.orgId, teamId: w.teamId, key: "WEB", name: "Website" });
  const hire = w.file();
  toDeciding(w, hire, []);
  decide(w.db, w.deps, {
    requestId: hire.id,
    candidateId: firstCandidate(w, hire),
    decidedBy: "u1",
    reason: "",
  });
  const pack = getHire(w.db, hire.id)?.onboarding ?? "";
  expect(pack).toContain("You report to @boss.");
  expect(pack).toContain("WEB: Website");
  expect(pack).toContain("hiring.decision");
  expect(pack).toContain("an answer");
  expect(pack.length).toBeLessThanOrEqual(6000);
});

test("teamLacks is true for a specialty nobody lists", () => {
  const w = hiringWorld();
  expect(teamLacks(w.db, w.teamId, "database")).toBe(true);
  updateMember(w.db, w.boss.id, { specialties: ["database"] });
  expect(teamLacks(w.db, w.teamId, "database")).toBe(false);
});

test("candidateOfRun finds the candidate a run token was minted for", () => {
  const w = hiringWorld();
  const hire = w.file();
  const candidateId = firstCandidate(w, hire);
  w.db
    .query(
      "INSERT INTO run_tokens (hash, run_id, scopes, created_at, candidate_id) VALUES ('h', 'run-1', '[]', 1, ?)",
    )
    .run(candidateId);
  expect(candidateOfRun(w.db, "run-1")).toBe(candidateId);
  expect(candidateOfRun(w.db, "run-2")).toBeNull();
});
