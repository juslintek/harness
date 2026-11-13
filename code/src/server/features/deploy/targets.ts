import type { TargetView } from "../../../shared/distribution";
import { discoverDocker } from "./docker";
import { discoverSsh } from "./ssh-config";
import { discoverTailscale } from "./tailscale";

export interface DiscoveryDeps {
  sshConfigPath: string;
  // PATH override for the tailscale and docker lookups; undefined uses the process PATH.
  bin?: string | undefined;
}

export async function discoverTargets(deps: DiscoveryDeps): Promise<TargetView[]> {
  const [peers, contexts] = await Promise.all([
    discoverTailscale(deps.bin),
    discoverDocker(deps.bin),
  ]);
  const ssh: TargetView[] = discoverSsh(deps.sshConfigPath).map((host) => ({
    id: `ssh:${host.name}`,
    kind: "ssh",
    name: host.name,
    address: host.hostName,
    ...(host.user ? { user: host.user } : {}),
    ...(host.port ? { port: host.port } : {}),
    // The path is shown as text so the admin knows which key ssh will try; the file is never opened.
    ...(host.identityFile ? { note: `key: ${host.identityFile}` } : {}),
  }));
  const tailscale: TargetView[] = peers.map((peer) => ({
    id: `tailscale:${peer.dnsName}`,
    kind: "tailscale",
    name: peer.name,
    address: peer.dnsName,
    note: `${peer.os || "unknown os"}, ${peer.online ? "online" : "offline"}`,
  }));
  // A unix-socket context is this machine, not somewhere to deploy to.
  const docker: TargetView[] = contexts
    .filter((ctx) => ctx.endpoint && !ctx.endpoint.startsWith("unix:"))
    .map((ctx) => ({
      id: `docker:${ctx.name}`,
      kind: "docker",
      name: ctx.name,
      address: ctx.endpoint,
      ...(ctx.description ? { note: ctx.description } : {}),
    }));
  return [...ssh, ...tailscale, ...docker];
}
