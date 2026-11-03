import { useState } from "preact/hooks";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad, useTopic } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { isAdmin, OrgGate, useOrg } from "../orgs/org-data";
import { Budgets } from "./budgets";
import { effectiveListSchema } from "./policies-data";
import { PolicyRow } from "./policy-row";
import { Proposals } from "./proposals";
import { type Scope, ScopePicker } from "./scope-picker";

function Effective({ detail, scope }: { detail: OrgDetail; scope: Scope }): preact.JSX.Element {
  const slug = detail.org.slug;
  const list = useLoad(
    () => api(`/api/orgs/${slug}/policies${scope.query}`, effectiveListSchema),
    [slug, scope.layer, scope.targetId],
  );
  useTopic(`org:${detail.org.id}`, () => list.reload());
  return (
    <>
      <ErrorLine message={list.error} />
      <ul class="plain">
        {list.data?.map((item) => (
          <PolicyRow key={item.key} item={item} scope={scope} slug={slug} onChanged={list.reload} />
        ))}
      </ul>
    </>
  );
}

function Policies({ detail }: { detail: OrgDetail }): preact.JSX.Element {
  const [scope, setScope] = useState<Scope | null>(null);
  if (!isAdmin(detail)) return <p class="muted">Policies are visible to org admins.</p>;
  return (
    <section>
      <h2>Policies</h2>
      <p class="muted">
        Each value comes from the strictest layer that sets it. Autonomy can only get stricter going
        down the layers.
      </p>
      <ScopePicker detail={detail} onScope={setScope} />
      {scope && <Effective detail={detail} scope={scope} />}
      <Proposals detail={detail} />
      <Budgets detail={detail} />
    </section>
  );
}

function Loaded({ slug }: { slug: string }): preact.JSX.Element {
  const detail = useOrg(slug);
  if (detail.data) return <Policies detail={detail.data} />;
  return detail.error ? <ErrorLine message={detail.error} /> : <p class="muted">Loading...</p>;
}

export function PoliciesPage({ slug }: { slug: string }): preact.JSX.Element {
  return <OrgGate slug={slug}>{() => <Loaded slug={slug} />}</OrgGate>;
}
