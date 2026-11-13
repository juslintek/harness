import { LOG_KINDS, type OrgLogHit, orgLogHitsSchema } from "@shared/logs";
import { orgDetailSchema } from "@shared/orgs";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { api } from "../../api";
import { isViewerIn, me } from "../../auth/me";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { Button, Help, statusWord } from "../../ui/atoms";
import { Field, QueryChips, State, TableBox } from "../../ui/molecules";
import { latestGuard } from "./latest";
import { LivePanel } from "./live-panel";
import { LogRow } from "./log-row";
import "./logs.css";

const PAGE = 50;
const SUGGESTED = ["deploy", "exit code", "denied", "approval", "migration"];

function HitsTable(props: { slug: string; hits: OrgLogHit[]; admin: boolean }): JSX.Element {
  return (
    <TableBox stack label="Log events">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Member</th>
          <th scope="col">Kind</th>
          <th scope="col">What happened</th>
          <th scope="col">Task and run</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.hits}>
          {(h) => <LogRow slug={props.slug} hit={h} admin={props.admin} />}
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
  const [filters, setFilters] = createSignal(false);
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
  // The server returns nothing for an empty query, so it is never sent.
  const start = (): void => {
    const f = { text: text().trim(), kind: kind(), member: member() };
    if (!f.text) return;
    setSent(f);
    void run(f);
  };
  const pick = (query: string): void => {
    setText(query);
    start();
  };
  const last = (): OrgLogHit | undefined => hits()?.at(-1);
  return (
    <div class="logs">
      <form
        class="logs-form"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div class="field logs-text">
          <label for="logs-q">Search events</label>
          <input
            id="logs-q"
            type="search"
            required
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </div>
        <div class="logs-filters" data-open={filters() ? "" : undefined}>
          <Field label="Kind">
            {(control) => (
              <select
                {...control()}
                value={kind()}
                onChange={(e) => setKind(e.currentTarget.value)}
              >
                <option value="">All kinds</option>
                <For each={LOG_KINDS}>{(k) => <option value={k}>{statusWord(k).word}</option>}</For>
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
                <option value="">All members</option>
                <For each={org.data()?.members ?? []}>
                  {(m) => <option value={m.id}>{m.handle}</option>}
                </For>
              </select>
            )}
          </Field>
        </div>
        <Button type="submit" tone="primary">
          Search logs
        </Button>
        <Button
          class="logs-filters-toggle"
          aria-expanded={filters()}
          onClick={() => setFilters((open) => !open)}
        >
          Filters
        </Button>
      </form>
      <Help>
        Search matches whole words and parts of a command (3 characters or more). Results do not
        update by themselves: press Search again to look again. Agent messages are searched for org
        admins only.
      </Help>
      <Show when={error()}>{(message) => <State kind="error" message={message()} />}</Show>
      <Show
        when={hits()}
        fallback={
          <div class="logs-start">
            <div class="logs-intro">
              <h2>Search what agents did in this organisation</h2>
              <Help>
                Logs hold commands, agent messages, guard decisions, approvals and errors. An empty
                search shows nothing, so type a word, a file name or a command.
              </Help>
              <QueryChips queries={SUGGESTED} onPick={pick} />
            </div>
            <LivePanel admin={admin()} />
          </div>
        }
      >
        {(found) => (
          <Show
            when={found().length > 0}
            fallback={
              <div class="logs-intro">
                <h2>No events match "{sent().text}"</h2>
                <Help>
                  Nothing in this organisation has that word. Words match whole words, so try a
                  shorter one (for example deploy), or search a part of a command with 3 or more
                  characters.
                </Help>
                <QueryChips queries={SUGGESTED.slice(0, 3)} onPick={pick} />
              </div>
            }
          >
            <div class="logs-summary">
              <p class="muted">
                {found().length} {found().length === 1 ? "event" : "events"} for "{sent().text}",
                newest first
              </p>
            </div>
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
