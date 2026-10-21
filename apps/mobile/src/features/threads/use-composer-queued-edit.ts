// Adapted from T3 Code apps/mobile/src/state/use-thread-composer-state.ts (the queued-run edit:
// `cancelQueuedRunEdit`, `saveQueuedRunEdit`, the started-run check) and
// src/features/threads/ThreadDetailScreen.tsx (focus on entering edit mode) (MIT, see UPSTREAM.md).
import type { QueueAttachment } from "@solus/contracts/session-queue";
import { MAX_ATTACHMENT_UPLOAD_COUNT } from "@solus/contracts/rpc";
import { useEffect, type RefObject } from "react";
import { Alert } from "react-native";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { ConversationMeta, ConversationStore } from "../conversation/conversation-store";
import type { PickedFile } from "../conversation/lib/attachments";
import {
  endQueuedMessageEdit,
  setQueuedMessageEditSaving,
  touchQueuedMessageEdit,
  useQueuedMessageEdit,
} from "./queued-message-edit";

/** What the composer shows and does while it holds a queued message. */
export interface ComposerQueuedEditView {
  readonly saving: boolean;
  readonly text: string;
  readonly attachments: ReadonlyArray<QueueAttachment>;
  readonly hasContent: boolean;
  readonly attachmentsFull: boolean;
  readonly setText: (text: string) => void;
  readonly removeAttachment: (attachmentId: string) => void;
  readonly attach: (files: readonly PickedFile[]) => Promise<void>;
  readonly save: () => Promise<void>;
}

/**
 * The queued message the composer edits, or null. Entering edit mode focuses
 * the composer. A message that starts (or leaves the queue from another
 * client) while it is open ends the edit; what was typed goes back to the
 * conversation's draft when that draft is empty.
 */
export function useComposerQueuedEdit(input: {
  readonly store: ConversationStore;
  readonly meta: ConversationMeta;
  readonly inputRef: RefObject<ComposerEditorHandle | null>;
  readonly conversationDraftEmpty: boolean;
  readonly restoreToConversationDraft: (text: string) => void;
}): ComposerQueuedEditView | null {
  const { store, inputRef, conversationDraftEmpty, restoreToConversationDraft } = input;
  const edit = useQueuedMessageEdit(store);
  const draft = edit?.draft ?? null;
  const saving = edit?.saving === true;
  const queueEntries = input.meta.queue.entries;

  // Entering edit mode from the queue sheet should land in a ready composer,
  // not require a second tap on a composer already holding the message.
  useEffect(() => {
    if (draft === null) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [draft, inputRef]);

  useEffect(() => {
    if (draft === null || saving) return;
    if (queueEntries.some((entry) => entry.queueId === draft.source.queueId)) return;
    const keepable = draft.text.trim().length > 0 && conversationDraftEmpty;
    if (keepable) restoreToConversationDraft(draft.text);
    endQueuedMessageEdit(store);
    Alert.alert(
      "Queued message started",
      keepable
        ? "That message already started. Your edit is back in the composer."
        : "That message already started, so the edit was discarded.",
    );
  }, [conversationDraftEmpty, draft, queueEntries, restoreToConversationDraft, saving, store]);

  if (draft === null) return null;
  const attachments = draft.attachments ?? [];
  return {
    saving,
    text: draft.text,
    attachments,
    hasContent: draft.text.trim().length > 0 || attachments.length > 0,
    attachmentsFull: attachments.length >= MAX_ATTACHMENT_UPLOAD_COUNT,
    setText: (text) => {
      draft.text = text;
      touchQueuedMessageEdit(store);
    },
    removeAttachment: (attachmentId) => {
      draft.removeFile(attachmentId);
      touchQueuedMessageEdit(store);
    },
    attach: async (files) => {
      await draft.addFiles(files);
      touchQueuedMessageEdit(store);
    },
    save: async () => {
      if (saving) return;
      if (draft.text.trim().length === 0) {
        // The host rejects an empty queued message, files or not.
        Alert.alert("Add a message", "A queued message cannot be left empty.");
        return;
      }
      setQueuedMessageEditSaving(store, true);
      try {
        await draft.save();
        endQueuedMessageEdit(store);
      } catch {
        setQueuedMessageEditSaving(store, false);
        Alert.alert(
          "Could not save the queued message",
          "It may have already started. Your edit is still in the composer.",
        );
      }
    },
  };
}

/**
 * The composer's text, files, and send state: the queued message's while it is
 * edited, else the conversation's draft. While a queued edit saves, the
 * composer is locked: the save sends a snapshot of the draft, so text typed
 * or files added after it would be lost when the save ends the edit.
 */
export function composerDraftView<Attachment>(
  queuedEdit: ComposerQueuedEditView | null,
  conversation: {
    readonly text: string;
    readonly onChangeText: (text: string) => void;
    readonly attachments: ReadonlyArray<Attachment>;
    readonly uploading: number;
  },
) {
  if (queuedEdit === null) {
    return {
      text: conversation.text,
      onChangeText: conversation.onChangeText,
      hasContent: conversation.text.trim().length > 0 || conversation.attachments.length > 0,
      stripAttachments: conversation.attachments,
      stripUploading: conversation.uploading,
      attachmentsFull: conversation.attachments.length + conversation.uploading >= MAX_ATTACHMENT_UPLOAD_COUNT,
      queuedAttachments: null,
      locked: false,
    };
  }
  const locked = queuedEdit.saving;
  return {
    text: queuedEdit.text,
    onChangeText: locked ? () => undefined : queuedEdit.setText,
    hasContent: queuedEdit.hasContent,
    stripAttachments: [],
    stripUploading: 0,
    attachmentsFull: queuedEdit.attachmentsFull,
    /** The queued message's files, in their own row (`ComposerQueuedEditAttachments`). */
    queuedAttachments:
      queuedEdit.attachments.length > 0
        ? { attachments: queuedEdit.attachments, saving: queuedEdit.saving, remove: queuedEdit.removeAttachment }
        : null,
    /** Typing, pasting, attaching, and quoting wait for the save to end. */
    locked,
  };
}
