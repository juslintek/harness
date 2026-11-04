import { useState } from "preact/hooks";
import type { OrgDetail } from "../../../shared/orgs";
import { useTopic } from "../../api";
import { routeParts } from "../../route";
import { ErrorLine } from "../auth/error-line";
import { isAdmin, OrgGate, useOrg } from "../orgs/org-data";
import { LessonsPanel } from "./lessons-panel";
import { TABS, tabOf } from "./memory-data";
import { NotesPane } from "./notes-pane";
import { WritesPanel } from "./writes-panel";

const LABELS = { notes: "Notes", writes: "Writes", review: "Review" } as const;

function Memory({ detail }: { detail: OrgDetail }): preact.JSX.Element {
  const slug = detail.org.slug;
  const parts = routeParts();
  const tab = tabOf(parts[3]);
  const [version, setVersion] = useState(0);
  useTopic(`org:${detail.org.id}`, (m) => {
    if (m === null || m.type === "memory") setVersion((v) => v + 1);
  });
  return (
    <section class="memory-page">
      <h2>Memory</h2>
      <nav class="memory-tabs" aria-label="Memory sections">
        {TABS.map((t) => (
          <a key={t} href={`#/o/${slug}/memory/${t}`} aria-current={t === tab ? "page" : undefined}>
            {LABELS[t]}
          </a>
        ))}
      </nav>
      {tab === "notes" && <NotesPane detail={detail} version={version} selectedId={parts[4]} />}
      {tab === "writes" && <WritesPanel slug={slug} version={version} />}
      {tab === "review" && (
        <LessonsPanel detail={detail} admin={isAdmin(detail)} version={version} />
      )}
    </section>
  );
}

function Loaded({ slug }: { slug: string }): preact.JSX.Element {
  const detail = useOrg(slug);
  if (detail.data) return <Memory detail={detail.data} />;
  return detail.error ? <ErrorLine message={detail.error} /> : <p class="muted">Loading...</p>;
}

export function MemoryPage({ slug }: { slug: string }): preact.JSX.Element {
  return <OrgGate slug={slug}>{() => <Loaded slug={slug} />}</OrgGate>;
}
