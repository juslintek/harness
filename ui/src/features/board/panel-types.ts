import type { TaskDetail, TaskView } from "@shared/board";
import type { OrgDetail } from "@shared/orgs";
import type { Notice } from "./move";
import type { Work } from "./wakeups";

export interface PanelProps {
  id: string;
  detail: OrgDetail;
  tasks: () => TaskView[];
  version: () => unknown;
  notice: () => Notice | null;
  move: (taskId: string, to: TaskView["status"], beforeId?: string) => Promise<boolean>;
  reload: () => Promise<void>;
  handleOf: (id: string | null) => string;
  work: (taskId: string) => Work | undefined;
}

export type WithTask = PanelProps & { task: () => TaskView };
export type WithInfo = PanelProps & { info: () => TaskDetail };
