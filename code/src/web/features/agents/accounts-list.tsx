import { useState } from "preact/hooks";
import { z } from "zod";
import { type AccountView, accountView } from "../../../shared/accounts";
import {
  type AccountRowView,
  type JsonCaller,
  loginAccount,
  mapAccountRows,
  removeAccountConfirmed,
} from "../../../shared/accounts-ui";
import { accountLoginSchema, type QuotaRow } from "../../../shared/runs";
import { api } from "../../api";
import { errorText } from "../../format";
import { AddAccountForm } from "./add-account";

const anySchema = z.unknown();
const deleteCall: JsonCaller = (path, init) => api(path, anySchema, init);
const loginCall: JsonCaller = (path, init) => api(path, accountLoginSchema, init);

function QuotaCell({ row }: { row: AccountRowView }): preact.JSX.Element {
  if (row.quotaUnknown) return <span class="muted">unknown</span>;
  return (
    <ul class="plain">
      {row.windows.map((w) => (
        <li key={w.window}>
          <label>
            {w.window}: {Math.round(w.usedPercent)}% ({w.ageLabel}){" "}
            <progress max={100} value={Math.min(100, Math.max(0, w.usedPercent))} />
          </label>
        </li>
      ))}
    </ul>
  );
}

const accountPath = (row: AccountRowView): string =>
  `/api/agents/${encodeURIComponent(row.runtime)}/accounts/${encodeURIComponent(row.id)}`;

function RemoveAccountControl({
  busy,
  confirming,
  onStart,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  confirming: boolean;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): preact.JSX.Element {
  if (!confirming) {
    return (
      <button type="button" disabled={busy} onClick={onStart}>
        Remove
      </button>
    );
  }
  return (
    <>
      <button type="button" disabled={busy} onClick={onConfirm}>
        Confirm remove
      </button>{" "}
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </>
  );
}

function AccountActionsCell({
  row,
  reload,
}: {
  row: AccountRowView;
  reload: () => void;
}): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loginCommand, setLoginCommand] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const base = accountPath(row);
  const canRetryLogin = row.state === "pending" || row.state === "logged_out";

  const act = async (fn: () => Promise<unknown>, refresh = true): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setConfirming(false);
      if (refresh) reload();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const onRetryLogin = (): void => {
    setLoginCommand(null);
    void act(async () => setLoginCommand(await loginAccount(loginCall, row)), false);
  };
  const onTest = (): void =>
    void act(() => api(`${base}/test`, accountView, { method: "POST", body: {} }));
  const onToggle = (): void =>
    void act(() => api(base, accountView, { method: "PATCH", body: { enabled: !row.enabled } }));
  const onRemove = (): void =>
    void act(() => removeAccountConfirmed(deleteCall, row.runtime, row.id, true, false));

  return (
    <td data-label="Actions">
      {canRetryLogin && (
        <>
          <button type="button" disabled={busy} onClick={onRetryLogin}>
            Log in
          </button>{" "}
        </>
      )}
      <button type="button" disabled={busy} onClick={onTest}>
        Test
      </button>{" "}
      <button type="button" disabled={busy} onClick={onToggle}>
        {row.enabled ? "Disable" : "Enable"}
      </button>{" "}
      {!row.isDefault && (
        <RemoveAccountControl
          busy={busy}
          confirming={confirming}
          onStart={() => setConfirming(true)}
          onCancel={() => setConfirming(false)}
          onConfirm={onRemove}
        />
      )}
      {loginCommand && (
        <p class="muted" role="status">
          Run or finish login: <code>{loginCommand}</code>
        </p>
      )}
      {message && (
        <p class="error" role="alert">
          {message}
        </p>
      )}
    </td>
  );
}

function AccountRowItem({
  row,
  reload,
}: {
  row: AccountRowView;
  reload: () => void;
}): preact.JSX.Element {
  return (
    <tr>
      <th scope="row">
        {row.label} {row.isDefault ? <span class="muted">(default)</span> : null}
      </th>
      <td data-label="State">{row.exhausted ? `${row.state} (exhausted)` : row.state}</td>
      <td data-label="Identity">{row.identityHint ?? "-"}</td>
      <td data-label="Quota">
        <QuotaCell row={row} />
      </td>
      <AccountActionsCell row={row} reload={reload} />
    </tr>
  );
}

export function AccountsList({
  runtime,
  accounts,
  quota,
  reload,
}: {
  runtime: string;
  accounts: AccountView[];
  quota: QuotaRow[];
  reload: () => void;
}): preact.JSX.Element {
  const rows = mapAccountRows(accounts, quota);
  return (
    <section>
      <h4>{runtime} accounts</h4>
      {rows.length === 0 ? (
        <p class="muted">No accounts recorded yet.</p>
      ) : (
        <table class="stack">
          <thead>
            <tr>
              <th>Account</th>
              <th>State</th>
              <th>Identity</th>
              <th>Quota</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <AccountRowItem key={row.id} row={row} reload={reload} />
            ))}
          </tbody>
        </table>
      )}
      <AddAccountForm runtime={runtime} onAdded={reload} />
    </section>
  );
}
