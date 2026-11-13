import { z } from "zod";
import { runBin } from "./bin";

export interface DockerContext {
  name: string;
  endpoint: string;
  description: string;
}

const contextSchema = z.object({
  Name: z.string().min(1),
  DockerEndpoint: z.string().default(""),
  Description: z.string().default(""),
});

export async function discoverDocker(bin?: string): Promise<DockerContext[]> {
  const out = await runBin(bin, "docker", ["context", "ls", "--format", "json"]);
  if (!out) return [];
  const contexts: DockerContext[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = contextSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        const { Name, DockerEndpoint, Description } = parsed.data;
        contexts.push({ name: Name, endpoint: DockerEndpoint, description: Description });
      }
    } catch {
      // A bad line is skipped so one broken entry does not hide the others.
    }
  }
  return contexts;
}
