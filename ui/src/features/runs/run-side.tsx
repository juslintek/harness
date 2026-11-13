import type { RunView } from "@shared/runs";
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { CopyButton } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import type { Usage } from "./data";
import { Fact } from "./fact";
import { fmtCost } from "./format";

const number = new Intl.NumberFormat();

export function UsagePanel(props: { run: RunView; usage: Usage | undefined }): JSX.Element {
  return (
    <Panel title="Cost and usage">
      <dl class="facts">
        <Fact label="Cost">
          <span class="mono">{fmtCost(props.usage?.reportedCostUsd) ?? "not known"}</span>
        </Fact>
        <Fact label="Tokens in">
          <span class="mono">{number.format(props.run.inputTokens)}</span>
        </Fact>
        <Fact label="Tokens out">
          <span class="mono">{number.format(props.run.outputTokens)}</span>
        </Fact>
        <Show when={props.usage}>
          {(usage) => (
            <>
              <Fact label="Cache read">
                <span class="mono">{number.format(usage().cacheReadTokens)}</span>
              </Fact>
              <Fact label="Usage reports">
                <span class="mono">{usage().events}</span>
              </Fact>
            </>
          )}
        </Show>
      </dl>
    </Panel>
  );
}

export function DetailsPanel(props: { run: RunView }): JSX.Element {
  return (
    <Panel
      title="Details"
      actions={
        props.run.branch ? (
          <CopyButton text={props.run.branch} label="Copy branch" tone="ghost" />
        ) : undefined
      }
    >
      <dl class="facts">
        <Fact label="Agent">{props.run.agentId}</Fact>
        <Fact label="Model">
          <span class="mono">{props.run.model ?? "default model"}</span>
        </Fact>
        <Fact label="Repo">
          <span class="mono">{props.run.repo}</span>
        </Fact>
        <Show when={props.run.branch}>
          {(branch) => (
            <Fact label="Branch">
              <span class="mono">{branch()}</span>
            </Fact>
          )}
        </Show>
        <Fact label="Prompt">{props.run.prompt}</Fact>
      </dl>
    </Panel>
  );
}
