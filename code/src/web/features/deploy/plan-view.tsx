import { CopyButton } from "../../copy-button";
import type { PlanView } from "./deploy-data";

const shell = (cmds: string[][]): string => cmds.map((c) => c.join(" ")).join("\n");

function Block({ title, text }: { title: string; text: string }): preact.JSX.Element {
  return (
    <div class="plan-block">
      <h5>{title}</h5>
      <pre>{text}</pre>
      <CopyButton text={text} label={`Copy ${title}`} />
    </div>
  );
}

// The same text the executor runs, so approving means approving exactly this.
export function PlanSteps({ plan }: { plan: PlanView }): preact.JSX.Element {
  const copy = `${plan.copy.from}\n-> ${plan.copy.to} (mode ${plan.copy.mode})`;
  return (
    <div class="plan">
      <Block title="Binary copy" text={copy} />
      <Block
        title="Pairing code file"
        text={`${plan.invite.path} (mode ${plan.invite.mode})\n${plan.invite.note}`}
      />
      <Block title="Linux unit file" text={`${plan.unit.linux.path}\n\n${plan.unit.linux.text}`} />
      <Block title="Linux commands" text={shell(plan.commands.linux)} />
      <Block
        title="macOS unit file"
        text={`${plan.unit.darwin.path}\n\n${plan.unit.darwin.text}`}
      />
      <Block title="macOS commands" text={shell(plan.commands.darwin)} />
      <Block title="Health check" text={plan.health} />
      <p class="muted">{plan.pairing}</p>
    </div>
  );
}
