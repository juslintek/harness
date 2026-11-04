import { useState } from "preact/hooks";
import type { HireView } from "../../../shared/hiring";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

export type Candidate = HireView["candidates"][number];

const CRITERIA = ["fit", "depth", "honesty"] as const;
const SCALE = [1, 2, 3, 4, 5];

function ScoreForm({
  base,
  candidate,
  onSaved,
}: {
  base: string;
  candidate: Candidate;
  onSaved: () => void;
}): preact.JSX.Element {
  const [marks, setMarks] = useState({ fit: 3, depth: 3, honesty: 3 });
  const [notes, setNotes] = useState("");
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        await api(`${base}/score/${candidate.id}`, ignored, {
          method: "POST",
          body: { ...marks, notes },
        });
        setNotes("");
        onSaved();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form onSubmit={submit}>
      <div class="row">
        {CRITERIA.map((name) => (
          <label key={name}>
            {name} (1 to 5)
            <select
              value={marks[name]}
              onChange={(e) => setMarks({ ...marks, [name]: Number(e.currentTarget.value) })}
            >
              {SCALE.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label>
        Notes
        <textarea
          value={notes}
          maxLength={1000}
          rows={2}
          onInput={(e) => setNotes(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Save scorecard
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

function Answers({
  hire,
  candidate,
}: {
  hire: HireView;
  candidate: Candidate;
}): preact.JSX.Element {
  const asked = hire.questions.filter(
    (q) => q.candidateId === null || q.candidateId === candidate.id,
  );
  const answerOf = (id: string): string | undefined =>
    candidate.answers.find((a) => a.questionId === id)?.body;
  return (
    <dl class="answers">
      {asked.map((q) => (
        <div key={q.id}>
          <dt>{q.body}</dt>
          <dd>{answerOf(q.id) ?? <span class="muted">no answer yet</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Card({ candidate }: { candidate: Candidate }): preact.JSX.Element {
  const card = candidate.profile.card;
  if (!card) return <p class="muted">No self card submitted.</p>;
  return (
    <dl class="answers">
      <dt>Summary</dt>
      <dd>{card.summary}</dd>
      <dt>Specialties</dt>
      <dd>{card.specialties.join(", ") || "none"}</dd>
      <dt>Strengths</dt>
      <dd>{card.strengths.join(", ") || "none"}</dd>
      <dt>Limits</dt>
      <dd>{card.limits.join(", ")}</dd>
      <dt>Preferred task types</dt>
      <dd>{card.preferredTaskTypes.join(", ")}</dd>
    </dl>
  );
}

export function CandidateCard({
  hire,
  candidate,
  base,
  canScore,
  handleOf,
  onChange,
}: {
  hire: HireView;
  candidate: Candidate;
  base: string;
  canScore: boolean;
  handleOf: (memberId: string) => string;
  onChange: () => void;
}): preact.JSX.Element {
  const { profile } = candidate;
  return (
    <li class="card candidate">
      <h4>
        {profile.runtime}
        {profile.model ? ` / ${profile.model}` : ""}{" "}
        <span class="badge" data-state={candidate.status}>
          {candidate.status}
        </span>
      </h4>
      <p>
        System score: {candidate.systemScore?.toFixed(1) ?? "not scored"}. Total:{" "}
        {candidate.total?.toFixed(1) ?? "not yet"}.
      </p>
      <h5>Answers</h5>
      <Answers hire={hire} candidate={candidate} />
      <h5>Self card</h5>
      <Card candidate={candidate} />
      <h5>Scorecards</h5>
      {candidate.scorecards.length === 0 && <p class="muted">No scorecards yet.</p>}
      <ul class="plain">
        {candidate.scorecards.map((s) => (
          <li key={s.scorerId}>
            @{handleOf(s.scorerId)}: fit {s.fit}, depth {s.depth}, honesty {s.honesty}
            {s.notes && <span class="muted"> ({s.notes})</span>}
          </li>
        ))}
      </ul>
      {canScore && <ScoreForm base={base} candidate={candidate} onSaved={onChange} />}
    </li>
  );
}
