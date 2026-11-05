export type Provider = "tailscale-serve" | "tailscale-funnel" | "cloudflare";

export const PROVIDERS: { id: Provider; label: string; tailnetOnly: boolean }[] = [
  {
    id: "tailscale-serve",
    label: "Tailscale Serve (tailnet only, recommended)",
    tailnetOnly: true,
  },
  { id: "tailscale-funnel", label: "Tailscale Funnel (public internet)", tailnetOnly: false },
  { id: "cloudflare", label: "Cloudflare quick tunnel (public internet)", tailnetOnly: false },
];

// Mirrors the server: everything except Serve puts the instance on the open internet.
export const isPublicProvider = (provider: Provider): boolean => provider !== "tailscale-serve";

// Start is a two click action; a public provider also needs its checkbox ticked first.
export function canConfirmStart(provider: Provider, ticked: boolean): boolean {
  return !isPublicProvider(provider) || ticked;
}

export function startBody(
  provider: Provider,
  ticked: boolean,
): { confirm: true; confirmPublic?: true } {
  return isPublicProvider(provider) && ticked
    ? { confirm: true, confirmPublic: true }
    : { confirm: true };
}
