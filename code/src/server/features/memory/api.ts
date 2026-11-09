import type { Database } from "bun:sqlite";
import { assertVaultGit, drainCommits, queueUncommitted } from "./git-log";
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
import { finishAcceptedLessons } from "./lessons-recover";
import type { Located, Viewer } from "./paths";
import { reconcile } from "./reconcile";
import { readNoteText, removeReplicatedNote, writeReplicatedNote } from "./replicate";
import { startRetro } from "./retro";
import { createNote, deleteNote, readNote, renameNote, updateNote } from "./store";
import { MemoryError, onMemoryChange, type WriteCtx } from "./store-kit";
import { revertWrite } from "./store-revert";
import { securePrivateVault } from "./vault";
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
  readNoteText,
  removeReplicatedNote,
  renameNote,
  resolveNotePath,
  revertWrite,
  reviewerFor,
  runProject,
  searchNotes,
  startRetro,
  updateNote,
  virtualPathOf,
  writeReplicatedNote,
};

export function startMemory(db: Database, deps: { home: string }): () => Promise<void> {
  assertVaultGit(deps.home);
  securePrivateVault(deps.home);
  queueUncommitted(deps.home, db).catch((e: Error) => {
    console.error(`memory: git init failed: ${e.message}`);
  });
  // Watching first means a file written while reconcile walks is still seen; syncOutside is hash-checked, so a repeat is a no-op.
  const stopWatch = watchVault(db, deps.home);
  let finishing: Promise<void>;
  try {
    reconcile(db, deps.home);
    // A crash between claiming a lesson and writing its note leaves it accepted without a note.
    finishing = finishAcceptedLessons(db, deps.home);
  } catch (e) {
    stopWatch();
    throw e;
  }
  return async () => {
    stopWatch();
    await finishing;
    await drainCommits();
  };
}
