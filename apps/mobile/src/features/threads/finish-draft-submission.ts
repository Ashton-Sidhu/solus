import { CommonActions, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { abortComposerDraftOperations } from "../../state/composerDraftOperations";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  scheduleUnusedComposerAttachmentCleanup,
} from "../../state/use-composer-drafts";
import { submittedThreadParams } from "./thread-route-state";

/** Switch to the live thread as soon as the first prompt is safe in the local outbox. */
export function finishDraftSubmission(
  navigation: Pick<NavigationProp<ParamListBase>, "dispatch">,
  draftKey: string,
  submittedText: string,
  environmentId: string,
  threadId: string,
) {
  navigation.dispatch(CommonActions.setParams(submittedThreadParams(environmentId, threadId)));
  abortComposerDraftOperations(draftKey);
  const draft = getComposerDraftSnapshot(draftKey);
  if (draft.text !== submittedText) return;
  clearComposerDraftContent(draftKey, {
    clearModelSelection: true,
    clearWorkspaceSelection: true,
    deferAttachmentCleanup: true,
  });
  scheduleUnusedComposerAttachmentCleanup(draft.attachments);
}
