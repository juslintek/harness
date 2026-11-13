import type { z } from "zod";
import { askStepUp } from "./auth/step-up-prompt";
import { stepUp } from "./auth/webauthn";
import { rememberReturn } from "./return-hash";

// The message routes-account.ts answers when a step-up assertion is refused on a live session.
const STEP_UP_FAILED = "step-up failed";

export class ApiError extends Error {
  readonly status: number;
  readonly issues: string[];
  // Why the server refused, when it says (the guard's 403 on a risky command).
  readonly reason: string | null;
  constructor(
    status: number,
    message: string,
    issues: string[] = [],
    reason: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
    this.reason = reason;
  }
}

export interface ApiInit {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

const send = (path: string, init: ApiInit | undefined): Promise<Response> =>
  fetch(path, {
    ...(init
      ? {
          method: init.method,
          ...(init.body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
        }
      : {}),
    credentials: "same-origin",
  });

const errorOf = (body: unknown): string =>
  typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";

const reasonOf = (body: unknown): string | null =>
  typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string"
    ? body.reason
    : null;

const issuesOf = (body: unknown): string[] =>
  typeof body === "object" && body !== null && "issues" in body && Array.isArray(body.issues)
    ? body.issues.map(String)
    : [];

// The login and enroll pages answer 401 themselves (a wrong code is not an expired session).
function sessionLost(): void {
  if (/^#\/(login|enroll)(?:[/?]|$)/.test(location.hash)) return;
  rememberReturn(location.hash);
  location.hash = "#/login";
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await send(path, { method: "POST", body });
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, errorOf(parsed) || `HTTP ${res.status}`);
  return parsed;
}

export async function api<T>(path: string, schema: z.ZodType<T>, init?: ApiInit): Promise<T> {
  let res = await send(path, init);
  let body: unknown = await res.json().catch(() => null);
  if (res.status === 403 && errorOf(body) === "step_up_required") {
    try {
      // The passkey prompt starts from a click, and Cancel rejects the original call.
      await askStepUp(`${init?.method ?? "GET"} ${path}`);
      await stepUp(postJson);
    } catch (err) {
      // A cancelled prompt or a refused assertion ("step-up failed", also a 401) keeps the session;
      // any other 401 from the ceremony means the session is gone.
      if (err instanceof ApiError && err.status === 401 && err.message !== STEP_UP_FAILED) {
        sessionLost();
      }
      throw err;
    }
    res = await send(path, init);
    body = await res.json().catch(() => null);
  }
  if (res.status === 401) sessionLost();
  if (!res.ok)
    throw new ApiError(
      res.status,
      errorOf(body) || `HTTP ${res.status}`,
      issuesOf(body),
      reasonOf(body),
    );
  return schema.parse(body);
}
