import { RequestActionButton, WaitingForEditor } from "./RequestActionButton";
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
import { webLinkIcon } from "@solus/client-core/web-link-icon";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

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
  const [revealed, setRevealed] = useState<boolean[]>(() => prompts.map(() => false));
  const canRespond = props.request.expired === undefined;
  const disabled = !canRespond || props.responding || !props.mayDrive;
  const isReady = canSubmitSecrets(fields);

  const changeField = (index: number, patch: Partial<SecretField>) => {
    setFields((current) => current.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  };
  const setFieldRevealed = (index: number, isRevealed: boolean) => {
    setRevealed((current) => current.map((value, at) => (at === index ? isRevealed : value)));
  };
  const send = (values: (string | null)[]) => {
    // No value is kept after a send.
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
    setRevealed((current) => current.map(() => false));
    void props.onSubmit(values);
  };

  return (
    <View
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
    >
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {isGroup ? `${prompts.length} secrets requested` : "Secret requested"}
      </Text>
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
          const isRevealed = revealed[index];
          const isFile = prompt.delivery === "file";
          const link = secretRequestLink(prompt);
          const linkIcon = link ? webLinkIcon(link.href) : null;
          return (
            <View key={index} className="gap-2">
              <View className="gap-0.5">
                <Text className="font-t3-bold text-lg text-foreground">{prompt.name}</Text>
                <Text selectable className="font-sans text-sm leading-5 text-foreground-secondary">{prompt.reason}</Text>
                {link ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${link.href}`}
                    hitSlop={8}
                    onPress={() => void app.platform.openBrowser(link.href)}
                    className="mt-1 min-h-8 flex-row items-center gap-1.5 self-start active:opacity-60"
                  >
                    {linkIcon?.kind === "favicon" ? (
                      <Image source={{ uri: linkIcon.url }} style={{ width: 16, height: 16, borderRadius: 3 }} contentFit="contain" />
                    ) : (
                      <SymbolView name="globe" size={16} tintColorClassName={"accent-icon-subtle"} type="monochrome" />
                    )}
                    <Text numberOfLines={1} className="shrink font-t3-bold text-sm text-foreground underline">{link.host}</Text>
                    <SymbolView name="arrow.up.right" size={14} tintColorClassName={"accent-icon-subtle"} type="monochrome" />
                  </Pressable>
                ) : null}
              </View>
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
                  <View className="justify-center">
                    <TextInput
                      accessibilityLabel={`Value of ${prompt.name}`}
                      editable={!disabled}
                      secureTextEntry={!isRevealed}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      textContentType="none"
                      placeholder={SECRET_PLACEHOLDER}
                      value={field.value}
                      onChangeText={(value) => changeField(index, { value })}
                      className="min-h-12 rounded-2xl border border-border bg-input py-3 pl-3.5 pr-12 font-mono text-sm text-foreground"
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={isRevealed ? `Hide value of ${prompt.name}` : `Show value of ${prompt.name}`}
                      accessibilityState={{ selected: isRevealed, disabled }}
                      disabled={disabled}
                      hitSlop={8}
                      onPress={() => setFieldRevealed(index, !isRevealed)}
                      className="absolute right-1 h-10 w-10 items-center justify-center active:opacity-60"
                    >
                      <SymbolView
                        name={isRevealed ? "eye.slash" : "eye"}
                        size={18}
                        tintColorClassName="accent-icon-muted"
                        type="monochrome"
                        weight="regular"
                      />
                    </Pressable>
                  </View>
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
                          setFieldRevealed(index, false);
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
        <View className="flex-row gap-2.5">
          <RequestActionButton
            label={isGroup ? "Decline all" : "Decline"}
            tone="secondary"
            disabled={disabled}
            onPress={() => send(fields.map(() => null))}
          />
          <RequestActionButton
            label="Save securely"
            tone={isReady ? "primary" : "secondary"}
            disabled={disabled || !isReady}
            onPress={() => send(secretAnswer(fields))}
          />
        </View>
      ) : null}
    </View>
  );
}
