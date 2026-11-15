import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEnrollment } from "../src/server/features/auth/api";
import { bootInstance, createReport, type Instance, type Report } from "./gate-5-kit";
import { freePort, ROOT, tempDir } from "./gate-6-kit";
import { androidEnv, runCmd, runCmdAsync } from "./gate-mobile-kit";
import { type SeededState, seedMobileGate } from "./gate-mobile-seed";

const IOS_UDID = "BFC10D6C-44F3-41E2-823B-95BCB6BCA77D";
const ANDROID_AVD = "medium_phone";
const SCREENSHOT_DIR = join(ROOT, "screenshots", "mobile");

async function createP256Signer(): Promise<{
  spki: string;
  sign: (payload: string) => Promise<string>;
}> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", kp.publicKey)).toString(
    "base64url",
  );
  const sign = async (payload: string): Promise<string> =>
    Buffer.from(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        kp.privateKey,
        new TextEncoder().encode(payload),
      ),
    ).toString("base64url");
  return { spki, sign };
}

async function runBackendConformance(
  inst: Instance,
  seed: SeededState,
  report: Report,
): Promise<void> {
  const code = createEnrollment(inst.db, { userId: seed.adminUserId, ttlMs: 600_000 });
  const { spki, sign } = await createP256Signer();

  const optRes = await inst.client.call("POST", `/api/auth/mobile/enroll/${code}/options`, {
    body: { deviceName: "Gate Probe", platform: "ios", email: "gate@mobile.test", name: "Gate" },
  });
  const opt = (await optRes.json()) as { challengeId: string; nonce: string; userId: string };
  const enrollSig = await sign(
    `harness-mobile-enroll-v1|${inst.origin}|${opt.challengeId}|${opt.nonce}`,
  );
  const verRes = await inst.client.call("POST", `/api/auth/mobile/enroll/${code}/verify`, {
    body: {
      challengeId: opt.challengeId,
      userId: opt.userId,
      deviceName: "Gate Probe",
      platform: "ios",
      publicKeySpki: spki,
      signature: enrollSig,
    },
  });
  const ver = (await verRes.json()) as { token?: string };
  const token = ver.token ?? "";
  report.check(1, verRes.ok && token.startsWith("hmob_"), "backend mobile enroll");

  const headers = { authorization: `Bearer ${token}`, origin: inst.origin };
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const me = (await (await fetch(`${inst.origin}/api/auth/me`, { headers })).json()) as {
    session: { id: string };
  };
  const stepOptRes = await fetch(`${inst.origin}/api/auth/mobile/step-up/options`, {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  const stepOpt = (await stepOptRes.json()) as { challengeId: string; nonce: string };
  const stepSig = await sign(
    `harness-mobile-stepup-v1|${inst.origin}|${me.session.id}|${stepOpt.challengeId}|${stepOpt.nonce}`,
  );
  const stepVerRes = await fetch(`${inst.origin}/api/auth/mobile/step-up/verify`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ challengeId: stepOpt.challengeId, signature: stepSig }),
  });
  report.check(2, stepVerRes.ok, "backend mobile step-up");
  const hex = "0123456789abcdef0123456789abcdef";
  const pushRes = await fetch(`${inst.origin}/api/notify/push/mobile`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      relayUrl: "https://93.184.216.34/relay",
      platform: "ios",
      appId: "dev.harness.mobile",
      pushToken: hex,
      relaySecret: hex,
    }),
  });
  report.check(3, pushRes.status === 201, "backend mobile push subscribe");
}

function ensureIosBooted(): void {
  const boot = runCmd(["xcrun", "simctl", "boot", IOS_UDID], { allowFail: true });
  if (!boot.ok && !boot.stderr.includes("Unable to boot device in current state: Booted")) {
    throw new Error(`simctl boot failed: ${boot.stderr}`);
  }
  runCmd(["xcrun", "simctl", "bootstatus", IOS_UDID, "-b"]);
}

async function runIosGate(inst: Instance, seed: SeededState, report: Report): Promise<void> {
  const iosDir = join(ROOT, "ios");
  ensureIosBooted();
  runCmd(["xcodegen", "generate"], { cwd: iosDir });

  const testRes = await runCmdAsync(
    [
      "xcodebuild",
      "test",
      "-project",
      "Harness.xcodeproj",
      "-scheme",
      "Harness",
      "-destination",
      `platform=iOS Simulator,id=${IOS_UDID}`,
    ],
    {
      cwd: iosDir,
      env: {
        TEST_RUNNER_HARNESS_TEST_ORIGIN: inst.origin,
        TEST_RUNNER_HARNESS_TEST_ENROLL_CODE: seed.iosEnrollCode,
        TEST_RUNNER_HARNESS_TEST_PAIR_CODE: seed.iosPairCode,
      },
      allowFail: true,
    },
  );
  if (!testRes.ok) {
    console.error(testRes.stderr.slice(-1500) || testRes.stdout.slice(-1500));
  }
  report.check(4, testRes.ok, "ios xcodegen + xcodebuild test");

  ensureIosBooted();
  runCmd(["xcrun", "simctl", "launch", IOS_UDID, "dev.harness.mobile"], { allowFail: true });
  Bun.sleepSync(1000);
  for (const mode of ["light", "dark"] as const) {
    runCmd(["xcrun", "simctl", "ui", IOS_UDID, "appearance", mode]);
    Bun.sleepSync(800);
    runCmd([
      "xcrun",
      "simctl",
      "io",
      IOS_UDID,
      "screenshot",
      join(SCREENSHOT_DIR, `ios-${mode}.png`),
    ]);
  }
  report.check(5, true, "ios light/dark screenshots");
}

