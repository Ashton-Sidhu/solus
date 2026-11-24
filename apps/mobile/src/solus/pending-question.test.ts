import { buildPendingUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import { expect, it } from "vite-plus/test";
import {
  isQuestionOptionSelected,
  pendingInputAnswers,
  pendingInputQuestions,
  toggleQuestionOption,
  typeQuestionRemark,
} from "./pending-question";

// The card of the host for an attach that makes a codebase (`session-folder-attach.ts`).
const MAKE = "Allow and make the codebase";
const SESSION_ONLY = "Allow for this session only";
const attachCard = {
  questionId: "attach-folder-5b0c2a7e",
  questions: [
    {
      id: "attach-folder",
      header: "Attach folder",
      question:
        'The agent wants to work in the folder "/code/solus-cloud". This makes a codebase. Allow it?',
      multiSelect: false,
      options: [
        {
          label: MAKE,
          description:
            'The codebase gets the name "solus". To change the name, type a different one in the answer field.',
        },
        { label: SESSION_ONLY, description: "No codebase is made." },
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
    MAKE,
    SESSION_ONLY,
    "Do not allow",
  ]);
});

it("answers the attach question with the label of the chosen option", () => {
  // WHY: the host attaches only when the answer starts with the exact label of an allow option.
  const questions = pendingInputQuestions(attachCard);
  const question = questions[0]!;
  const drafts = { [question.id]: toggleQuestionOption(question, undefined, MAKE) };
  // The card lets the person send: each question has an answer.
  expect(buildPendingUserInputAnswers(questions, drafts)).not.toBeNull();
  expect(pendingInputAnswers(questions, drafts)).toEqual({ "attach-folder": MAKE });
});

it("sends the choice and the typed words as one answer, so the person can name the codebase", () => {
  // WHY: the host reads the words after the label as the name of the codebase (`attachAnswerOf`).
  // T3's own draft rules keep only the typed words, and the host then reads no choice.
  const questions = pendingInputQuestions(attachCard);
  const question = questions[0]!;
  const chosen = toggleQuestionOption(question, undefined, MAKE);
  const named = typeQuestionRemark(chosen, " Solus platform ");
  expect(isQuestionOptionSelected(named, MAKE)).toBe(true);
  expect(buildPendingUserInputAnswers(questions, { [question.id]: named })).not.toBeNull();
  expect(pendingInputAnswers(questions, { [question.id]: named })).toEqual({
    "attach-folder": `${MAKE} — Solus platform`,
  });

  // The order of the two steps does not change the answer.
  const typedFirst = toggleQuestionOption(question, typeQuestionRemark(undefined, "Solus platform"), MAKE);
  expect(pendingInputAnswers(questions, { [question.id]: typedFirst })).toEqual({
    "attach-folder": `${MAKE} — Solus platform`,
  });

  // A different option takes the place of the first one, and the words stay.
  const changed = toggleQuestionOption(question, named, SESSION_ONLY);
  expect(isQuestionOptionSelected(changed, MAKE)).toBe(false);
  expect(pendingInputAnswers(questions, { [question.id]: changed })).toEqual({
    "attach-folder": `${SESSION_ONLY} — Solus platform`,
  });
});

it("takes a choice back with a second tap, and sends typed words alone as the answer", () => {
  const questions = pendingInputQuestions(attachCard);
  const question = questions[0]!;
  const typed = typeQuestionRemark(toggleQuestionOption(question, undefined, MAKE), "not now");
  const takenBack = toggleQuestionOption(question, typed, MAKE);
  expect(isQuestionOptionSelected(takenBack, MAKE)).toBe(false);
  expect(pendingInputAnswers(questions, { [question.id]: takenBack })).toEqual({
    "attach-folder": "not now",
  });
  // No choice and no words: the card does not let the person send.
  const empty = typeQuestionRemark(takenBack, "");
  expect(buildPendingUserInputAnswers(questions, { [question.id]: empty })).toBeNull();
});

it("keeps each chosen option of a question with more than one choice", () => {
  const question = { id: "areas", multiSelect: true };
  const two = toggleQuestionOption(question, toggleQuestionOption(question, undefined, "API"), "Web");
  expect(pendingInputAnswers([question], { areas: typeQuestionRemark(two, "and the docs") })).toEqual({
    areas: "API, Web — and the docs",
  });
  expect(toggleQuestionOption(question, two, "API").selectedOptionValues).toEqual(["Web"]);
});

it("sends uploaded screenshots as part of the question they answer", () => {
  const questions = [{ id: "screenshot" }, { id: "branch" }];
  expect(pendingInputAnswers(questions, { branch: { customAnswer: "main" } }, {
    screenshot: ["/host/uploads/screenshot.png"],
  })).toEqual({
    screenshot: "[Attached file: /host/uploads/screenshot.png]",
    branch: "main",
  });
});
