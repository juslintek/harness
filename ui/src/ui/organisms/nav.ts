import { createEffect, createSignal, onCleanup } from "solid-js";
import { canDecideApprovals, isViewerIn, me } from "../../auth/me";
import { selectedSlug } from "../../orgs";
import { routeParts } from "../../route";

export interface NavEntry {
  key: string;
  label: string;
  href: string;
}

export interface NavGroup {
  // Empty for the group without a heading.
  title: string;
  items: NavEntry[];
}

// Which items exist: org pages need an org, Logs hides from viewers, Approvals needs a deciding
// role, Runs and the Instance group are for instance admins.
export function navGroups(): NavGroup[] {
  const current = me();
  if (!current) return [];
  const slug = selectedSlug();
  const org = (key: string, label: string): NavEntry[] =>
    slug ? [{ key, label, href: `#/o/${slug}/${key}` }] : [];
  const global = (key: string, label: string): NavEntry => ({ key, label, href: `#/${key}` });
  const admin = current.user.instanceAdmin;
  const groups: NavGroup[] = [
    { title: "", items: [global("now", "Now")] },
    {
      title: "Work",
      items: [...org("board", "Board"), ...org("chat", "Chat"), ...org("memory", "Memory")],
    },
    {
      title: "Monitor",
      items: [
        ...(canDecideApprovals(current) ? [global("approvals", "Approvals")] : []),
        ...(admin ? [global("runs", "Runs")] : []),
        ...(slug && isViewerIn(current, slug) ? [] : org("logs", "Logs")),
      ],
    },
    { title: "Reports", items: org("dashboard", "Usage & budgets") },
    {
      title: "Organisation",
      items: [
        ...org("hiring", "Hiring"),
        ...org("policies", "Policies"),
        ...org("settings", "Settings"),
      ],
    },
    { title: "Guides", items: [global("playbooks", "Playbooks")] },
    {
      title: "Instance",
      items: admin
        ? [
            global("agents", "Agent CLIs"),
            global("integrations", "Integrations"),
            global("search", "Search"),
          ]
        : [],
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

const KNOWN = new Set([
  "now",
  "account",
  "approvals",
  "runs",
  "playbooks",
  "agents",
  "integrations",
  "search",
  "board",
  "chat",
  "memory",
  "logs",
  "dashboard",
  "hiring",
  "policies",
  "settings",
]);

// "#/" and an unknown hash both show Now.
export function currentKey(): string {
  const parts = routeParts();
  const key = parts[0] === "o" && parts[1] ? (parts[2] ?? "board") : parts[0];
  return key && KNOWN.has(key) ? key : "now";
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

// A detail page that knows a better name than its id (a hire's position title) sets it here. It
// clears itself when the page goes, and the id shows until the name has loaded.
const [crumbName, setCrumbName] = createSignal<string | null>(null);
export function useCrumbName(name: () => string | undefined): void {
  createEffect(() => setCrumbName(name() ?? null));
  onCleanup(() => setCrumbName(null));
}

// A detail view ("Runs / r_4f2a9c") shows its list as a link before the id. A guide is a name, not
// an id, so it reads "Playbooks / Marketing" in the body font.
export function breadcrumb(): { parent: NavEntry; id: string; plain: boolean } | null {
  const parts = routeParts();
  const key = currentKey();
  const id = parts[0] === "o" ? parts[3] : parts[1];
  if (!id || (key !== "runs" && key !== "approvals" && key !== "hiring" && key !== "playbooks"))
    return null;
  const parent = navGroups()
    .flatMap((g) => g.items)
    .find((i) => i.key === key);
  const named = crumbName();
  const plain = key === "playbooks" || named !== null;
  if (!parent) return null;
  return {
    parent,
    id: named ?? (plain ? id.charAt(0).toUpperCase() + id.slice(1) : id),
    plain,
  };
}
