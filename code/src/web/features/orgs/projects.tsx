import { useState } from "preact/hooks";
import type { OrgDetail, ProjectView } from "../../../shared/orgs";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { isAdmin } from "./org-data";

function Grants({
  project,
  onChange,
}: {
  project: ProjectView;
  onChange: () => void;
}): preact.JSX.Element {
  const [orgId, setOrgId] = useState("");
  const [permission, setPermission] = useState("read");
  const action = useAction();
  const call = (method: "POST" | "DELETE"): void => {
    const body = method === "POST" ? { orgId, permission } : { orgId };
    action
      .run(async () => {
        await api(`/api/projects/${project.id}/grants`, ignored, { method, body });
        setOrgId("");
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <details>
      <summary>Grants for {project.key}</summary>
      <div class="row">
        <label>
          Other org id
          <input value={orgId} onInput={(e) => setOrgId(e.currentTarget.value)} />
        </label>
        <label>
          Permission
          <select value={permission} onChange={(e) => setPermission(e.currentTarget.value)}>
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
        </label>
        <button type="button" disabled={action.busy || orgId === ""} onClick={() => call("POST")}>
          Grant
        </button>
        <button
          type="button"
          class="danger"
          disabled={action.busy || orgId === ""}
          onClick={() => call("DELETE")}
        >
          Revoke
        </button>
      </div>
      <ErrorLine message={action.error} />
    </details>
  );
}

function NewProject({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = { key, name, ...(repo && { repo }) };
        await api(`/api/orgs/${detail.org.slug}/projects`, ignored, { method: "POST", body });
        setKey("");
        setName("");
        setRepo("");
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        Key
        <input
          value={key}
          required
          maxLength={16}
          pattern="[A-Za-z0-9_\-]+"
          onInput={(e) => setKey(e.currentTarget.value)}
        />
      </label>
      <label>
        Name
        <input
          value={name}
          required
          maxLength={80}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label>
        Repo path (instance admin only)
        <input value={repo} onInput={(e) => setRepo(e.currentTarget.value)} />
      </label>
      <button type="submit" disabled={action.busy}>
        Create project
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

export function Projects({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const admin = isAdmin(detail);
  return (
    <section>
      <h3>Projects</h3>
      <ul class="plain">
        {detail.projects.map((p) => (
          <li key={p.id} class="card">
            <a href={`#/o/${detail.org.slug}/board/${p.id}`}>
              <strong>{p.key}</strong> {p.name}
            </a>{" "}
            <code class="muted">{p.repo ?? "no repo"}</code>
            {p.orgId !== detail.org.id && <span class="badge">shared with this org</span>}
            {admin && p.orgId === detail.org.id && <Grants project={p} onChange={onChange} />}
          </li>
        ))}
      </ul>
      {admin && <NewProject detail={detail} onChange={onChange} />}
    </section>
  );
}
