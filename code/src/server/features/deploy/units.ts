export interface UnitInput {
  binary: string;
  home: string;
  port: number;
  host?: string;
}

export interface LaunchdInput extends UnitInput {
  label: string;
  logDir: string;
}

// Unit files have their own quoting and specifier rules (%, $); refusing anything outside plain
// path characters means a value can never change what the manager parses.
const SAFE = /^[A-Za-z0-9_@+=:,./-]+$/;

function safe(value: string): string {
  if (!SAFE.test(value)) throw new Error(`unsafe value for a unit file: ${JSON.stringify(value)}`);
  return value;
}

function checked(input: UnitInput): Required<UnitInput> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("port out of range");
  }
  return {
    binary: safe(input.binary),
    home: safe(input.home),
    port: input.port,
    host: safe(input.host ?? "127.0.0.1"),
  };
}

export function systemdUnit(input: UnitInput): string {
  const { binary, home, port, host } = checked(input);
  return `[Unit]
Description=Harness instance
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=${binary}
Environment=HARNESS_HOME=${home}
Environment=HARNESS_PORT=${port}
Environment=HARNESS_HOST=${host}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(input: LaunchdInput): string {
  const { binary, home, port, host } = checked(input);
  const label = safe(input.label);
  const log = `${safe(input.logDir)}/harness.log`;
  const env = Object.entries({ HARNESS_HOME: home, HARNESS_PORT: `${port}`, HARNESS_HOST: host })
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}
