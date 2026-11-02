import { signal } from "@preact/signals";
import { render } from "preact";
import { healthSchema } from "../shared/health";

type Status = { state: "loading" | "error" | "ok"; text: string };

const status = signal<Status>({ state: "loading", text: "Checking server..." });

async function loadHealth(): Promise<void> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = healthSchema.parse(await res.json());
    status.value = { state: "ok", text: `Instance ${health.instanceId} (v${health.version})` };
  } catch (err) {
    status.value = { state: "error", text: `Server unreachable: ${String(err)}` };
  }
}

function App(): preact.JSX.Element {
  return (
    <>
      <header>
        <h1>Harness</h1>
      </header>
      <main>
        <p class="status" data-state={status.value.state} role="status">
          {status.value.text}
        </p>
      </main>
    </>
  );
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
  void loadHealth();
}
