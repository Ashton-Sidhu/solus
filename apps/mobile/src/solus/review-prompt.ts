import type { OrchestrationMessageContext } from "@t3tools/contracts";
import {
  replaceComposerContextReferences,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import { formatReviewCommentBlock } from "../features/review/reviewCommentSelection";

export function sessionPromptText(text: string, context?: OrchestrationMessageContext): string {
  if (!context) return text;
  const records = new Map(context.records.map((record) => [record.contextId, record]));
  const expanded = replaceComposerContextReferences(text, (reference) => {
    const item = records.get(reference.contextId);
    return item?.kind === "review-comment" && !("payload" in item) && !item.pullRequest
      ? formatReviewCommentBlock(item)
      : reference.source;
  });
  return projectComposerContextForProvider({ text: expanded, records: context.records });
}
