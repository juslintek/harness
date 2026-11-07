import { me } from "../auth/me";
import { DesktopCard } from "./desktop-card";
import { SmtpCard } from "./smtp-card";
import { TunnelCard } from "./tunnel-card";

const CARDS: { id: string; render: () => preact.JSX.Element }[] = [
  { id: "smtp", render: () => <SmtpCard /> },
  { id: "tunnel", render: () => <TunnelCard /> },
  { id: "desktop", render: () => <DesktopCard /> },
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
