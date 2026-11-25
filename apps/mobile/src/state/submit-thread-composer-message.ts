import type { QueuedThreadMessage } from "./thread-outbox-model";
import {
  clearComposerDraftContent,
  appendComposerDraftAttachments,
  mergeComposerDraftContent,
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  scheduleUnusedComposerAttachmentCleanup,
  type ComposerDraft,
  type ComposerDraftContent,
} from "./use-composer-drafts";
import { appAtomRegistry } from "./atom-registry";

/** An approval response may finish after the user changes the draft or pastes context. */
export async function confirmComposerDispatch(
  key: string,
  draft: ComposerDraft,
  beforeDispatch: (text: string, hasAttachmentsOrContext: boolean) => Promise<boolean | "responded">,
  hasAttachmentsOrContext: boolean,
  isCurrent?: () => boolean,
) {
  const response = await beforeDispatch(draft.text.trim(), hasAttachmentsOrContext);
  if (!response || isCurrent?.() === false || appAtomRegistry.get(composerContextImportsAtom)[key])
    return false;
  const current = getComposerDraftSnapshot(key);
  if (
    current.text !== draft.text ||
    JSON.stringify(current.context) !== JSON.stringify(draft.context) ||
    JSON.stringify(current.modelSelection) !== JSON.stringify(draft.modelSelection) ||
    current.runtimeMode !== draft.runtimeMode ||
    current.interactionMode !== draft.interactionMode ||
    current.attachments.length !== draft.attachments.length ||
    current.attachments.some((attachment, index) => attachment.id !== draft.attachments[index]?.id)
  ) return false;
  if (response === "responded") clearComposerDraftContent(key);
  return response === true;
}

/** A follow-up gets its feed anchor at submission. Only a failed local save restores its draft. */
export function submitThreadComposerMessage(
  key: string,
  message: QueuedThreadMessage,
  enqueue: (message: QueuedThreadMessage) => Promise<void> | null,
  options: {
    content?: ComposerDraftContent;
    isCurrent?: () => boolean;
    onSaved?: () => void;
    onSaveError: (error: unknown) => void;
  },
) {
  const saved = enqueue(message);
  if (saved === null) return null;
  const content = options.content ?? message;
  clearComposerDraftContent(key, { deferAttachmentCleanup: true });
  void saved.then(
    () => {
      if (options.isCurrent?.() === false) return;
      options.onSaved?.();
      scheduleUnusedComposerAttachmentCleanup(message.attachments);
    },
    (error: unknown) => {
      if (options.isCurrent?.() === false) return;
      void mergeComposerDraftContent(key, { ...content, attachments: [] }).catch(options.onSaveError);
      appendComposerDraftAttachments(key, content.attachments, { restore: true });
      options.onSaveError(error);
    },
  );
  return message.messageId;
}
