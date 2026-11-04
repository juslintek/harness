// The server scrubs the environment it hands to agents, so the scenario's script travels as an
// argument instead: argv[2] is the JSON step list, argv[3] a marker the suite greps for to prove
// the process is gone.
process.env.FAKE_AGENT_SCRIPT = process.argv[2] ?? "[]";
await import("../scripts/fake-acp-agent");

export {};
