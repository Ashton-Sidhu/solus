import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { CommonActions, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { abortComposerDraftOperations } from "../../state/composerDraftOperations";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  scheduleUnusedComposerAttachmentCleanup,
} from "../../state/use-composer-drafts";
import { submittedThreadParams } from "./thread-route-state";

/** Switch to the live thread as soon as the first prompt is safe in the local outbox. */
export async function submitNewTaskDraft(
  navigation: Pick<NavigationProp<ParamListBase>, "dispatch">,
  draftKey: string,
  submittedText: string,
  message: QueuedThreadMessage,
  enqueue: (message: QueuedThreadMessage) => Promise<void> | null,
  isCurrent?: () => boolean,
) {
  const saved = enqueue(message);
  if (saved === null) return null;
  await saved;
  if (isCurrent?.() === false) return null;
  navigation.dispatch(CommonActions.setParams(submittedThreadParams(message.environmentId, message.threadId)));
  abortComposerDraftOperations(draftKey);
  const draft = getComposerDraftSnapshot(draftKey);
  if (draft.text !== submittedText) return message.messageId;
  clearComposerDraftContent(draftKey, {
    clearModelSelection: true,
    clearWorkspaceSelection: true,
    deferAttachmentCleanup: true,
  });
  scheduleUnusedComposerAttachmentCleanup(draft.attachments);
  return message.messageId;
}
