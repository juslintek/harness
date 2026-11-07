import { useState } from "preact/hooks";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

type Security = "starttls" | "tls" | "none";

interface Form {
  host: string;
  port: string;
  security: Security;
  user: string;
  from: string;
  password: string;
}

const EMPTY: Form = {
  host: "",
  port: "587",
  security: "starttls",
  user: "",
  from: "",
  password: "",
};

// An empty user or password is left out: the server keeps the stored password when none is sent.
function smtpBody(form: Form): Record<string, string | number> {
  const body: Record<string, string | number> = {
    host: form.host.trim(),
    port: Number(form.port),
    security: form.security,
    from: form.from.trim(),
  };
  if (form.user.trim()) body.user = form.user.trim();
  if (form.password) body.password = form.password;
  return body;
}

function Fields({
  form,
  set,
}: {
  form: Form;
  set: (patch: Partial<Form>) => void;
}): preact.JSX.Element {
  return (
    <>
      <div class="row">
        <label>
          Host
          <input
            value={form.host}
            required
            maxLength={253}
            onInput={(e) => set({ host: e.currentTarget.value })}
          />
        </label>
        <label>
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={form.port}
            required
            onInput={(e) => set({ port: e.currentTarget.value })}
          />
        </label>
        <label>
          Security
          <select
            value={form.security}
            onChange={(e) => set({ security: e.currentTarget.value as Security })}
          >
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label>
          User
          <input
            value={form.user}
            maxLength={200}
            autoComplete="off"
            onInput={(e) => set({ user: e.currentTarget.value })}
          />
        </label>
        <label>
          Password (write only)
          <input
            type="password"
            value={form.password}
            maxLength={500}
            autoComplete="new-password"
            placeholder="Leave empty to keep the stored one"
            onInput={(e) => set({ password: e.currentTarget.value })}
          />
        </label>
        <label>
          From address
          <input
            type="email"
            value={form.from}
            required
            maxLength={320}
            onInput={(e) => set({ from: e.currentTarget.value })}
          />
        </label>
      </div>
    </>
  );
}

export function SmtpCard(): preact.JSX.Element {
  const [form, setForm] = useState<Form>(EMPTY);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const set = (patch: Partial<Form>): void => setForm((f) => ({ ...f, ...patch }));
  const save = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        setNotice(null);
        await api("/api/notify/email/config", ignored, { method: "PUT", body: smtpBody(form) });
        set({ password: "" });
        setNotice("Saved. The password is stored on the server and is never shown again.");
      })
      .catch((err: unknown) => console.error(err));
  };
  const test = (): void => {
    action
      .run(async () => {
        setNotice(null);
        await api("/api/notify/email/test", ignored, { method: "POST", body: {} });
        setNotice("Test mail sent to your own address.");
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <section class="card" aria-labelledby="smtp-h">
      <h3 id="smtp-h">Email (SMTP)</h3>
      <p class="muted">
        Saving replaces the stored settings, so fill every field. The password field only writes.
      </p>
      <form onSubmit={save}>
        <Fields form={form} set={set} />
        <div class="row">
          <button type="submit" disabled={action.busy}>
            Save SMTP settings
          </button>
          <button type="button" disabled={action.busy} onClick={test}>
            Send a test mail to me
          </button>
        </div>
      </form>
      <ErrorLine message={action.error} />
      <p class="muted" role="status">
        {notice}
      </p>
    </section>
  );
}
