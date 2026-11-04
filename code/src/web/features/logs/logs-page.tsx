import { useState } from "preact/hooks";
import { LOG_KINDS, type OrgLogHit, orgLogHitsSchema } from "../../../shared/logs";
import { api } from "../../api";
import { errorText, fmtTime } from "../../format";
import { me } from "../auth/me";
import { useOrg } from "../orgs/org-data";

const PAGE = 50;

function link(slug: string, hit: OrgLogHit, admin: boolean): preact.JSX.Element | null {
  if (hit.projectId && hit.taskNumber) {
    return <a href={`#/o/${slug}/board/${hit.projectId}/${hit.taskNumber}`}>Task</a>;
  }
  return admin && hit.runId ? <a href={`#/runs/${hit.runId}`}>Run</a> : null;
}

export function LogsPage({ slug }: { slug: string }): preact.JSX.Element {
  const org = useOrg(slug);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [member, setMember] = useState("");
  const [hits, setHits] = useState<OrgLogHit[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = me.value?.user.instanceAdmin === true;

  const run = async (before?: number): Promise<void> => {
    const qs = new URLSearchParams({ q: text });
    if (kind) qs.set("kind", kind);
    if (member) qs.set("member", member);
    if (before !== undefined) qs.set("before", String(before));
    try {
      const page = await api(`/api/orgs/${slug}/logs/search?${qs}`, orgLogHitsSchema);
      setHits(before === undefined ? page : [...(hits ?? []), ...page]);
      setMore(page.length >= PAGE);
      setError(null);
    } catch (err) {
      setError(errorText(err));
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
          void run();
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
      {hits && hits.length > 0 && (
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
      )}
      {more && last && (
        <button type="button" onClick={() => void run(last.ts)}>
          Older
        </button>
      )}
    </section>
  );
}
