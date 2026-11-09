import { expect, test } from "bun:test";
import { launchdPlist, systemdUnit } from "./units";

const input = { binary: "/home/u/.harness/bin/harness", home: "/home/u/.harness/home", port: 4100 };

test("systemd unit restarts on failure and carries only the three env values", () => {
  expect(systemdUnit(input)).toBe(`[Unit]
Description=Harness instance
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=/home/u/.harness/bin/harness
Environment=HARNESS_HOME=/home/u/.harness/home
Environment=HARNESS_PORT=4100
Environment=HARNESS_HOST=127.0.0.1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`);
});

test("launchd plist keeps the job alive with a throttle and logs under logDir", () => {
  const plist = launchdPlist({
    ...input,
    host: "0.0.0.0",
    label: "dev.harness.instance",
    logDir: "/Users/u/.harness/logs",
  });
  for (const line of [
    "<string>dev.harness.instance</string>",
    "<string>/home/u/.harness/bin/harness</string>",
    "<key>HARNESS_PORT</key>\n    <string>4100</string>",
    "<key>HARNESS_HOST</key>\n    <string>0.0.0.0</string>",
    "<key>KeepAlive</key>\n  <true/>",
    "<key>ThrottleInterval</key>\n  <integer>10</integer>",
    "<string>/Users/u/.harness/logs/harness.log</string>",
  ]) {
    expect(plist).toContain(line);
  }
});

test("no unit text mentions a token or a secret", () => {
  const texts = [systemdUnit(input), launchdPlist({ ...input, label: "x.y", logDir: "/l" })];
  for (const text of texts) expect(text).not.toMatch(/token|secret|password|key(?!>)/i);
});

test("values that could change how the manager parses the file are refused", () => {
  for (const bad of ["/a b", "/a\nExecStop=/bin/sh", "/a$HOME", "/a%h", '/a"b', "/a<b"]) {
    expect(() => systemdUnit({ ...input, binary: bad })).toThrow();
    expect(() => launchdPlist({ ...input, home: bad, label: "x", logDir: "/l" })).toThrow();
  }
  expect(() => systemdUnit({ ...input, port: 70000 })).toThrow();
});
