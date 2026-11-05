// Part B of the Phase 5 gate: live walkthrough with Alice. Stops before each step
// with the exact text of what will happen and waits for confirmation.
import readline from "node:readline/promises";

async function waitEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function runPartB(): Promise<void> {
  console.log("\n=======================================================");
  console.log("Gate 5 Part B: Live verification walkthrough");
  console.log("=======================================================\n");

  console.log("Step (a): Tunnel selection");
  console.log(
    "What will happen: Select and start an HTTPS tunnel (Tailscale Serve recommended, tailnet only).",
  );
  console.log("Cloudflare or Tailscale Funnel will only be started if explicitly confirmed.\n");
  await waitEnter("Press [Enter] to proceed to tunnel setup or [Ctrl+C] to abort: ");

  console.log("\nStep (b): Origin restart & passkey enrollment");
  console.log("What will happen: The instance restarts using the tunnel HTTPS origin.");
  console.log(
    "An enrollment URL will be generated. Open the link on your phone/browser to enrol a passkey (Touch ID or device PIN).\n",
  );
  await waitEnter("Press [Enter] to continue once enrolled: ");

  console.log("\nStep (c): Phone PWA push subscription");
  console.log(
    "What will happen: In the PWA on your phone, open Settings -> Notifications and tap 'Enable push on this device'.",
  );
  console.log("This registers a Web Push subscription with VAPID keys.\n");
  await waitEnter("Press [Enter] to continue once subscribed: ");

  console.log("\nStep (d): Live approval & step-up verification");
  console.log(
    "What will happen: An agent task will trigger an L1 guard rule and raise an approval.",
  );
  console.log("Your phone will receive an encrypted Web Push notification with the approval link.");
  console.log("Tapping the push opens the approval page where you approve with passkey step-up.\n");
  await waitEnter("Press [Enter] to complete live walkthrough: ");

  console.log("\nPart B walkthrough completed.\n");
}
