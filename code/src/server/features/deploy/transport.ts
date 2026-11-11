export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// A port because the executor must run unchanged over ssh in production and over a temp dir in
// tests and the local gate; no test may ever reach a real host.
export interface Transport {
  put: (path: string, bytes: Uint8Array, mode: number) => Promise<void>;
  run: (argv: string[]) => Promise<RunResult>;
  exists: (path: string) => Promise<boolean>;
}
