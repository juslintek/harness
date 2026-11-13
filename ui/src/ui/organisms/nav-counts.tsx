import { hireListSchema } from "@shared/hiring";
import { proposalListSchema } from "@shared/policies";
import { approvalViewSchema } from "@shared/runs";
import { createEffect, type JSX, onCleanup } from "solid-js";
import { z } from "zod";
import { canDecideApprovals, me } from "../../auth/me";
import { createLoad } from "../../load";
import type { NavCounts } from "./sidebar";

const approvalList = z.array(approvalViewSchema);

// Renders nothing: it reads the lists the pages already read, on the same topics, and reports the
// counts. Mount it keyed by organisation, since a topic is fixed when the load is made. A count the
// role cannot fetch is left out, not shown as 0.
export function NavCountsSource(props: {
  org: { id: string; slug: string; role: string };
  onChange: (counts: NavCounts) => void;
}): JSX.Element {
  const topic = [`org:${props.org.id}`];
  const current = me();
  const approvals =
    current && canDecideApprovals(current)
      ? createLoad(
          "/api/approvals?status=pending",
          approvalList,
          // The server only lets instance admins subscribe to this topic; others would reconnect forever.
          current.user.instanceAdmin ? ["approvals"] : [],
        )
      : null;
  const hires = createLoad(`/api/orgs/${props.org.slug}/hires`, hireListSchema, topic);
  const proposals =
    props.org.role === "owner" || props.org.role === "admin"
      ? createLoad(
          `/api/orgs/${props.org.slug}/policy-proposals?status=open`,
          proposalListSchema,
          topic,
        )
      : null;
  createEffect(() =>
    props.onChange({
      approvals: approvals?.data()?.length,
      hiring: hires.data()?.filter((h) => h.status === "deciding").length,
      policies: proposals?.data()?.length,
    }),
  );
  onCleanup(() => props.onChange({}));
  return null;
}
