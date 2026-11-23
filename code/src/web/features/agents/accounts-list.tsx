import { useState } from "preact/hooks";
import { z } from "zod";
import { type AccountView, accountView } from "../../../shared/accounts";
import {
  type AccountRowView,
  type JsonCaller,
  mapAccountRows,
  removeAccountConfirmed,
} from "../../../shared/accounts-ui";
import type { QuotaRow } from "../../../shared/runs";
import { api } from "../../api";
import { errorText } from "../../format";
import { AddAccountForm } from "./add-account";

const anySchema = z.unknown();
const deleteCall: JsonCaller = (path, init) => api(path, anySchema, init);

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

function AccountRowItem({
  row,
  reload,
}: {
  row: AccountRowView;
  reload: () => void;
}): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setConfirming(false);
      reload();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

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
      <td data-label="Actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(() =>
              api(`/api/agents/${row.runtime}/accounts/${row.id}/test`, accountView, {
                method: "POST",
                body: {},
              }),
            )
          }
        >
          Test
        </button>{" "}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(() =>
              api(`/api/agents/${row.runtime}/accounts/${row.id}`, accountView, {
                method: "PATCH",
                body: { enabled: !row.enabled },
              }),
            )
          }
        >
          {row.enabled ? "Disable" : "Enable"}
        </button>{" "}
        {!row.isDefault &&
          (confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    removeAccountConfirmed(deleteCall, row.runtime, row.id, true, false),
                  )
                }
              >
                Confirm remove
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </button>
          ))}
        {message && (
          <p class="error" role="alert">
            {message}
          </p>
        )}
      </td>
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
