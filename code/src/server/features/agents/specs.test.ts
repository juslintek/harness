import { expect, test } from "bun:test";
import { type AgentSpec, loadAgentSpecs } from "./specs";

const stub: AgentSpec = {
  id: "fake",
  name: "Fake",
  lane: "acp",
  bin: "/bin/echo",
  args: [],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
  mcp: false,
};

test("HARNESS_TEST_AGENTS replaces the agent list when HARNESS_TEST=1", () => {
  const specs = loadAgentSpecs({ HARNESS_TEST: "1", HARNESS_TEST_AGENTS: JSON.stringify([stub]) });
  expect(specs).toEqual([stub]);
});

test("HARNESS_TEST_AGENTS is ignored without HARNESS_TEST=1", () => {
  const env = { HARNESS_TEST_AGENTS: JSON.stringify([stub]) };
  expect(loadAgentSpecs(env).map((spec) => spec.id)).toContain("claude");
  expect(loadAgentSpecs({ ...env, HARNESS_TEST: "true" }).map((spec) => spec.id)).not.toContain(
    "fake",
  );
});

test("a malformed override fails loudly instead of falling back", () => {
  expect(() =>
    loadAgentSpecs({ HARNESS_TEST: "1", HARNESS_TEST_AGENTS: '[{"id":"x"}]' }),
  ).toThrow();
});
