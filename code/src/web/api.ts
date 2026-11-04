import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { z } from "zod";
import { type WsMessage, wsMessageSchema } from "../shared/realtime";
import { stepUp } from "./features/auth/webauthn";
import { rememberReturn } from "./return-hash";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class ApiError extends Error {
  readonly status: number;
  readonly issues: string[];
  constructor(status: number, message: string, issues: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
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

const issuesOf = (body: unknown): string[] =>
  typeof body === "object" && body !== null && "issues" in body && Array.isArray(body.issues)
    ? body.issues.map(String)
    : [];

// The login and enroll pages answer 401 themselves (a wrong code is not an expired session).
function sessionLost(): void {
  if (/^#\/(login|enroll)/.test(location.hash)) return;
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
    await stepUp(postJson);
    res = await send(path, init);
    body = await res.json().catch(() => null);
  }
  if (res.status === 401) sessionLost();
  if (!res.ok)
    throw new ApiError(res.status, errorOf(body) || `HTTP ${res.status}`, issuesOf(body));
  return schema.parse(body);
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  // Null for a failure that never got an HTTP answer (offline, bad payload).
  errorStatus: number | null;
  reload: () => void;
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Omit<Loaded<T>, "reload">>({
    data: null,
    error: null,
    errorStatus: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data, error: null, errorStatus: null }),
      (err: unknown) =>
        live &&
        setState((s) => ({
          ...s,
          error: String(err),
          errorStatus: err instanceof ApiError ? err.status : null,
        })),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

// Messages only say "something changed"; callers refetch. The handler also runs with null on every
// socket open, so whatever happened while the socket was down (or before it first connected) is picked up.
export function useTopic(topic: string, onMessage: (m: WsMessage | null) => void): void {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let delay = RECONNECT_MIN_MS;
    const connect = (): void => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws?topic=${encodeURIComponent(topic)}`);
      socket.onopen = () => {
        delay = RECONNECT_MIN_MS;
        handler.current(null);
      };
      socket.onmessage = (e) => {
        try {
          const parsed = wsMessageSchema.safeParse(JSON.parse(String(e.data)));
          if (parsed.success) handler.current(parsed.data);
        } catch {
          // A malformed frame is dropped; the next message or reconnect refetches anyway.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [topic]);
}
