import { useState } from "preact/hooks";
import type { OrgDetail } from "../../../shared/orgs";
import { inviteResultSchema, type MemberView, type Role } from "../../../shared/orgs";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored, me } from "../auth/me";
import { useAction } from "../auth/use-action";
import { AddAgent } from "./add-agent";
import { isAdmin } from "./org-data";
import { ProfileEditor } from "./profile-editor";

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

function MemberRow({
  member,
  detail,
  onChange,
}: {
  member: MemberView;
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const base = `/api/orgs/${detail.org.slug}/members/${member.id}`;
  const call = (method: "PATCH" | "DELETE", body?: unknown): void => {
    action
      .run(async () => {
        await api(base, ignored, body === undefined ? { method } : { method, body });
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  const admin = isAdmin(detail);
  return (
    <li class="card row">
      <span>
        <strong>@{member.handle}</strong> {member.displayName}{" "}
        <span class="badge">{member.kind}</span>
        {member.paused && (
          <span class="badge" data-state="blocked">
            paused
          </span>
        )}
      </span>
      <span class="row">
        {admin ? (
          <label class="inline">
            <span class="sr-only">Role of @{member.handle}</span>
            <select
              value={member.role}
              onChange={(e) => call("PATCH", { role: e.currentTarget.value })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span class="badge">{member.role}</span>
        )}
        {admin && member.kind === "agent" && (
          <button
            type="button"
            aria-label={`${member.paused ? "Resume" : "Pause"} @${member.handle}`}
            onClick={() => call("PATCH", { paused: !member.paused })}
          >
            {member.paused ? "Resume" : "Pause"}
          </button>
        )}
        {admin && member.kind === "agent" && (
          <button
            type="button"
            aria-expanded={editing}
            aria-label={`Profile of @${member.handle}`}
            onClick={() => setEditing(!editing)}
          >
            Profile
          </button>
        )}
        {admin && (
          <button
            type="button"
            class="danger"
            aria-label={`Remove @${member.handle}`}
            onClick={() => call("DELETE")}
          >
            Remove
          </button>
        )}
      </span>
      <ErrorLine message={action.error} />
      {editing && <ProfileEditor slug={detail.org.slug} member={member} />}
    </li>
  );
}

function InviteHuman({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const res = await api(`/api/orgs/${detail.org.slug}/members/humans`, inviteResultSchema, {
          method: "POST",
          body: { email, role },
        });
        setLink(res.enrollmentLink);
        setEmail("");
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <>
      <form class="row" onSubmit={submit}>
        <label>
          Invite by email
          <input
            type="email"
            value={email}
            required
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.currentTarget.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={action.busy}>
          Invite
        </button>
      </form>
      <ErrorLine message={action.error} />
      {link && (
        <p class="card">
          Send this enrollment link to the new member (valid 24 hours):
          <br />
          <code class="enroll-link">{link}</code>{" "}
          <button type="button" onClick={() => void navigator.clipboard.writeText(link)}>
            Copy link
          </button>
        </p>
      )}
    </>
  );
}

export function Members({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  return (
    <section>
      <h3>Members</h3>
      <ul class="plain">
        {detail.members.map((m) => (
          <MemberRow key={m.id} member={m} detail={detail} onChange={onChange} />
        ))}
      </ul>
      {isAdmin(detail) && (
        <>
          <InviteHuman detail={detail} onChange={onChange} />
          {me.value?.user.instanceAdmin === true && (
            <AddAgent detail={detail} onChange={onChange} />
          )}
        </>
      )}
    </section>
  );
}
