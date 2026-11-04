import { z } from "zod";

export interface Detected {
  tailscale: { installed: boolean; dnsName: string | null };
  cloudflared: { installed: boolean };
}

const STATUS_TIMEOUT_MS = 5000;

const statusSchema = z.object({ Self: z.object({ DNSName: z.string() }) });

function find(name: string, bin: string | undefined): string | null {
  return Bun.which(name, bin ? { PATH: bin } : {});
}

// `status` only reads; it is the one tailscale command that runs before an admin has confirmed anything.
async function tailscaleDnsName(path: string, env: Record<string, string>): Promise<string | null> {
  try {
    const proc = Bun.spawn([path, "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, ...env },
      timeout: STATUS_TIMEOUT_MS,
    });
    const parsed = statusSchema.safeParse(JSON.parse(await new Response(proc.stdout).text()));
    // MagicDNS names end in a dot, which a URL host must not carry.
    return parsed.success ? parsed.data.Self.DNSName.replace(/\.$/, "") || null : null;
  } catch {
    return null;
  }
}

export async function detectProviders(
  bin: string | undefined,
  env: Record<string, string> = {},
): Promise<Detected> {
  const tailscale = find("tailscale", bin);
  return {
    tailscale: {
      installed: tailscale !== null,
      dnsName: tailscale ? await tailscaleDnsName(tailscale, env) : null,
    },
    cloudflared: { installed: find("cloudflared", bin) !== null },
  };
}