async function ensureAndroidEmulator(env: Record<string, string>): Promise<void> {
  const devices = runCmd(["adb", "devices"], { env });
  if (!devices.stdout.includes("emulator-")) {
    Bun.spawn(
      ["emulator", "-avd", ANDROID_AVD, "-no-snapshot-load", "-no-audio", "-no-boot-anim"],
      {
        env: { ...process.env, ...env },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
  }
  runCmd(["adb", "wait-for-device"], { env });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const prop = runCmd(["adb", "shell", "getprop", "sys.boot_completed"], {
      env,
      allowFail: true,
    });
    if (prop.stdout.trim() === "1") return;
    await Bun.sleep(1000);
  }
  throw new Error("timed out waiting for Android emulator boot");
}

function captureAndroidScreenshot(name: string, env: Record<string, string>): void {
  const proc = Bun.spawnSync(["adb", "exec-out", "screencap", "-p"], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`adb screencap failed: ${proc.stderr.toString()}`);
  writeFileSync(join(SCREENSHOT_DIR, name), proc.stdout);
}

async function runAndroidGate(inst: Instance, seed: SeededState, report: Report): Promise<void> {
  const androidDir = join(ROOT, "android");
  const env = androidEnv();
  const unitRes = runCmd(["./gradlew", "testDebugUnitTest", "assembleDebug"], {
    cwd: androidDir,
    env,
    allowFail: true,
  });
  report.check(6, unitRes.ok, "android unit + assembleDebug");

  await ensureAndroidEmulator(env);
  runCmd(["adb", "reverse", `tcp:${inst.port}`, `tcp:${inst.port}`], { env });
  const uiRes = await runCmdAsync(
    [
      "./gradlew",
      "connectedDebugAndroidTest",
      `-Pandroid.testInstrumentationRunnerArguments.harnessOrigin=${inst.origin}`,
      `-Pandroid.testInstrumentationRunnerArguments.harnessEnrollCode=${seed.androidEnrollCode}`,
      `-Pandroid.testInstrumentationRunnerArguments.harnessPairCode=${seed.androidPairCode}`,
      `-Pandroid.testInstrumentationRunnerArguments.harnessPairCodeDark=${seed.androidPairCodeDark}`,
    ],
    { cwd: androidDir, env, allowFail: true },
  );
  report.check(7, uiRes.ok, "android connectedDebugAndroidTest");

  runCmd(["./gradlew", "installDebug"], { cwd: androidDir, env, allowFail: true });
  runCmd(["adb", "shell", "am", "start", "-W", "-n", "dev.harness.mobile/.MainActivity"], {
    env,
    allowFail: true,
  });
  await Bun.sleep(1500);
  for (const [night, file] of [
    ["no", "android-light.png"],
    ["yes", "android-dark.png"],
  ] as const) {
    runCmd(["adb", "shell", "cmd", "uimode", "night", night], { env });
    await Bun.sleep(800);
    captureAndroidScreenshot(file, env);
  }
  report.check(8, true, "android light/dark screenshots");
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const home = tempDir("mobile");
  process.env.HARNESS_ORIGIN = origin;
  process.env.HARNESS_HOME = home;

  const inst = await bootInstance({ home, port, origin });
  const report = createReport();
  try {
    const seed = await seedMobileGate(inst);
    await runBackendConformance(inst, seed, report);
    await runIosGate(inst, seed, report);
    inst.db.run(
      "UPDATE approvals SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?",
      [seed.approvalId],
    );
    await runAndroidGate(inst, seed, report);
  } catch (err) {
    console.error(`gate-mobile stopped early: ${(err as Error).stack ?? err}`);
  } finally {
    await inst.stop();
  }

  const passed = report.passed();
  const failures = report.failures();
  console.log(`gate-mobile: ${passed}/8 assertions passed`);
  for (const f of failures) console.log(` - FAIL ${f}`);
  process.exit(passed === 8 && failures.length === 0 ? 0 : 1);
}

await main();
