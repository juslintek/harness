import { canDecideApprovals, isViewerIn, me } from "../../auth/me";
import { selectedSlug } from "../../orgs";
import type { Target } from "./playbooks-data";

// The same visibility rules as the sidebar: a button never leads to a screen the person cannot open.
export function hrefFor(to: Target): string | null {
  const current = me();
  if (!current) return null;
  const slug = selectedSlug();
  const org = (page: string): string | null => (slug ? `#/o/${slug}/${page}` : null);
  switch (to) {
    case "now":
      return "#/now";
    case "marketing":
      return "#/playbooks/marketing";
    case "runs":
      return current.user.instanceAdmin ? "#/runs" : null;
    case "approvals":
      return canDecideApprovals(current) ? "#/approvals" : null;
    case "logs":
      return slug && isViewerIn(current, slug) ? null : org("logs");
    case "usage":
      return org("dashboard");
    case "hire-writing":
      return org("hiring?specialty=writing");
    default:
      return org(to);
  }
}
