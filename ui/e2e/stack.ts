import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const UI_DIR = resolve(import.meta.dirname, "..");
const CODE_DIR = resolve(UI_DIR, "../code");
const STARTUP_MS = 30_000;
const LISTENING = /^harness listening on http:\/\/127\.0\.0\.1:(\d+)\/$/m;

export interface Stack {
  url: string;
  enrollmentCode: (email: string, name: string) => string;
  // Enrollment only makes ordinary users; the instance admin flag has no HTTP path, so it is set in
  // the server's own database.
  makeInstanceAdmin: (email: string) => void;
  // Sessions from a passkey sign-in only get a step-up when asked, and it lasts five minutes, so a
  // test that wants the prompt again clears it.
  expireStepUp: () => void;
  // Runs one statement against the server's database, for state that has no HTTP path in a test.
  sql: (statement: string, ...params: (string | number)[]) => void;
  stop: () => Promise<void>;
}

// A child killed by a signal has exitCode null and signalCode set.
const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const stopChild = (child: ChildProcess): Promise<void> =>
  new Promise((done) => {
    if (hasExited(child)) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });

function boundPort(child: ChildProcess): Promise<number> {
  return new Promise((done, fail) => {
    let output = "";
    const timer = setTimeout(
      () => fail(new Error("the server did not report its port")),
      STARTUP_MS,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = LISTENING.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      fail(new Error(`the server exited early:\n${output}`));
    });
  });
}

// The TS server serves the built ui/dist itself (HARNESS_UI_DIST), the same path the Zig binary
// will use. Port 0 lets the OS pick; the WebAuthn origin derives from the bound port.
export async function startStack(): Promise<Stack> {
  const home = mkdtempSync(join(tmpdir(), "harness-ui-e2e-"));
  const env = {
    ...process.env,
    HARNESS_HOME: home,
    HARNESS_PORT: "0",
    HARNESS_UI_DIST: join(UI_DIR, "dist"),
  };
  const server = spawn("bun", ["src/main.ts"], {
    cwd: CODE_DIR,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let port: number;
  try {
    port = await boundPort(server);
  } catch (err) {
    await stopChild(server);
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  return {
    url: `http://localhost:${port}`,
    enrollmentCode: (email, name) => {
      const link = execFileSync("bun", ["scripts/enroll.ts", "--email", email, "--name", name], {
        cwd: CODE_DIR,
        env: { ...env, HARNESS_PORT: String(port) },
        encoding: "utf8",
      }).trim();
      const code = link.split("/#/enroll/")[1];
      if (!code) throw new Error(`no enrollment code in ${link}`);
      return code;
    },
    makeInstanceAdmin: (email) => {
      execFileSync(
        "bun",
        [
          "-e",
          'const db = new (require("bun:sqlite").Database)(process.env.DB); db.run("PRAGMA busy_timeout = 5000"); db.query("UPDATE users SET instance_admin = 1 WHERE email = ?").run(process.env.EMAIL)',
        ],
        { env: { ...env, DB: join(home, "harness.db"), EMAIL: email.toLowerCase() } },
      );
    },
    sql: (statement, ...params) => {
      execFileSync(
        "bun",
        [
          "-e",
          'const [q, p] = JSON.parse(process.env.STMT); const db = new (require("bun:sqlite").Database)(process.env.DB); db.run("PRAGMA busy_timeout = 5000"); db.query(q).run(...p)',
        ],
        {
          env: { ...env, DB: join(home, "harness.db"), STMT: JSON.stringify([statement, params]) },
        },
      );
    },
    expireStepUp: () => {
      execFileSync(
        "bun",
        [
          "-e",
          'const db = new (require("bun:sqlite").Database)(process.env.DB); db.run("PRAGMA busy_timeout = 5000"); db.query("UPDATE sessions SET step_up_at = NULL").run()',
        ],
        { env: { ...env, DB: join(home, "harness.db") } },
      );
    },
    stop: async () => {
      await stopChild(server);
      rmSync(home, { recursive: true, force: true });
    },
  };
}
