import type { Database } from "bun:sqlite";
import type { HireView, RoleSpec } from "../../shared/hiring";
import type { SelfCard } from "../../shared/profiles";
import { migrate, openDb } from "../db/db";
import { migrations } from "../db/migrations";
import {
  candidateRunEnded,
  fileRequest,
  type HiringDeps,
  recordAnswer,
} from "../features/hiring/api";
import {
  addAgentMember,
  addToTeam,
  createOrg,
  createPosition,
  listTeams,
  type MemberRow,
} from "../features/orgs/api";
import { submitCard } from "../features/profiles/api";

const spec: RoleSpec = {
  title: "Backend Engineer",
  specialty: "backend",
  summary: "own the billing API",
  mustHave: ["typescript", "sql"],
  taskTypes: ["feature", "bugfix"],
};

const goodCard: SelfCard = {
  summary: "Backend dev",
  specialties: ["backend"],
  strengths: ["sql"],
  limits: ["no frontend"],
  preferredTaskTypes: ["feature"],
};

interface Wake {
  memberId: string;
  reason: string;
  detail: object;
  causedBy: string;
}

export interface HiringWorld {
  db: Database;
  orgId: string;
  teamId: string;
  boss: MemberRow;
  deps: HiringDeps;
  interviews: { candidateId: string; questionIds: string[] }[];
  wakes: Wake[];
  clock: { now: number };
  agent: (handle: string, inTeam?: boolean) => MemberRow;
  file: (requestedBy?: string) => HireView;
  // Every candidate answers all its open questions; only the ones in `withCard` submit a valid card.
  answerAll: (hire: HireView, withCard?: number[]) => void;
}

function stubDeps(
  interviews: HiringWorld["interviews"],
  wakes: Wake[],
  clock: { now: number },
): HiringDeps {
  return {
    pickEngines: ({ max }) =>
      [
        { runtime: "claude", model: null },
        { runtime: "codex", model: null },
      ].slice(0, max),
    engineReady: () => true,
    startInterview: (candidateId, questionIds) => interviews.push({ candidateId, questionIds }),
    wake: (memberId, reason, detail, causedBy) =>
      wakes.push({ memberId, reason, detail, causedBy }),
    now: () => clock.now,
  };
}

export function hiringWorld(): HiringWorld {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const teamId = listTeams(db, org.id)[0]?.id as string;
  const agent = (handle: string, inTeam = true): MemberRow => {
    const m = addAgentMember(db, org.id, {
      agentId: "claude",
      handle,
      displayName: handle,
      specialties: [],
    });
    if (inTeam) addToTeam(db, teamId, m.id);
    return m;
  };
  const boss = agent("boss");
  createPosition(db, { orgId: org.id, teamId, title: "Lead", memberId: boss.id, isManager: true });
  const interviews: HiringWorld["interviews"] = [];
  const wakes: Wake[] = [];
  const clock = { now: 1_000_000 };
  const deps = stubDeps(interviews, wakes, clock);
  const file = (requestedBy = boss.id): HireView =>
    fileRequest(db, deps, { orgId: org.id, teamId, requestedBy, spec });
  const answerAll = (hire: HireView, withCard: number[] = [0, 1]): void => {
    hire.candidates.forEach((c, i) => {
      if (withCard.includes(i)) submitCard(db, c.profile.id, goodCard);
      const open = interviews.filter((v) => v.candidateId === c.id).at(-1)?.questionIds ?? [];
      for (const q of open) recordAnswer(db, c.id, q, "an answer", null);
      candidateRunEnded(db, deps, c.id, true);
    });
  };
  return {
    db,
    orgId: org.id,
    teamId,
    boss,
    deps,
    interviews,
    wakes,
    clock,
    agent,
    file,
    answerAll,
  };
}
