import { WaitingForEditor } from "./RequestActionButton";
import {
  canSubmitSecrets,
  SECRET_PLACEHOLDER,
  secretAnswer,
  secretPrivacyNote,
  secretRequestLink,
  secretRequestPrompts,
  type SecretField,
} from "@solus/contracts/secret-request";
import { requestExpiryText } from "@solus/contracts/types";
import { Button } from "../../../src/components/ui/Button";
import { SecretTextInput } from "../../../src/components/ui/SecretTextInput";
import type { SecretTextInputHandle } from "../../../src/components/ui/SecretTextInput.types";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { PendingQuestion } from "../conversation/lib/transcript-model";

export interface PendingSecretCardProps {
  readonly request: PendingQuestion;
  readonly responding: boolean;
  /** False for a reader who may only view the session: an editor answers. */
  readonly mayDrive: boolean;
  /** One value per secret, null for each declined one. */
  readonly onSubmit: (values: (string | null)[]) => Promise<void>;
}

/**
 * The private card of `request_secret` (docs/plans/webhooks.md §3.6): one field
 * per secret; the user saves or declines each one. A `file` secret is saved where
 * the agent's commands can read it, and the card says so. The values live only in this
 * card's state. They never go to the composer's draft or the transcript, and
 * they go to the host once. Keyed by the request, so the next card starts empty.
 */
export function PendingSecretCard(props: PendingSecretCardProps) {
  const app = useApp();
  const prompts = secretRequestPrompts(props.request);
  const isGroup = prompts.length > 1;
  const [fields, setFields] = useState<SecretField[]>(() =>
    prompts.map(() => ({ value: "", isDeclined: false })),
  );
  const inputs = useRef<Array<SecretTextInputHandle | null>>([]);
  const [inputGeneration, resetInputs] = useState(0);
  const submitting = useRef(false);
  const canRespond = props.request.expired === undefined;
  const disabled = !canRespond || props.responding || !props.mayDrive;
  const isReady = canSubmitSecrets(fields);

  const changeField = (index: number, patch: Partial<SecretField>) => {
    setFields((current) => current.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  };
  const send = async (values: (string | null)[]) => {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setFields(current => current.map(field => ({ ...field, value: "" })));
    resetInputs(generation => generation + 1);
    try {
      await props.onSubmit(values);
    } finally {
      submitting.current = false;
    }
  };

  return (
    <View
      className="overflow-hidden gap-3 rounded-[20px] border border-border bg-card-alt p-4"
    >
      {isGroup && <Text className="font-t3-bold text-base text-foreground">{prompts.length} secrets requested</Text>}
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-4 pb-1"
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
          if (!field) return null;
          const next = fields.findIndex((candidate, i) => i > index && !candidate.isDeclined);
          const isFile = prompt.delivery === "file";
          const link = secretRequestLink(prompt);
          return (
            <View key={index} className="gap-2">
              <View className="gap-1">
                <Text className="font-t3-bold text-base text-foreground">{prompt.name}</Text>
                <Text selectable className="font-sans text-sm leading-5 text-foreground-muted">{prompt.reason}</Text>
              </View>
              {link ? (
                <View className="gap-1.5">
                  <Button
                    label={`Open ${link.host}`}
                    tone="secondary"
                    fullWidth
                    onPress={() => void app.platform.openBrowser(link.href)}
                  />
                  {prompt.url ? (
                    <Text selectable className="font-mono text-xs text-foreground-muted">{link.href}</Text>
                  ) : null}
                </View>
              ) : null}
              {!canRespond ? null : field.isDeclined ? (
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="flex-1 font-sans text-xs text-foreground-muted">
                    Declined. The agent does not get this secret.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Undo decline of ${prompt.name}`}
                    disabled={disabled}
                    hitSlop={8}
                    onPress={() => changeField(index, { isDeclined: false })}
                    className="min-h-8 justify-center rounded-full px-3 active:opacity-70"
                  >
                    <Text className="font-t3-bold text-xs text-foreground-secondary">Undo</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <SecretTextInput
                    key={inputGeneration}
                    onMount={handle => { inputs.current[index] = handle; }}
                    accessibilityLabel={`Value of ${prompt.name}`}
                    editable={!disabled}
                    placeholder={SECRET_PLACEHOLDER}
                    value={field.value}
                    onChangeText={value => changeField(index, { value })}
                    returnKeyType={next >= 0 ? "next" : "done"}
                    onSubmitEditing={value => {
                      if (next >= 0) {
                        inputs.current[next]?.focus();
                        return;
                      }
                      const latest = fields.map((entry, i) => i === index ? { ...entry, value } : entry);
                      if (canSubmitSecrets(latest)) void send(secretAnswer(latest));
                    }}
                  />
                  <View className="flex-row items-center gap-2">
                    <View className="min-w-0 flex-1 flex-row items-start gap-1.5">
                      <SymbolView name={isFile ? "terminal" : "lock"} size={12} tintColorClassName={"accent-icon-subtle"} type="monochrome" />
                      <Text className="flex-1 font-sans text-xs text-foreground-muted">{secretPrivacyNote(prompt)}</Text>
                    </View>
                    {isGroup ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Decline ${prompt.name}`}
                        disabled={disabled}
                        hitSlop={8}
                        onPress={() => {
                          changeField(index, { isDeclined: true, value: "" });
                        }}
                        className="min-h-8 justify-center rounded-full px-3 active:opacity-70"
                      >
                        <Text className="font-t3-bold text-xs text-foreground-secondary">Decline</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              )}
            </View>
          );
        })}
      </ScrollView>
      {canRespond && !props.mayDrive ? <WaitingForEditor /> : null}
      {canRespond && props.mayDrive ? (
        <View className="gap-2">
          <Button
            label="Save securely"
            tone="primary"
            fullWidth
            disabled={disabled || !isReady}
            onPress={() => void send(secretAnswer(fields))}
          />
          <View className="flex-row justify-end">
            <Button
              label={isGroup ? "Decline all" : "Decline"}
              tone="text"
              disabled={disabled}
              onPress={() => void send(fields.map(() => null))}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
