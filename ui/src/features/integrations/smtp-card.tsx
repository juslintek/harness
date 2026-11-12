import { createSignal, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Field, Panel } from "../../ui/primitives";

type Security = "starttls" | "tls" | "none";

// An empty user or password is left out: the server keeps the stored password when none is sent.
function smtpBody(form: {
  host: string;
  port: string;
  security: Security;
  user: string;
  from: string;
  password: string;
}): Record<string, string | number> {
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

export function SmtpCard(): JSX.Element {
  const [form, setForm] = createStore({
    host: "",
    port: "587",
    security: "starttls" as Security,
    user: "",
    from: "",
    password: "",
  });
  const [notice, setNotice] = createSignal<string | null>(null);
  const action = createAction();
  const save = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      setNotice(null);
      await api("/api/notify/email/config", ignored, { method: "PUT", body: smtpBody(form) });
      setForm("password", "");
      setNotice("Saved. The password is stored on the server and is never shown again.");
    });
  };
  const test = (): void => {
    void action.run(async () => {
      setNotice(null);
      await api("/api/notify/email/test", ignored, { method: "POST", body: {} });
      setNotice("Test mail sent to your own address.");
    });
  };
  return (
    <Panel title="Email (SMTP)">
      <form class="int-stack" onSubmit={save}>
        <p class="int-hint">
          Saving replaces the stored settings, so fill every field. The password field only writes.
        </p>
        <div class="int-grid">
          <Field label="Host">
            {(control) => (
              <input
                {...control()}
                value={form.host}
                required
                maxLength={253}
                onInput={(e) => setForm("host", e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Port">
            {(control) => (
              <input
                {...control()}
                type="number"
                min={1}
                max={65535}
                value={form.port}
                required
                onInput={(e) => setForm("port", e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Security">
            {(control) => (
              <select
                {...control()}
                value={form.security}
                onChange={(e) => setForm("security", e.currentTarget.value as Security)}
              >
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
                <option value="none">None</option>
              </select>
            )}
          </Field>
        </div>
        <div class="int-grid">
          <Field label="User">
            {(control) => (
              <input
                {...control()}
                value={form.user}
                maxLength={200}
                autocomplete="off"
                onInput={(e) => setForm("user", e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Password (write only)">
            {(control) => (
              <input
                {...control()}
                type="password"
                value={form.password}
                maxLength={500}
                autocomplete="new-password"
                placeholder="Leave empty to keep the stored one"
                onInput={(e) => setForm("password", e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="From address">
            {(control) => (
              <input
                {...control()}
                type="email"
                value={form.from}
                required
                maxLength={320}
                onInput={(e) => setForm("from", e.currentTarget.value)}
              />
            )}
          </Field>
        </div>
        <div class="int-row">
          <Button type="submit" tone="primary" disabled={action.busy()}>
            Save SMTP settings
          </Button>
          <Button disabled={action.busy()} onClick={test}>
            Send a test mail to me
          </Button>
        </div>
        <ErrorLine message={action.error()} />
        <p class="int-notice" role="status">
          {notice()}
        </p>
      </form>
    </Panel>
  );
}
