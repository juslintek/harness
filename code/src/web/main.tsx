import { signal } from "@preact/signals";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { haltBody } from "../shared/runs";
import { api, loggedOut } from "./api";
import { AgentsPage } from "./features/agents/agents-page";
import { RunPage } from "./features/runs/run-page";
import { RunsPage } from "./features/runs/runs-page";
import { SearchPage } from "./features/search/search-page";
import { errorText } from "./format";

const route = signal(location.hash || "#/runs");
window.addEventListener("hashchange", () => {
  route.value = location.hash || "#/runs";
});

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

function Page(): preact.JSX.Element {
  const parts = route.value.replace(/^#\/?/, "").split("/");
  if (parts[0] === "agents") return <AgentsPage />;
  if (parts[0] === "search") return <SearchPage />;
  if (parts[0] === "runs" && parts[1]) return <RunPage id={parts[1]} key={parts[1]} />;
  return <RunsPage />;
}

function App(): preact.JSX.Element {
  return (
    <>
      <header>
        <h1>Harness</h1>
        <nav aria-label="Main">
          <a href="#/runs">Runs</a>
          <a href="#/agents">Agents</a>
          <a href="#/search">Search</a>
        </nav>
        {!loggedOut.value && <HaltSwitch />}
      </header>
      <main>
        {loggedOut.value ? (
          <p class="error" role="alert">
            Open the login URL printed in the harness console.
          </p>
        ) : (
          <Page />
        )}
      </main>
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
