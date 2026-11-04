import { useRef, useState } from "preact/hooks";
import { LOG_KINDS, type OrgLogHit, orgLogHitsSchema } from "../../../shared/logs";
import { api } from "../../api";
import { errorText, fmtTime } from "../../format";
import { me } from "../auth/me";
import { useOrg } from "../orgs/org-data";
import { latestGuard } from "./latest";

const PAGE = 50;

function link(slug: string, hit: OrgLogHit, admin: boolean): preact.JSX.Element | null {
  if (hit.projectId && hit.taskNumber) {
    return <a href={`#/o/${slug}/board/${hit.projectId}/${hit.taskNumber}`}>Task</a>;
  }
  return admin && hit.runId ? <a href={`#/runs/${hit.runId}`}>Run</a> : null;
}

function HitsTable({
  slug,
  hits,
  admin,
}: {
  slug: string;
  hits: OrgLogHit[];
  admin: boolean;
}): preact.JSX.Element {
  return (
    <table class="stack">
      <thead>
        <tr>
          <th>Time</th>
          <th>Member</th>
          <th>Kind</th>
          <th>Snippet</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {hits.map((h) => (
          <tr key={h.rowid}>
            <td data-label="Time">{fmtTime(h.ts)}</td>
            <td data-label="Member">{h.memberHandle}</td>
            <td data-label="Kind">{h.kind}</td>
            <td data-label="Snippet">
              <pre class="log-snippet">{h.snippet}</pre>
            </td>
            <td>{link(slug, h, admin)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LogsPage({ slug }: { slug: string }): preact.JSX.Element {
  const org = useOrg(slug);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [member, setMember] = useState("");
  const [sent, setSent] = useState({ text: "", kind: "", member: "" });
  const [hits, setHits] = useState<OrgLogHit[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(latestGuard());
  const admin = me.value?.user.instanceAdmin === true;

  const run = async (f: typeof sent, after?: OrgLogHit): Promise<void> => {
    const qs = new URLSearchParams({ q: f.text });
    if (f.kind) qs.set("kind", f.kind);
    if (f.member) qs.set("member", f.member);
    if (after) {
      qs.set("before", String(after.ts));
      qs.set("beforeRowid", String(after.rowid));
    }
    const current = guard.current();
    try {
      const page = await api(`/api/orgs/${slug}/logs/search?${qs}`, orgLogHitsSchema);
      if (!current()) return;
      setHits((prev) => (after === undefined ? page : [...(prev ?? []), ...page]));
      setMore(page.length >= PAGE);
      setError(null);
    } catch (err) {
      if (current()) setError(errorText(err));
    }
  };
  const last = hits?.at(-1);
  return (
    <section class="logs-page">
      <h2>Logs</h2>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          const f = { text, kind, member };
          setSent(f);
          void run(f);
        }}
      >
        <label>
          Search
          <input
            type="search"
            value={text}
            required
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
            <option value="">All</option>
            {LOG_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Member
          <select value={member} onChange={(e) => setMember(e.currentTarget.value)}>
            <option value="">All</option>
            {(org.data?.members ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.handle}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Search logs</button>
      </form>
      {error && <p class="error">{error}</p>}
      {hits?.length === 0 && <p class="muted">No log events match.</p>}
      {hits && hits.length > 0 && <HitsTable slug={slug} hits={hits} admin={admin} />}
      {more && last && (
        <button type="button" onClick={() => void run(sent, last)}>
          Older
        </button>
      )}
    </section>
  );
}
