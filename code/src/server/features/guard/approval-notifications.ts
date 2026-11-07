import type { ApprovalView } from "../../../shared/runs";

const listeners = new Set<(approval: ApprovalView) => void>();

export function onApprovalChange(listener: (approval: ApprovalView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyApproval(approval: ApprovalView): void {
  for (const listener of listeners) {
    try {
      listener(approval);
    } catch (err) {
      console.error("approval listener failed", err);
    }
  }
}
