import { useState } from "preact/hooks";
import type { HireView } from "../../../shared/hiring";
import { hireViewSchema } from "../../../shared/hiring";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { isAdmin, useOrg } from "../orgs/org-data";
import { CandidateCard } from "./candidate-card";

const OPEN: HireView["status"][] = [
  "interviewing",
  "followups",
  "answering",
  "scoring",
  "deciding",
];

function Decide({
  hire,
  base,
  onDecided,
}: {
  hire: HireView;
  base: string;
  onDecided: () => void;
}): preact.JSX.Element {
  const [reason, setReason] = useState("");
  const action = useAction();
  const decide = (candidateId: string | null): void => {
    action
      .run(async () => {
        await api(`${base}/decide`, ignored, { method: "POST", body: { candidateId, reason } });
        onDecided();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <section class="card">
      <h3>Decision</h3>
      <label>
        Reason (optional)
        <textarea
          value={reason}
          maxLength={500}
          rows={2}
          onInput={(e) => setReason(e.currentTarget.value)}
        />
      </label>
      <p class="muted">Deciding asks for your passkey.</p>
      <div class="row">
        {hire.candidates.map((c) => (
          <button key={c.id} type="button" disabled={action.busy} onClick={() => decide(c.id)}>
            Hire {c.profile.runtime}
            {c.profile.model ? ` / ${c.profile.model}` : ""}
          </button>
        ))}
        <button type="button" class="danger" disabled={action.busy} onClick={() => decide(null)}>
          Reject all
        </button>
      </div>
      <ErrorLine message={action.error} />
    </section>
  );
}

export function HireDetail({ slug, id }: { slug: string; id: string }): preact.JSX.Element {
  const base = `/api/orgs/${slug}/hires/${id}`;
  const org = useOrg(slug);
  const hire = useLoad(() => api(base, hireViewSchema), [base]);
  const view = hire.data;
  const handleOf = (memberId: string): string =>
    org.data?.members.find((m) => m.id === memberId)?.handle ?? memberId;
  const admin = org.data ? isAdmin(org.data) : false;
  return (
    <section>
      <p>
        <a href={`#/o/${slug}/hiring`}>Back to requests</a>
      </p>
      <ErrorLine message={hire.error ?? org.error} />
      {view ? (
        <>
          <h2>
            {view.spec.title}{" "}
            <span class="badge" data-state={view.status}>
              {view.status}
            </span>
          </h2>
          <p>{view.spec.summary}</p>
          <p class="muted">
            {view.spec.specialty}; task types: {view.spec.taskTypes.join(", ")}
            {view.spec.mustHave.length > 0 && `; must have: ${view.spec.mustHave.join(", ")}`}
          </p>
          {view.decisionReason && <p>Decision: {view.decisionReason}</p>}
          <button type="button" onClick={hire.reload}>
            Refresh
          </button>
          <h3>Candidates</h3>
          <ul class="plain">
            {view.candidates.map((c) => (
              <CandidateCard
                key={c.id}
                hire={view}
                candidate={c}
                base={base}
                canScore={admin && OPEN.includes(view.status)}
                handleOf={handleOf}
                onChange={hire.reload}
              />
            ))}
          </ul>
          {admin && OPEN.includes(view.status) && (
            <Decide hire={view} base={base} onDecided={hire.reload} />
          )}
        </>
      ) : (
        !hire.error && <p class="muted">Loading...</p>
      )}
    </section>
  );
}
