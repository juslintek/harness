import { type AccountView, accountView } from "@shared/accounts";
import {
  type AccountRowView,
  addAccountWithLogin,
  type JsonCaller,
  mapAccountRows,
  removeAccountConfirmed,
} from "@shared/accounts-ui";
import { accountLoginSchema, type QuotaRow } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, Meter, StatusBadge } from "../../ui/atoms";
import { ConfirmButton, Field, Panel, TableBox } from "../../ui/molecules";

const anySchema = z.unknown();
const addCall: JsonCaller = (path, init) =>
  path.endsWith("/login") ? api(path, accountLoginSchema, init) : api(path, accountView, init);
const deleteCall: JsonCaller = (path, init) => api(path, anySchema, init);

function stateTone(row: AccountRowView): "success" | "warning" | "danger" | "neutral" {
  if (row.exhausted) return "danger";
  if (row.state === "active") return "success";
  if (row.state === "logged_out" || row.state === "probe_failed") return "warning";
  return "neutral";
}

function AccountRow(props: { row: AccountRowView; reload: () => void }): JSX.Element {
  const testAct = createAction();
  const toggleAct = createAction();
  const removeAct = createAction();
  const busy = () => testAct.busy() || toggleAct.busy() || removeAct.busy();
  const err = () => testAct.error() ?? toggleAct.error() ?? removeAct.error();

  return (
    <tr>
      <th scope="row">
        {props.row.label}{" "}
        <Show when={props.row.isDefault}>
          <span class="muted">(default)</span>
        </Show>
      </th>
      <td data-label="State">
        <StatusBadge
          tone={stateTone(props.row)}
          value={props.row.exhausted ? `${props.row.state} (exhausted)` : props.row.state}
        />
      </td>
      <td data-label="Identity">{props.row.identityHint ?? "–"}</td>
      <td data-label="Quota">
        <Show when={!props.row.quotaUnknown} fallback={<span class="muted">unknown</span>}>
          <div class="acct-meters">
            <For each={props.row.windows}>
              {(w) => (
                <Meter
                  tone={
                    w.usedPercent >= 90 ? "danger" : w.usedPercent >= 70 ? "warning" : "success"
                  }
                  label={w.window}
                  value={`${Math.round(w.usedPercent)}% (${w.ageLabel})`}
                  pct={w.usedPercent}
                />
              )}
            </For>
          </div>
        </Show>
      </td>
      <td data-label="Actions">
        <div class="cli-actions">
          <Button
            size="sm"
            disabled={busy()}
            onClick={() =>
              void testAct.run(async () => {
                await api(
                  `/api/agents/${encodeURIComponent(props.row.runtime)}/accounts/${encodeURIComponent(props.row.id)}/test`,
                  accountView,
                  {
                    method: "POST",
                    body: {},
                  },
                );
                props.reload();
              })
            }
          >
            Test
          </Button>
          <Button
            size="sm"
            disabled={busy()}
            onClick={() =>
              void toggleAct.run(async () => {
                await api(
                  `/api/agents/${encodeURIComponent(props.row.runtime)}/accounts/${encodeURIComponent(props.row.id)}`,
                  accountView,
                  {
                    method: "PATCH",
                    body: { enabled: !props.row.enabled },
                  },
                );
                props.reload();
              })
            }
          >
            {props.row.enabled ? "Disable" : "Enable"}
          </Button>
          <Show when={!props.row.isDefault}>
            <ConfirmButton
              size="sm"
              text="Remove"
              title={`Remove ${props.row.label}?`}
              message={`Remove account "${props.row.label}" from ${props.row.runtime} and delete its local credential directory?`}
              confirm="Remove account"
              disabled={busy()}
              onConfirm={() =>
                void removeAct.run(async () => {
                  await removeAccountConfirmed(
                    deleteCall,
                    props.row.runtime,
                    props.row.id,
                    true,
                    false,
                  );
                  props.reload();
                })
              }
            />
          </Show>
        </div>
        <Show when={err()}>
          {(m) => (
            <p class="error" role="alert">
              {m()}
            </p>
          )}
        </Show>
      </td>
    </tr>
  );
}

function AddAccountRow(props: { runtime: string; onAdded: () => void }): JSX.Element {
  const [label, setLabel] = createSignal("");
  const [command, setCommand] = createSignal<string | null>(null);
  const [loginError, setLoginError] = createSignal<string | null>(null);
  const add = createAction();

  return (
    <form
      class="acct-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label().trim()) return;
        setCommand(null);
        setLoginError(null);
        void add.run(async () => {
          const res = await addAccountWithLogin(addCall, props.runtime, label());
          setCommand(res.command);
          setLoginError(res.loginError);
          setLabel("");
          props.onAdded();
        });
      }}
    >
      <div class="key-row">
        <Field label={`Add ${props.runtime} account`}>
          {(control) => (
            <input
              {...control()}
              type="text"
              value={label()}
              placeholder="label (e.g. work-2)"
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" size="sm" disabled={add.busy() || !label().trim()}>
          {add.busy() ? "Adding..." : "Add account"}
        </Button>
      </div>
      <Show when={command()}>
        {(cmd) => (
          <p class="muted" role="status">
            Finish login: <code>{cmd()}</code>
          </p>
        )}
      </Show>
      <Show when={add.error() ?? loginError()}>
        {(m) => (
          <p class="error" role="alert">
            {m()}
          </p>
        )}
      </Show>
    </form>
  );
}

export function RuntimeAccountsPanel(props: {
  runtime: string;
  accounts: AccountView[];
  quota: QuotaRow[];
  reload: () => void;
}): JSX.Element {
  const rows = () => mapAccountRows(props.accounts, props.quota);
  return (
    <Panel title={`${props.runtime} accounts`}>
      <Show
        when={rows().length > 0}
        fallback={<p class="muted">No accounts recorded for {props.runtime} yet.</p>}
      >
        <TableBox stack label={`${props.runtime} account list`}>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">State</th>
              <th scope="col">Identity</th>
              <th scope="col">Quota</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>{(row) => <AccountRow row={row} reload={props.reload} />}</For>
          </tbody>
        </TableBox>
      </Show>
      <AddAccountRow runtime={props.runtime} onAdded={props.reload} />
    </Panel>
  );
}
