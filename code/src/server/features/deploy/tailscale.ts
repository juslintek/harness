import { z } from "zod";
import { runBin } from "./bin";

export interface TailscalePeer {
  name: string;
  dnsName: string;
  os: string;
  online: boolean;
}

const peerSchema = z.object({
  HostName: z.string().optional(),
  DNSName: z.string().default(""),
  OS: z.string().default(""),
  Online: z.boolean().default(false),
});
const statusSchema = z.object({ Peer: z.record(z.string(), z.unknown()).default({}) });

export async function discoverTailscale(bin?: string): Promise<TailscalePeer[]> {
  const out = await runBin(bin, "tailscale", ["status", "--json"]);
  if (!out) return [];
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    return [];
  }
  const status = statusSchema.safeParse(json);
  if (!status.success) return [];
  const peers: TailscalePeer[] = [];
  for (const raw of Object.values(status.data.Peer)) {
    const peer = peerSchema.safeParse(raw);
    // MagicDNS names end in a dot, which a hostname argument must not carry.
    const dnsName = peer.success ? peer.data.DNSName.replace(/\.$/, "") : "";
    if (!peer.success || !dnsName) continue;
    peers.push({
      name: peer.data.HostName || dnsName.split(".")[0] || dnsName,
      dnsName,
      os: peer.data.OS,
      online: peer.data.Online,
    });
  }
  return peers;
}
