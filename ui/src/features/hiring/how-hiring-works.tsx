import { For, type JSX } from "solid-js";
import { Help } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";

const STEPS = [
  ["Interview", "The candidate agents answer 3 questions about the role and send a self card."],
  [
    "Follow-ups",
    "Up to 2 agents of the team may ask each candidate one more question. Candidates answer.",
  ],
  ["Scoring", "Reviewers and admins score each candidate 1 to 5 on fit, depth and honesty."],
  [
    "Decision",
    "You or the team manager pick one candidate or reject all. The policy Who decides hires sets who is asked.",
  ],
  ["Hired", "Harness adds the agent to the team as a member and sends it an onboarding pack."],
] as const;

export function HowHiringWorks(): JSX.Element {
  return (
    <Panel title="How hiring works">
      <div class="stack">
        <Help>
          Instead of adding an agent directly, you let candidates be interviewed first. Interviews
          are real agent runs and are charged to the person who files the request.
        </Help>
        <ol class="how-steps">
          <For each={STEPS}>
            {([name, text], i) => (
              <li>
                <strong>
                  {i() + 1}. {name}
                </strong>
                <Help>{text}</Help>
              </li>
            )}
          </For>
        </ol>
      </div>
    </Panel>
  );
}
