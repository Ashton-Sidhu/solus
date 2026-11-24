import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";

export function questionAttachmentDraftPrefix(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  accountScope?: string,
): string {
  const threadKey = accountScope === undefined ? threadId : [threadId, accountScope];
  return `${environmentId}:question-${encodeURIComponent(JSON.stringify(threadKey))}-`;
}
export function questionAttachmentDraftKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: string,
  questionId: string,
  accountScope?: string,
): string {
  return `${questionAttachmentDraftPrefix(environmentId, threadId, accountScope)}${encodeURIComponent(JSON.stringify([requestId, questionId]))}`;
}
export const questionAttachmentPreparationAtom = Atom.make<Record<string, number>>({}).pipe(
  Atom.keepAlive,
);
export function changeQuestionAttachmentPreparation(key: string, delta: number): void {
  const counts = appAtomRegistry.get(questionAttachmentPreparationAtom);
  if (delta < 0 && !(key in counts)) return;
  appAtomRegistry.set(questionAttachmentPreparationAtom, {
    ...counts,
    [key]: Math.max(0, (counts[key] ?? 0) + delta),
  });
}
