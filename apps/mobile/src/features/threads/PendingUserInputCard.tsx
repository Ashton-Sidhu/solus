// Adapted from T3 Code apps/mobile/src/features/threads/PendingUserInputCard.tsx (MIT, see UPSTREAM.md).
import { RequestActionButton } from "./RequestActionButton";
import { formatAnswer, questionKey } from "@solus/contracts/question-answer";
import { requestExpiryText, type QuestionItem } from "@solus/contracts/types";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import Animated, { Easing, FadeInUp, FadeOutDown, LinearTransition } from "react-native-reanimated";

import { USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import type { PendingQuestion } from "../conversation/lib/transcript-model";

/** One question's answer as it is being filled in: chosen labels and a free remark. */
interface PendingUserInputDraftAnswer {
  readonly selected: readonly string[];
  readonly customAnswer: string;
}

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingQuestion;
  /** Constant while a request is pending (it reserves keyboard space). */
  readonly maxHeight: number;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** Renders a stop control on the collapsed bar, which replaces the composer. */
  readonly onStopThread?: () => void;
  readonly responding: boolean;
  readonly onSubmit: (answers: Record<string, string>) => Promise<unknown>;
}

const CARD_LAYOUT_TRANSITION = LinearTransition.duration(200);

/** The host's answer record, or null while a question has no answer yet. */
function resolveAnswers(
  questions: readonly QuestionItem[],
  drafts: Readonly<Partial<Record<string, PendingUserInputDraftAnswer>>>,
): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const key = questionKey(question);
    const draft = drafts[key];
    const answer = formatAnswer(draft?.selected.join(", ") ?? "", draft?.customAnswer);
    if (!answer) return null;
    answers[key] = answer;
  }
  return answers;
}

/**
 * The questionnaire takes the composer's place while the agent waits on an
 * answer. T3 floats the expanded card over the feed on iOS; here it renders
 * in flow on every platform, as T3 does on Android.
 */
export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const questions = props.pendingUserInput.questions;
  const questionCount = questions.length;
  const canRespond = props.pendingUserInput.expired === undefined;
  const responseDisabled = !canRespond || props.responding;
  const [drafts, setDrafts] = useState<Partial<Record<string, PendingUserInputDraftAnswer>>>({});
  const answers = resolveAnswers(questions, drafts);

  const selectOption = (question: QuestionItem, label: string) => {
    const key = questionKey(question);
    setDrafts((current) => {
      const draft = current[key] ?? { selected: [], customAnswer: "" };
      const isSelected = draft.selected.includes(label);
      const selected = question.multiSelect
        ? isSelected
          ? draft.selected.filter((value) => value !== label)
          : [...draft.selected, label]
        : isSelected
          ? []
          : [label];
      return { ...current, [key]: { ...draft, selected } };
    });
  };
  const changeCustomAnswer = (question: QuestionItem, customAnswer: string) => {
    const key = questionKey(question);
    setDrafts((current) => ({
      ...current,
      [key]: { selected: current[key]?.selected ?? [], customAnswer },
    }));
  };

  if (props.collapsed) {
    return (
      <View className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Expand user input, ${questionCount} question${
            questionCount === 1 ? "" : "s"
          }`}
          onPress={props.onToggleCollapsed}
          className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
        >
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            User input needed
          </Text>
          <Text className="font-sans text-xs text-foreground-muted">
            {questionCount} question{questionCount === 1 ? "" : "s"}
          </Text>
          <View className="flex-1" />
          <SymbolView
            name="chevron.up"
            size={12}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </Pressable>
        {props.onStopThread ? (
          <ControlPill
            accessibilityLabel="Stop"
            icon="stop.fill"
            variant="danger"
            className="h-9 w-9"
            onPress={props.onStopThread}
          />
        ) : null}
      </View>
    );
  }

  // The surface is opaque on purpose: the card sits over the thread feed with
  // no blur behind it.
  return (
    <Animated.View
      entering={FadeInUp.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))}
      exiting={FadeOutDown.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))}
      layout={CARD_LAYOUT_TRANSITION}
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={{ maxHeight: props.maxHeight }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse user input"
        onPress={props.onToggleCollapsed}
        className="flex-row items-start gap-2"
      >
        <View className="flex-1 gap-2.5">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            User input needed
          </Text>
          <Text className="font-t3-bold text-lg text-foreground">Fill in the pending answers</Text>
        </View>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-subtle-strong">
          <SymbolView
            name="chevron.down"
            size={13}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </View>
      </Pressable>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        {props.pendingUserInput.expired ? (
          <Text className="font-sans text-sm leading-5 text-adaptive-neutral-600-400">
            {requestExpiryText(props.pendingUserInput.expired)}
          </Text>
        ) : null}
        {questions.map((question) => {
          const key = questionKey(question);
          const draft = drafts[key];
          return (
            <View key={key} className="gap-2 pt-1">
              {question.header ? (
                <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted">
                  {question.header}
                </Text>
              ) : null}
              <Text className="font-sans text-base leading-snug text-foreground">
                {question.question}
              </Text>
              <View className="gap-2">
                {question.options.map((option) => {
                  const selected = draft?.selected.includes(option.label) ?? false;
                  const description =
                    option.description !== option.label ? option.description : undefined;
                  return (
                    <Pressable
                      key={option.label}
                      accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                      accessibilityState={{ checked: selected, disabled: responseDisabled }}
                      disabled={responseDisabled}
                      className={cn(
                        "min-h-12 w-full rounded-2xl border px-3.5 py-3",
                        selected ? "border-primary bg-primary/10" : "border-border bg-input",
                      )}
                      onPress={() => selectOption(question, option.label)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text
                          className={cn(
                            "font-t3-bold text-sm",
                            selected ? "text-foreground" : "text-foreground-secondary",
                          )}
                        >
                          {option.label}
                        </Text>
                        {description ? (
                          <Text className="font-sans text-sm leading-5 text-foreground-muted">
                            {description}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                accessibilityLabel={`Your own answer to: ${question.question}`}
                editable={!responseDisabled}
                multiline
                value={draft?.customAnswer ?? ""}
                onChangeText={(value) => changeCustomAnswer(question, value)}
                placeholder="Add your own answer"
                placeholderTextColorClassName="accent-placeholder"
                selectionColorClassName="accent-focus/32"
                cursorColorClassName="accent-focus"
                className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 font-sans text-sm text-foreground"
              />
            </View>
          );
        })}
      </ScrollView>
      <RequestActionButton
        label="Submit answers"
        size="large"
        tone={answers ? "primary" : "secondary"}
        disabled={responseDisabled || answers === null}
        onPress={() => {
          if (answers) void props.onSubmit(answers);
        }}
      />
    </Animated.View>
  );
}
