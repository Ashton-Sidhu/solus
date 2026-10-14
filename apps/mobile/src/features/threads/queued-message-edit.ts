// Adapted from T3 Code apps/mobile/src/state/queued-run-edit.ts (MIT, see UPSTREAM.md).
/**
 * Editing a message that is already queued on the host.
 *
 * The composer is reused rather than duplicated, so the edit keeps its text and
 * files in its own `QueueDraft`: the conversation's own draft is never touched
 * and is waiting unchanged when the edit is cancelled. The record is in memory
 * only: an edit that does not survive a restart is better than a composer that
 * reopens pointed at a message the host may have already started.
 */
import type { QueuedPromptSnapshot } from "@solus/contracts/types";

import { useListened } from "../../app/app-context";
import { Listeners } from "../../lib/listeners";
import type { ConversationStore } from "../conversation/conversation-store";
import { QueueDraft } from "../conversation/lib/queue-edit";

export interface QueuedMessageEdit {
  readonly draft: QueueDraft;
  readonly saving: boolean;
}

const edits = new WeakMap<ConversationStore, QueuedMessageEdit>();
const changes = new Listeners();

function set(store: ConversationStore, edit: QueuedMessageEdit | null): void {
  if (edit === null) {
    if (!edits.delete(store)) return;
  } else {
    edits.set(store, edit);
  }
  changes.notify();
}

/** Loads the queued message into its own draft and puts the composer in edit mode. */
export function beginQueuedMessageEdit(store: ConversationStore, entry: QueuedPromptSnapshot): void {
  set(store, { draft: new QueueDraft(entry, store.controller), saving: false });
}

/** Publishes a change made to the edit's draft (text or files). */
export function touchQueuedMessageEdit(store: ConversationStore): void {
  const edit = edits.get(store);
  if (edit) set(store, { ...edit });
}

export function setQueuedMessageEditSaving(store: ConversationStore, saving: boolean): void {
  const edit = edits.get(store);
  if (edit && edit.saving !== saving) set(store, { ...edit, saving });
}

export function endQueuedMessageEdit(store: ConversationStore): void {
  set(store, null);
}

export function useQueuedMessageEdit(store: ConversationStore): QueuedMessageEdit | null {
  return useListened(changes, () => edits.get(store) ?? null);
}
