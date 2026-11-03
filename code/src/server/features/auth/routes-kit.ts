import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import {
  createSoftAuthenticator,
  type SoftAuthenticator,
} from "../../test-support/soft-authenticator";
import { createEnrollment } from "./api";

export const PORT = 4100;

export interface Kit {
  db: Database;
  origin: string;
  authn: SoftAuthenticator;
  sent: { email: string; code: string }[];
  deliver: { fn: (email: string, code: string) => void | Promise<void> };
  call: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  request: (path: string, headers: Record<string, string>) => Response | Promise<Response>;
  enroll: (code?: string, email?: string) => Promise<Response>;
  login: () => Promise<string>;
  stepUp: (cookie: string) => Promise<Response>;
}

export const cookieOf = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

// A real app over an in-memory DB, driven with the soft authenticator instead of a browser.
export function bootKit(origin = `http://localhost:${PORT}`): Kit {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const rp = { id: new URL(origin).hostname, name: "Harness", origin };
  const sent: Kit["sent"] = [];
  const deliver: Kit["deliver"] = { fn: (email, code) => void sent.push({ email, code }) };
  const app = createApp({
    db,
    home: "/unused",
    port: PORT,
    rp,
    instanceId: "i",
    version: "1",
    deliverEmailCode: (email, code) => deliver.fn(email, code),
  });
  const host = new URL(origin).host;
  const authn = createSoftAuthenticator(rp);
  const call: Kit["call"] = (method, path, body, headers = {}) =>
    Promise.resolve(
      app.request(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { host, origin, "content-type": "application/json", ...headers },
      }),
    );
  const enroll: Kit["enroll"] = async (code = createEnrollment(db, { ttlMs: 60_000 }), email) => {
    const who = { email: email ?? "owner@example.com", name: "Owner" };
    const options = await (await call("POST", `/api/auth/enroll/${code}/options`, who)).json();
    const response = await authn.create(options);
    return call("POST", `/api/auth/enroll/${code}/verify`, {
      challengeId: options.challengeId,
      userId: options.userId,
      response,
      name: "Laptop",
    });
  };
  const login: Kit["login"] = async () => {
    const options = await (await call("POST", "/api/auth/login/options")).json();
    const response = await authn.get(options);
    const res = await call("POST", "/api/auth/login/verify", {
      challengeId: options.challengeId,
      response,
    });
    return cookieOf(res);
  };
  const stepUp: Kit["stepUp"] = async (cookie) => {
    const options = await (await call("POST", "/api/auth/step-up/options", {}, { cookie })).json();
    const response = await authn.get(options);
    return call(
      "POST",
      "/api/auth/step-up/verify",
      { challengeId: options.challengeId, response },
      { cookie },
    );
  };
  const request: Kit["request"] = (path, headers) => app.request(path, { headers });
  return { db, origin, authn, sent, deliver, call, request, enroll, login, stepUp };
}
