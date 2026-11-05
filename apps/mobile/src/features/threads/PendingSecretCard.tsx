import { RequestActionButton, WaitingForEditor } from "./RequestActionButton";
import {
  canSubmitSecrets,
  secretAnswer,
  secretRequestPrompts,
  type SecretField,
} from "@solus/contracts/secret-request";
import { requestExpiryText } from "@solus/contracts/types";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { PendingQuestion } from "../conversation/lib/transcript-model";

export interface PendingSecretCardProps {
  readonly request: PendingQuestion;
  /** Constant while a request is pending (it reserves keyboard space). */
  readonly maxHeight: number;
  readonly responding: boolean;
  /** False for a reader who may only view the session: an editor answers. */
  readonly mayDrive: boolean;
  /** One value per secret, null for each declined one. */
  readonly onSubmit: (values: (string | null)[]) => Promise<void>;
}

/**
 * The private card of `request_secret` (docs/plans/webhooks.md §3.6): one field
 * per secret; the user saves or declines each one. The values live only in this
 * card's state. They never go to the composer's draft or the transcript, and
 * they go to the host once. Keyed by the request, so the next card starts empty.
 */
export function PendingSecretCard(props: PendingSecretCardProps) {
  const prompts = secretRequestPrompts(props.request);
  const isGroup = prompts.length > 1;
  const [fields, setFields] = useState<SecretField[]>(() =>
    prompts.map(() => ({ value: "", isDeclined: false })),
  );
  const canRespond = props.request.expired === undefined;
  const disabled = !canRespond || props.responding || !props.mayDrive;
  const isReady = canSubmitSecrets(fields);

  const changeField = (index: number, patch: Partial<SecretField>) => {
    setFields((current) => current.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  };
  const send = (values: (string | null)[]) => {
    // No value is kept after a send.
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
    void props.onSubmit(values);
  };

  return (
    <View
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={{ maxHeight: props.maxHeight }}
    >
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {isGroup ? `${prompts.length} secrets requested` : "Secret requested"}
      </Text>
      {isGroup ? null : <Text className="font-t3-bold text-lg text-foreground">{prompts[0].name}</Text>}
      <View className="flex-row items-center gap-1.5">
        <SymbolView name="lock" size={12} tintColorClassName={"accent-icon-subtle"} type="monochrome" />
        <Text className="flex-1 font-sans text-xs text-foreground-muted">
          {isGroup
            ? "The values go only to the host. The agent and the transcript never see them."
            : "The value goes only to the host. The agent and the transcript never see it."}
        </Text>
      </View>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-3 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{ flexShrink: 1 }}
      >
        {props.request.expired ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {requestExpiryText(props.request.expired)}
          </Text>
        ) : null}
        {prompts.map((prompt, index) => {
          const field = fields[index];
          return (
            <View key={index} className="gap-2">
              <View className="flex-row items-start gap-2">
                <View className="min-w-0 flex-1 gap-0.5">
                  {isGroup ? <Text className="font-t3-bold text-sm text-foreground">{prompt.name}</Text> : null}
                  <Text selectable className="font-sans text-sm leading-5 text-foreground-secondary">{prompt.reason}</Text>
                </View>
                {isGroup && canRespond ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: field.isDeclined, disabled }}
                    accessibilityLabel={`${field.isDeclined ? "Undo decline of" : "Decline"} ${prompt.name}`}
                    disabled={disabled}
                    hitSlop={8}
                    onPress={() => changeField(index, { isDeclined: !field.isDeclined, value: "" })}
                    className="min-h-8 justify-center rounded-full px-3 active:opacity-70"
                  >
                    <Text className="font-t3-bold text-xs text-foreground-secondary">
                      {field.isDeclined ? "Undo" : "Decline"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {!canRespond ? null : field.isDeclined ? (
                <Text className="font-sans text-xs text-foreground-muted">
                  Declined. The agent does not get this secret.
                </Text>
              ) : (
                <TextInput
                  accessibilityLabel={`Value of ${prompt.name}`}
                  editable={!disabled}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  value={field.value}
                  onChangeText={(value) => changeField(index, { value })}
                  className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 font-mono text-sm text-foreground"
                />
              )}
            </View>
          );
        })}
      </ScrollView>
      {canRespond && !props.mayDrive ? <WaitingForEditor /> : null}
      {canRespond && props.mayDrive ? (
        <View className="flex-row gap-2.5">
          <RequestActionButton
            label={isGroup ? "Decline all" : "Decline"}
            tone="secondary"
            disabled={disabled}
            onPress={() => send(fields.map(() => null))}
          />
          <RequestActionButton
            label="Submit"
            tone={isReady ? "primary" : "secondary"}
            disabled={disabled || !isReady}
            onPress={() => send(secretAnswer(fields))}
          />
        </View>
      ) : null}
    </View>
  );
}
