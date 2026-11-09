import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import type { TargetView } from "../../../shared/distribution";
import { type Exec, sshTransport } from "./ssh-transport";

// Nothing here ever runs ssh or scp: exec only records the argv it was given.
function recorder(): { calls: string[][]; exec: Exec; localCopies: string[] } {
  const calls: string[][] = [];
  const localCopies: string[] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "scp") {
      const local = argv[argv.length - 2] ?? "";
      expect(existsSync(local)).toBe(true);
      localCopies.push(local);
      expect(statSync(local).mode & 0o777).toBe(0o600);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec, localCopies };
}

const target: TargetView = {
  id: "ssh:box",
  kind: "ssh",
  name: "box",
  address: "10.0.0.5",
  user: "deploy",
  port: 2222,
};
const SAFE_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];

test("run builds one ssh argv with strict options and a quoted remote command", async () => {
  const { calls, exec } = recorder();
  await sshTransport(target, exec).run(["uname", "-s"]);
  expect(calls).toEqual([
    ["ssh", ...SAFE_OPTIONS, "-p", "2222", "-l", "deploy", "--", "10.0.0.5", "'uname' '-s'"],
  ]);
});

test("hostile words stay inside one quoted word and never reach the local argv as extra items", async () => {
  const { calls, exec } = recorder();
  const hostile = `a b'; rm -rf / $(id) \`id\``;
  await sshTransport(target, exec).run(["echo", hostile]);
  const argv = calls[0] ?? [];
  expect(argv).toHaveLength(SAFE_OPTIONS.length + 8);
  expect(argv.at(-1)).toBe(`'echo' 'a b'\\''; rm -rf / $(id) \`id\`'`);
});

test("put copies a file with the final mode, then fixes the mode and creates the directory", async () => {
  const { calls, exec, localCopies } = recorder();
  await sshTransport(target, exec).put(
    "/home/u/.harness/home/pair-invite",
    Buffer.from("x"),
    0o600,
  );
  expect(calls.map((argv) => argv[0])).toEqual(["ssh", "scp", "ssh"]);
  expect(calls[0]?.at(-1)).toBe("'mkdir' '-p' '/home/u/.harness/home'");
  const scp = calls[1] ?? [];
  expect(scp).toEqual([
    "scp",
    "-q",
    ...SAFE_OPTIONS,
    "-P",
    "2222",
    "--",
    localCopies[0] ?? "",
    "deploy@10.0.0.5:/home/u/.harness/home/pair-invite",
  ]);
  expect(calls[2]?.at(-1)).toBe("'chmod' '600' '/home/u/.harness/home/pair-invite'");
  expect(existsSync(localCopies[0] ?? "")).toBe(false);
});

test("hostile host, user, port and path values are refused before anything runs", async () => {
  const { calls, exec } = recorder();
  for (const address of ["-oProxyCommand=id", "a b", "h;id", "h$(id)", "h'x", ""]) {
    expect(() => sshTransport({ ...target, address }, exec)).toThrow();
  }
  expect(() => sshTransport({ ...target, user: "-oFoo" }, exec)).toThrow();
  expect(() => sshTransport({ ...target, user: "a;b" }, exec)).toThrow();
  expect(() => sshTransport({ ...target, port: 0 }, exec)).toThrow();
  const transport = sshTransport(target, exec);
  for (const path of ["/a b", "/a;id", "/a/$(id)", "/a/../b", "rel/path", "/a'b"]) {
    await expect(transport.put(path, new Uint8Array(), 0o644)).rejects.toThrow();
    await expect(transport.exists(path)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

test("exists maps the exit code and an ipv6 host is bracketed for scp", async () => {
  const code = { value: 1 };
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    return { code: code.value, stdout: "", stderr: "" };
  };
  const transport = sshTransport({ ...target, address: "fe80::1", user: undefined }, exec);
  expect(await transport.exists("/x")).toBe(false);
  code.value = 0;
  expect(await transport.exists("/x")).toBe(true);
  await transport.put("/x", new Uint8Array(), 0o644);
  expect(calls.find((argv) => argv[0] === "scp")?.at(-1)).toBe("[fe80::1]:/x");
});

test("a failing scp surfaces as an error", async () => {
  const exec: Exec = async (argv) => ({
    code: argv[0] === "scp" ? 1 : 0,
    stdout: "",
    stderr: "Host key verification failed.",
  });
  await expect(sshTransport(target, exec).put("/x", new Uint8Array(), 0o644)).rejects.toThrow(
    "Host key verification failed",
  );
});
