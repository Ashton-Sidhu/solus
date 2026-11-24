import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import { expect, it } from "vite-plus/test";
import { pendingInputAnswers, pendingInputQuestions } from "./pending-question";

// The card of the host for a folder that is not a member (`session-folder-attach.ts`).
const attachCard = {
  questionId: "attach-folder-5b0c2a7e",
  questions: [
    {
      id: "attach-folder",
      header: "Attach folder",
      question: 'The agent wants to work in the folder "/code/notes". Allow it?',
      multiSelect: false,
      options: [
        {
          label: "Allow for this session",
          description: "The agent can read and change this folder in this session.",
        },
        {
          label: "Allow and add to the codebase",
          description: 'Also add the folder to the codebase "Shop".',
        },
        { label: "Do not allow", description: "The agent does not get this folder." },
      ],
    },
  ],
};

it("shows the attach question with each of its options in T3's question card", () => {
  const [question] = pendingInputQuestions(attachCard);
  expect(question).toMatchObject({
    id: "attach-folder",
    header: "Attach folder",
    multiSelect: false,
  });
  expect(question?.options.map((option) => option.label)).toEqual([
    "Allow for this session",
    "Allow and add to the codebase",
    "Do not allow",
  ]);
});

it("answers the attach question with the label of the chosen option", () => {
  // WHY: the host attaches only when the answer is the exact label of an allow option.
  const questions = pendingInputQuestions(attachCard);
  const question = questions[0]!;
  const chosen = togglePendingUserInputOptionSelection(
    question,
    undefined,
    "Allow and add to the codebase",
  );
  const drafts = { [question.id]: chosen };
  // The card lets the person send: each question has an answer.
  expect(buildPendingUserInputAnswers(questions, drafts)).not.toBeNull();
  expect(pendingInputAnswers(questions, drafts)).toEqual({
    "attach-folder": "Allow and add to the codebase",
  });
  // A typed answer replaces the choice, so the host never gets a label with a remark after it.
  const typed = setPendingUserInputCustomAnswer(question, chosen, "not now");
  expect(pendingInputAnswers(questions, { [question.id]: typed })).toEqual({
    "attach-folder": "not now",
  });
});
