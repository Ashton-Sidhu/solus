import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { formatAnswer } from "@solus/contracts/question-answer";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";

/**
 * A Solus question as the questions of T3's pending input card. The card of
 * an attach request (`questionId` starts with `attach-folder-`,
 * docs/plans/codebases.md §6) is a normal question with two or three
 * options, so it needs no card of its own.
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

/** The answer that the host gets for each question: the labels of the chosen options, or the text that the person typed. */
export function pendingInputAnswers(
  questions: readonly { readonly id: string }[],
  drafts: Readonly<Record<string, PendingUserInputDraftAnswer>>,
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      formatAnswer(
        drafts[question.id]?.selectedOptionValues?.join(", ") ?? "",
        drafts[question.id]?.customAnswer,
      ),
    ]),
  );
}
