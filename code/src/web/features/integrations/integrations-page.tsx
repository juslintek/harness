import { me } from "../auth/me";
import { McpCard } from "./mcp-card";
import { SmtpCard } from "./smtp-card";
import { TunnelCard } from "./tunnel-card";

// One entry per card: a later task adds the Claude Desktop link card by appending to this list.
const CARDS: { id: string; render: () => preact.JSX.Element }[] = [
  { id: "smtp", render: () => <SmtpCard /> },
  { id: "tunnel", render: () => <TunnelCard /> },
  { id: "mcp", render: () => <McpCard /> },
];

export function IntegrationsPage(): preact.JSX.Element {
  if (me.value?.user.instanceAdmin !== true) return <p class="muted">Not available.</p>;
  return (
    <div class="integrations">
      <h2>Integrations</h2>
      {CARDS.map((card) => (
        <div key={card.id}>{card.render()}</div>
      ))}
    </div>
  );
}
