import { type OrgDetail, orgDetailSchema } from "../../../shared/orgs";
import { api, type Loaded, useLoad } from "../../api";
import { me } from "../auth/me";

export const useOrg = (slug: string): Loaded<OrgDetail> =>
  useLoad(() => api(`/api/orgs/${slug}`, orgDetailSchema), [slug]);

// Org routes only make sense for orgs the user belongs to; anything else never reaches the API.
export function OrgGate({
  slug,
  children,
}: {
  slug: string;
  children: (org: { id: string; slug: string; name: string }) => preact.JSX.Element;
}): preact.JSX.Element {
  const org = me.value?.orgs.find((o) => o.slug === slug);
  return org ? children(org) : <p class="muted">Org not found</p>;
}

export const isAdmin = (detail: OrgDetail): boolean =>
  detail.me.role === "owner" || detail.me.role === "admin";
