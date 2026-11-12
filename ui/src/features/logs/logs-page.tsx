import { LOG_KINDS, type OrgLogHit, orgLogHitsSchema } from "@shared/logs";
import { orgDetailSchema } from "@shared/orgs";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { api } from "../../api";
import { isViewerIn, me } from "../../auth/me";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { TableBox } from "../../ui/data-table";
import { Button, Field, Panel, State } from "../../ui/primitives";
import { latestGuard } from "./latest";
import "./logs.css";

const PAGE = 50;

function link(slug: string, hit: OrgLogHit, admin: boolean): JSX.Element {
  if (hit.projectId && hit.taskNumber) {
    return <a href={`#/o/${slug}/board/${hit.projectId}/${hit.taskNumber}`}>Task</a>;
  }
  // The run page is for instance admins only.
  return admin && hit.runId ? <a href={`#/runs/${hit.runId}`}>Run</a> : null;
}

function HitsTable(props: { slug: string; hits: OrgLogHit[]; admin: boolean }): JSX.Element {
  return (
    <TableBox label="Log events">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Member</th>
          <th scope="col">Kind</th>
          <th scope="col">Snippet</th>
          <th scope="col">
            <span class="sr-only">Link</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={props.hits}>
          {(h) => (
            <tr>
              <td class="muted">{new Date(h.ts).toLocaleString()}</td>
              <td class="logs-plain">{h.memberHandle}</td>
              <td>{h.kind}</td>
              <td>
                <pre class="logs-snippet">{h.snippet}</pre>
              </td>
              <td class="logs-plain">{link(props.slug, h, props.admin)}</td>
            </tr>
          )}
        </For>
      </tbody>
    </TableBox>
  );
}

function LogsSearch(props: { slug: string }): JSX.Element {
  const org = createLoad(`/api/orgs/${props.slug}`, orgDetailSchema);
  const [text, setText] = createSignal("");
  const [kind, setKind] = createSignal("");
  const [member, setMember] = createSignal("");
  const [sent, setSent] = createSignal({ text: "", kind: "", member: "" });
  const [hits, setHits] = createSignal<OrgLogHit[]>();
  const [more, setMore] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const next = latestGuard();
  const admin = (): boolean => me()?.user.instanceAdmin === true;

  const run = async (f: ReturnType<typeof sent>, after?: OrgLogHit): Promise<void> => {
    const qs = new URLSearchParams({ q: f.text });
    if (f.kind) qs.set("kind", f.kind);
    if (f.member) qs.set("member", f.member);
    if (after) {
      qs.set("before", String(after.ts));
      qs.set("beforeRowid", String(after.rowid));
    }
    const current = next();
    try {
      const page = await api(`/api/orgs/${props.slug}/logs/search?${qs}`, orgLogHitsSchema);
      if (!current()) return;
      setHits((prev) => (after === undefined ? page : [...(prev ?? []), ...page]));
      setMore(page.length >= PAGE);
      setError(null);
    } catch (err) {
      if (current()) setError(errorText(err));
    }
  };
  const last = (): OrgLogHit | undefined => hits()?.at(-1);
  return (
    <div class="logs">
      <Panel title="Search">
        <form
          class="logs-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = { text: text(), kind: kind(), member: member() };
            setSent(f);
            void run(f);
          }}
        >
          <div class="field logs-text">
            <label for="logs-q">Search</label>
            <input
              id="logs-q"
              type="search"
              required
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
          </div>
          <Field label="Kind">
            {(control) => (
              <select
                {...control()}
                value={kind()}
                onChange={(e) => setKind(e.currentTarget.value)}
              >
                <option value="">All</option>
                <For each={LOG_KINDS}>{(k) => <option value={k}>{k}</option>}</For>
              </select>
            )}
          </Field>
          <Field label="Member">
            {(control) => (
              <select
                {...control()}
                value={member()}
                onChange={(e) => setMember(e.currentTarget.value)}
              >
                <option value="">All</option>
                <For each={org.data()?.members ?? []}>
                  {(m) => <option value={m.id}>{m.handle}</option>}
                </For>
              </select>
            )}
          </Field>
          <Button type="submit" tone="primary">
            Search logs
          </Button>
        </form>
      </Panel>
      <Show when={error()}>{(message) => <State kind="error" message={message()} />}</Show>
      <Show when={hits()} fallback={<p class="logs-hint">Search the events of this org.</p>}>
        {(found) => (
          <Show
            when={found().length > 0}
            fallback={<State kind="empty" message="No log events match." />}
          >
            <HitsTable slug={props.slug} hits={found()} admin={admin()} />
          </Show>
        )}
      </Show>
      <Show when={more() ? last() : undefined}>
        {(tail) => (
          <div>
            <Button onClick={() => void run(sent(), tail())}>Older</Button>
          </div>
        )}
      </Show>
    </div>
  );
}

type Access = "none" | "viewer" | "ok";

export function LogsPage(props: { slug: string }): JSX.Element {
  const access = (): Access => {
    const current = me();
    if (!current?.orgs.some((o) => o.slug === props.slug)) return "none";
    return isViewerIn(current, props.slug) ? "viewer" : "ok";
  };
  return (
    <Switch>
      <Match when={access() === "none"}>
        <State kind="empty" message="Org not found" />
      </Match>
      <Match when={access() === "viewer"}>
        <State kind="empty" title="Logs" message="Logs are not available for viewers." />
      </Match>
      <Match when={access() === "ok"}>
        <LogsSearch slug={props.slug} />
      </Match>
    </Switch>
  );
}
