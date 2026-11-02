export type Status =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export interface TaskView {
  id: string;
  orgId: string;
  projectId: string;
  number: number;
  parentId: string | null;
  title: string;
  description: string;
  status: Status;
  rank: number;
  assigneeId: string | null;
  holderId: string | null;
  checkedOutAt: number | null;
  estimateMinutes: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommentView {
  id: string;
  taskId: string;
  authorId: string | null;
  body: string;
  createdAt: number;
}

export interface TaskDetail {
  task: TaskView;
  deps: TaskView[];
  subtasks: TaskView[];
  comments: CommentView[];
}
