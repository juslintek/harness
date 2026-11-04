import { useEffect, useState } from "preact/hooks";
import { haltBody } from "../shared/runs";
import { api } from "./api";
import { canDecideApprovals, me } from "./features/auth/me";
import { OrgSwitcher, selectedSlug } from "./features/orgs/org-switcher";
import { errorText } from "./format";

const haltSchema = haltBody;

function HaltSwitch(): preact.JSX.Element {
  const [halted, setHalted] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api("/api/halt", haltSchema).then(
      (h) => setHalted(h.halted),
      () => setHalted(null),
    );
  }, []);
  const toggle = async (): Promise<void> => {
    const next = !halted;
    const text = next
      ? "Halt the harness? Every live run is killed and new runs are refused."
      : "Resume the harness and allow new runs?";
    if (!window.confirm(text)) return;
    try {
      setHalted(
        (await api("/api/halt", haltSchema, { method: "POST", body: { halted: next } })).halted,
      );
      setMessage(null);
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  if (halted === null) return <span />;
  return (
    <span class="halt">
      <button
        type="button"
        role="switch"
        aria-checked={halted}
        class={halted ? "danger" : ""}
        onClick={toggle}
      >
        {halted ? "Halted, click to resume" : "Halt all runs"}
      </button>
      {message && (
        <span class="error" role="alert">
          {message}
        </span>
      )}
    </span>
  );
}

export function Header(): preact.JSX.Element {
  const user = me.value?.user;
  const slug = selectedSlug();
  return (
    <header>
      <h1>Harness</h1>
      {user && (
        <>
          <OrgSwitcher />
          <nav aria-label="Main">
            {slug && (
              <>
                <a href={`#/o/${slug}/board`}>Board</a>
                <a href={`#/o/${slug}/chat`}>Chat</a>
                <a href={`#/o/${slug}/dashboard`}>Dashboard</a>
                <a href={`#/o/${slug}/hiring`}>Hiring</a>
                <a href={`#/o/${slug}/policies`}>Policies</a>
                <a href={`#/o/${slug}/memory`}>Memory</a>
                <a href={`#/o/${slug}/logs`}>Logs</a>
                <a href={`#/o/${slug}/settings`}>Settings</a>
              </>
            )}
            {user.instanceAdmin && (
              <>
                <a href="#/runs">Runs</a>
                <a href="#/agents">Agents</a>
                <a href="#/search">Search</a>
              </>
            )}
            {canDecideApprovals(me.value) && <a href="#/approvals">Approvals</a>}
            <a href="#/account">Account</a>
          </nav>
          {user.instanceAdmin && <HaltSwitch />}
        </>
      )}
    </header>
  );
}
