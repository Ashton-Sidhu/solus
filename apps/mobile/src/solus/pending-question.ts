import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { formatAnswer } from "@solus/contracts/question-answer";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";

/**
 * A Solus question as the questions of T3's pending input card. The card of
 * an attach request (`questionId` starts with `attach-folder-`,
 * docs/plans/codebases.md §6) is a normal question with two or three
 * options, so it needs no card of its own.
 *
 * The answer of a Solus question is the chosen options, then the typed words
 * (`formatAnswer`): the attach card reads the typed words as the name of the
 * codebase that the attach makes. T3's draft rules keep only one of the two,
 * so the three rules below replace them for a Solus question.
 */
export function pendingInputQuestions(question: Pick<PendingQuestion, "questions">) {
  return question.questions.map((item) => ({
    id: item.id ?? item.question,
    header: item.header ?? item.question,
    question: item.question,
    multiSelect: item.multiSelect,
    options: item.options.map((option) => ({ ...option, description: option.description ?? "" })),
  }));
}

/** A draft answer with the chosen options and the typed words. A draft with no chosen option has no list, as T3's drafts. */
function chosenAndTyped(chosen: readonly string[], typed: string): PendingUserInputDraftAnswer {
  if (chosen.length === 0) return { customAnswer: typed };
  return { customAnswer: typed, selectedOptionValues: chosen };
}

/** A tap on an option. The typed words stay. A question with one choice takes the new option, and a second tap on the chosen option takes the choice back. */
export function toggleQuestionOption(
  question: { readonly multiSelect?: boolean | undefined },
  draft: PendingUserInputDraftAnswer | undefined,
  value: string,
): PendingUserInputDraftAnswer {
  const chosen = draft?.selectedOptionValues ?? [];
  const next = chosen.includes(value)
    ? chosen.filter((entry) => entry !== value)
    : question.multiSelect
      ? [...chosen, value]
      : [value];
  return chosenAndTyped(next, draft?.customAnswer ?? "");
}

/** The words that the person typed in the answer field. The chosen options stay. */
export function typeQuestionRemark(
  draft: PendingUserInputDraftAnswer | undefined,
  text: string,
): PendingUserInputDraftAnswer {
  return chosenAndTyped(draft?.selectedOptionValues ?? [], text);
}

/** True for an option that the person chose, also while the answer field has words. */
export function isQuestionOptionSelected(
  draft: PendingUserInputDraftAnswer | undefined,
  value: string,
): boolean {
  return draft?.selectedOptionValues?.includes(value) ?? false;
}

/** The answer that the host gets for each question: the labels of the chosen options, then ` — ` and the typed words, or only one of the two. */
export function pendingInputAnswers(
  questions: readonly { readonly id: string }[],
  drafts: Readonly<Record<string, PendingUserInputDraftAnswer>>,
  attachmentPaths?: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      formatAnswer(
        drafts[question.id]?.selectedOptionValues?.join(", ") ?? "",
        drafts[question.id]?.customAnswer,
        attachmentPaths?.[question.id],
      ),
    ]),
  );
}
