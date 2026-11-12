import { canDecideApprovals, isViewerIn, me } from "../auth/me";
import { selectedSlug } from "../orgs";
import { routeParts } from "../route";

export interface NavItem {
  key: string;
  label: string;
  href: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

// Which items exist follows the old header: org pages need an org, Logs hides from viewers,
// Approvals needs a deciding role, the instance pages are for instance admins.
export function navGroups(): NavGroup[] {
  const current = me();
  if (!current) return [];
  const slug = selectedSlug();
  const org = (key: string, label: string): NavItem[] =>
    slug ? [{ key, label, href: `#/o/${slug}/${key}` }] : [];
  const global = (key: string, label: string): NavItem => ({ key, label, href: `#/${key}` });
  const admin = current.user.instanceAdmin;
  const groups: NavGroup[] = [
    {
      title: "Work",
      items: [...org("board", "Board"), ...org("chat", "Chat"), ...org("memory", "Memory")],
    },
    {
      title: "Oversight",
      items: [
        ...(canDecideApprovals(current) ? [global("approvals", "Approvals")] : []),
        ...org("dashboard", "Dashboard"),
        ...(slug && isViewerIn(current, slug) ? [] : org("logs", "Logs")),
      ],
    },
    {
      title: "Organisation",
      items: [
        ...org("hiring", "Hiring"),
        ...org("policies", "Policies"),
        ...org("settings", "Settings"),
      ],
    },
    {
      title: "Instance",
      items: admin
        ? [
            global("runs", "Runs"),
            global("agents", "Agents"),
            global("search", "Search"),
            global("integrations", "Integrations"),
          ]
        : [],
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// "#/" is the runs list for an instance admin and the board for everyone else, as before.
export function currentKey(): string {
  const parts = routeParts();
  if (parts[0] === "o" && parts[1]) return parts[2] ?? "board";
  return parts[0] ?? (me()?.user.instanceAdmin ? "runs" : "board");
}

export function pageTitle(): string {
  const key = currentKey();
  if (key === "account") return "Account";
  return (
    navGroups()
      .flatMap((g) => g.items)
      .find((i) => i.key === key)?.label ?? "Harness"
  );
}
