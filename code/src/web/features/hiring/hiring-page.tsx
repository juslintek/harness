import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { OrgGate, useOrg } from "../orgs/org-data";
import { HireDetail } from "./hire-detail";
import { hireListSchema } from "./hire-schemas";
import { NewHire } from "./new-hire";

function HireList({ slug }: { slug: string }): preact.JSX.Element {
  const org = useOrg(slug);
  const hires = useLoad(() => api(`/api/orgs/${slug}/hires`, hireListSchema), [slug]);
  const error = org.error ?? hires.error;
  const teamName = (id: string): string => org.data?.teams.find((t) => t.id === id)?.name ?? id;
  return (
    <section>
      <h2>Hiring</h2>
      <ErrorLine message={error} />
      {org.data && org.data.me.role !== "viewer" && (
        <NewHire detail={org.data} onFiled={hires.reload} />
      )}
      <h3>Requests</h3>
      <button type="button" onClick={hires.reload}>
        Refresh
      </button>
      {hires.data?.length === 0 && <p class="muted">No hiring requests yet.</p>}
      <ul class="plain">
        {hires.data?.map((h) => (
          <li key={h.id} class="card row">
            <span>
              <a href={`#/o/${slug}/hiring/${h.id}`}>
                <strong>{h.spec.title}</strong>
              </a>{" "}
              <span class="muted">
                {teamName(h.teamId)}, {h.spec.specialty}, {fmtTime(h.createdAt)}
              </span>
            </span>
            <span class="badge" data-state={h.status}>
              {h.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HiringPage({ slug, id }: { slug: string; id?: string }): preact.JSX.Element {
  return (
    <OrgGate slug={slug}>
      {() => (id ? <HireDetail slug={slug} id={id} key={id} /> : <HireList slug={slug} />)}
    </OrgGate>
  );
}
