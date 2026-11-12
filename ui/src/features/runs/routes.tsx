import type { JSX } from "solid-js";
import { canDecideApprovals, me } from "../../auth/me";
import { routeParts } from "../../route";
import { State } from "../../ui/primitives";
import { AgentsPage } from "../agents/agents-page";
import { ApprovalPage, ApprovalsPage } from "../approvals/approvals-page";
import { SearchPage } from "../search/search-page";
import { RunPage } from "./run-page";
import { RunsPage } from "./runs-page";

const unavailable = (): JSX.Element => <State kind="empty" message="Not available." />;

// The instance pages and approvals. "#/" is the runs list for an instance admin; for anyone else it
// belongs to the board, so nothing is returned and the next route gets it. A page is returned as a
// function so a changed route builds a fresh one.
export function runsRoute(): (() => JSX.Element) | undefined {
  const [head, id] = routeParts();
  const current = me();
  if (!current) return undefined;
  const admin = current.user.instanceAdmin;
  const only = (page: () => JSX.Element): (() => JSX.Element) => (admin ? page : unavailable);
  if (head === "approvals") {
    if (id) return () => <ApprovalPage id={id} />;
    return canDecideApprovals(current) ? () => <ApprovalsPage /> : unavailable;
  }
  if (head === "agents") return only(() => <AgentsPage />);
  if (head === "search") return only(() => <SearchPage />);
  if (head === "runs") return only(() => (id ? <RunPage id={id} /> : <RunsPage />));
  return head === undefined && admin ? () => <RunsPage /> : undefined;
}
