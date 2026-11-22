import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { me } from "../../auth/me";
import { minuteStamp } from "../../format";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { CodeBlock, Field, Notice, Panel, State } from "../../ui/molecules";
import "../distribution/distribution.css";
import {
  isFinished,
  rememberedIds,
  rememberId,
  reviewSchema,
  type UpdateRequestView,
  updateRequestSchema,
  updateTone,
} from "./updates-data";

const POLL_MS = 3000;

function ReviewPanel(props: {
  request: UpdateRequestView;
  onChange: (message: string) => void;
}): JSX.Element {
  const action = createAction();
  const base = `/api/selfupdate/requests/${encodeURIComponent(props.request.id)}`;
  const review = createLoad(`${base}/review`, reviewSchema);

  const decide = (verb: "approve" | "deny"): void => {
    void action.run(async () => {
      await api(`${base}/${verb}`, updateRequestSchema, { method: "POST" });
      props.onChange(verb === "approve" ? "Update approved, pipeline started" : "Update denied");
    });
  };

  return (
    <div class="dist-stack">
      <ErrorLine message={review.error()} />
      <Show when={review.data()}>
        {(data) => (
          <>
            <Help small>
              Pinned commit <code>{data().commitSha}</code>. An approval covers only this commit.
            </Help>
            <div>
              <strong>Flagged paths</strong>
              <Show when={data().flagged.length > 0} fallback={<Help small>None</Help>}>
                <ul>
                  <For each={data().flagged}>
                    {(p) => (
                      <li>
                        <code>{p}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            <CodeBlock label="Diff stat" text={data().stat || "(not available)"} copy={false} />
            <div class="dist-inline">
              <Button tone="primary" disabled={action.busy()} onClick={() => decide("approve")}>
                Approve (passkey)
              </Button>
              <Button tone="danger-quiet" disabled={action.busy()} onClick={() => decide("deny")}>
                Deny
              </Button>
            </div>
          </>
        )}
      </Show>
      <ErrorLine message={action.error()} />
    </div>
  );
}

function RequestForm(props: { onCreated: (r: UpdateRequestView) => void }): JSX.Element {
  const action = createAction();
  const [repo, setRepo] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const created = await api("/api/selfupdate/requests", updateRequestSchema, {
        method: "POST",
        body: { repo: repo().trim(), branch: branch().trim() },
      });
      rememberId(created.id);
      props.onCreated(created);
    });
  };
  return (
    <Panel title="Request update">
      <div class="dist-stack">
        <form class="dist-row" onSubmit={submit}>
          <Field label="Repository path">
            {(ctrl) => (
              <input
                {...ctrl()}
                value={repo()}
                required
                onInput={(e) => setRepo(e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Branch">
            {(ctrl) => (
              <input
                {...ctrl()}
                value={branch()}
                required
                onInput={(e) => setBranch(e.currentTarget.value)}
              />
            )}
          </Field>
          <Button type="submit" tone="primary" disabled={action.busy()}>
            Request update
          </Button>
        </form>
        <ErrorLine message={action.error()} />
      </div>
    </Panel>
  );
}

async function loadAll(ids: string[]): Promise<UpdateRequestView[]> {
  const loaded = await Promise.all(
    ids.map((id) =>
      api(`/api/selfupdate/requests/${encodeURIComponent(id)}`, updateRequestSchema).catch(
        () => null,
      ),
    ),
  );
  return loaded.filter((r): r is UpdateRequestView => r !== null);
}

function UpdatesBody(): JSX.Element {
  const [status, setStatus] = createSignal<string | null>(null);
  const [requests, setRequests] = createSignal<UpdateRequestView[]>([]);
  const [tick, setTick] = createSignal(0);

  createEffect(() => {
    tick();
    let live = true;
    void loadAll(rememberedIds()).then((all) => {
      if (live) setRequests(all);
    });
    onCleanup(() => {
      live = false;
    });
  });

  createEffect(() => {
    const busy = requests().some((r) => !isFinished(r.status) && r.status !== "awaiting_approval");
    if (!busy) return;
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const changed = (message: string): void => {
    setStatus(message);
    setTick((n) => n + 1);
  };

  return (
    <div class="dist-page">
      <h1>Updates</h1>
      <Help>
        Update this instance from a branch. The pipeline checks, builds and verifies the new binary
        on a copy of the data, then swaps, and rolls back if the new version does not answer.
        Changes to guard, auth or sandbox code wait here for your approval.
      </Help>
      <Show when={status()}>
        {(msg) => (
          <Notice tone="success" title="Updated">
            {msg()}
          </Notice>
        )}
      </Show>
      <RequestForm onCreated={(r) => changed(`Update request for ${r.branch} created`)} />
      <Show
        when={requests().length > 0}
        fallback={
          <Panel title="Requests">
            <Help small>No update requests from this browser yet.</Help>
          </Panel>
        }
      >
        <For each={requests()}>
          {(req) => (
            <Panel
              title={`${req.branch} · ${req.repo}`}
              actions={<StatusBadge tone={updateTone(req.status)} value={req.status} />}
            >
              <div class="dist-stack">
                <Help small>
                  {minuteStamp(req.createdAt)} · <code>{req.commitSha.slice(0, 12)}</code>
                  {req.reason ? ` · ${req.reason}` : ""}
                </Help>
                <Show when={req.status === "awaiting_approval"}>
                  <ReviewPanel request={req} onChange={changed} />
                </Show>
              </div>
            </Panel>
          )}
        </For>
      </Show>
    </div>
  );
}

export function UpdatesPage(): JSX.Element {
  return (
    <Show
      when={me()?.user.instanceAdmin === true}
      fallback={<State kind="empty" message="Not available." />}
    >
      <UpdatesBody />
    </Show>
  );
}
