import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { drainCommits, ensureVaultRepo } from "./git-log";
import { buildMemoryIndex } from "./index-file";
import { logRead } from "./index-log";
import { getIndexedByDisk } from "./index-repo";
import { backlinks, searchNotes } from "./index-search";
import {
  listLessons,
  onLessonDecided,
  onLessonProposed,
  proposeLessons,
  reviewerFor,
} from "./lessons";
import { decideLesson } from "./lessons-decide";
import type { Located, Viewer } from "./paths";
import { reconcile } from "./reconcile";
import { startRetro } from "./retro";
import { createNote, deleteNote, readNote, renameNote, updateNote } from "./store";
import { MemoryError, onMemoryChange, type WriteCtx } from "./store-kit";
import { revertWrite } from "./store-revert";
import { vaultDir } from "./vault";
import {
  agentViewer,
  type ProjectSlugs,
  projectSlugs,
  resolveNotePath,
  runProject,
  virtualPathOf,
} from "./viewer";
import { watchVault } from "./watcher";

export type { Located, ProjectSlugs, Viewer, WriteCtx };

export {
  agentViewer,
  backlinks,
  buildMemoryIndex,
  createNote,
  decideLesson,
  deleteNote,
  getIndexedByDisk,
  listLessons,
  logRead,
  MemoryError,
  onLessonDecided,
  onLessonProposed,
  onMemoryChange,
  projectSlugs,
  proposeLessons,
  readNote,
  renameNote,
  resolveNotePath,
  revertWrite,
  reviewerFor,
  runProject,
  searchNotes,
  startRetro,
  updateNote,
  virtualPathOf,
};

export function startMemory(db: Database, deps: { home: string }): () => Promise<void> {
  mkdirSync(vaultDir(deps.home), { recursive: true, mode: 0o700 });
  ensureVaultRepo(deps.home).catch((e: Error) => {
    console.error(`memory: git init failed: ${e.message}`);
  });
  reconcile(db, deps.home);
  const stopWatch = watchVault(db, deps.home);
  return async () => {
    stopWatch();
    await drainCommits();
  };
}
