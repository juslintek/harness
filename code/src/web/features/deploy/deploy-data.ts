import { z } from "zod";
import { type TargetView, targetViewSchema } from "../../../shared/distribution";

type DeployStatus = "pending" | "approved" | "denied" | "running" | "done" | "failed";
type OsText = { path: string; text: string };
export interface PlanView {
  copy: { from: string; to: string; mode: string };
  unit: { linux: OsText; darwin: OsText };
  invite: { path: string; mode: string; note: string };
  commands: { linux: string[][]; darwin: string[][] };
  health: string;
  pairing: string;
}
export interface DeployRequestView {
  id: string;
  target: TargetView;
  binaryPath: string;
  binarySha256: string;
  port: number;
  status: DeployStatus;
  createdAt: number;
  decidedAt: number | null;
  result: unknown;
  steps: PlanView;
}

const osText = z.object({ path: z.string(), text: z.string() });
const commands = z.array(z.array(z.string()));

export const targetsSchema: z.ZodType<TargetView[]> = z.array(targetViewSchema);
export const deployRequestSchema: z.ZodType<DeployRequestView> = z.object({
  id: z.string(),
  target: targetViewSchema,
  binaryPath: z.string(),
  binarySha256: z.string(),
  port: z.number(),
  status: z.enum(["pending", "approved", "denied", "running", "done", "failed"]),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  result: z.unknown(),
  steps: z.object({
    copy: z.object({ from: z.string(), to: z.string(), mode: z.string() }),
    unit: z.object({ linux: osText, darwin: osText }),
    invite: z.object({ path: z.string(), mode: z.string(), note: z.string() }),
    commands: z.object({ linux: commands, darwin: commands }),
    health: z.string(),
    pairing: z.string(),
  }),
});
export const deployRequestsSchema: z.ZodType<DeployRequestView[]> = z.array(deployRequestSchema);
