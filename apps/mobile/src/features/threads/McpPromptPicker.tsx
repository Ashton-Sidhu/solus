import { useMemo, useState } from "react";
import { Modal, Pressable, SectionList, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { IntegrationPrompt, IntegrationPromptSignIn, IntegrationPromptText } from "@solus/contracts/integrations/prompts";
import { argumentHint, missingArguments, type ArgumentValue } from "@solus/client-core/integration-prompts";

import { AppText as Text } from "../../components/AppText";
import { mcpPromptSections } from "./lib/mcp-prompt-sheet";
import { McpArgumentFields } from "./McpArgumentFields";
import { useIntegrationPrompts } from "./use-integration-prompts";

/**
 * The composer's "MCP Prompt…" sheet (docs/plans/mcp-first-class.md §10): the
 * phone has no slash menu, so the + menu opens this. It lists and searches the
 * host's MCP prompts, then takes the arguments of the one chosen. The host
 * expands it, and `onExpanded` sends the text as the person's own message.
 */
export function McpPromptPicker(props: {
  readonly hostId: string;
  readonly projectPath: string;
  readonly sessionId: string;
  /** The expanded prompt: the caller attaches its files and sends its text. */
  readonly onExpanded: (answer: Extract<IntegrationPromptText, { kind: "text" }>) => Promise<void>;
  /** A server that waits on the person's connection: the conversation's connect sheet. */
  readonly onSignIn: (server: Pick<IntegrationPromptSignIn, "integrationId" | "integrationName">) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<IntegrationPrompt | null>(null);
  const [values, setValues] = useState<ArgumentValue[]>([]);
  const [hasTriedSend, setHasTriedSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const { state, reload, expand } = useIntegrationPrompts(props.hostId, props.projectPath);
  const sections = useMemo(() => (state.kind === "loaded" ? mcpPromptSections(state.value, query) : []), [query, state]);

  const send = async (prompt: IntegrationPrompt, entered: ArgumentValue[]) => {
    setHasTriedSend(true);
    if (sending || missingArguments(prompt.arguments, entered).length > 0) return;
    setSending(true);
    setError("");
    try {
      const answer = await expand(prompt, entered, props.sessionId);
      if (answer.kind === "connection-required") props.onSignIn(answer);
      else await props.onExpanded(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSending(false);
    }
  };

  const choose = (prompt: IntegrationPrompt) => {
    if (prompt.arguments.length === 0) {
      void send(prompt, []);
      return;
    }
    setChosen(prompt);
    setValues(prompt.arguments.map((argument) => ({ name: argument.name, value: "" })));
    setHasTriedSend(false);
    setError("");
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
        <View className="h-14 flex-row items-center gap-3 px-5">
          {chosen ? (
            <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={() => setChosen(null)} disabled={sending}>
              <Text className="text-primary">Prompts</Text>
            </Pressable>
          ) : null}
          <Text numberOfLines={1} className={`flex-1 font-t3-semibold text-base text-foreground ${chosen ? "text-center font-mono" : ""}`}>
            {chosen ? chosen.command : "MCP Prompts"}
          </Text>
          {chosen ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Send prompt" className="py-2 active:opacity-70" disabled={sending} onPress={() => void send(chosen, values)}>
              <Text className={`font-t3-semibold ${sending ? "text-foreground-muted" : "text-primary"}`}>{sending ? "Sending…" : "Send"}</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={props.onClose}>
              <Text className="text-primary">Cancel</Text>
            </Pressable>
          )}
        </View>
        {error ? <Text accessibilityRole="alert" className="px-5 pb-2 text-sm text-danger">{error}</Text> : null}
        {chosen ? (
          <McpArgumentFields
            description={chosen.description}
            fields={chosen.arguments}
            values={values}
            onChange={setValues}
            showsMissing={hasTriedSend}
            editable={!sending}
            submitKey="send"
            onSubmit={() => void send(chosen, values)}
          />
        ) : (
          <>
            <TextInput
              accessibilityLabel="Search prompts"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={setQuery}
              placeholder="Search prompts"
              placeholderTextColorClassName="accent-placeholder"
              returnKeyType="search"
              className="mx-5 mb-2 h-[40px] rounded-xl bg-subtle px-3 font-sans text-base text-foreground"
              value={query}
            />
            <SectionList
              sections={sections}
              keyExtractor={(row) => row.key}
              keyboardShouldPersistTaps="handled"
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section }) => (
                <Text className="px-5 pt-4 pb-1 text-xs font-t3-medium uppercase text-foreground-tertiary">{section.title}</Text>
              )}
              ListEmptyComponent={
                state.kind === "loading" ? (
                  <Text className="px-5 py-6 text-sm text-foreground-muted">Loading prompts…</Text>
                ) : state.kind === "error" ? (
                  <Pressable accessibilityRole="button" className="px-5 py-6 active:opacity-70" onPress={reload}>
                    <Text className="text-sm text-foreground-muted">Could not load the prompts. <Text className="text-primary">Try again</Text></Text>
                  </Pressable>
                ) : (
                  <Text className="px-5 py-6 text-sm text-foreground-muted">
                    {query ? "No matching prompts." : "The MCP servers of this host have no prompts."}
                  </Text>
                )
              }
              renderItem={({ item: row }) =>
                row.kind === "prompt" ? (
                  <Pressable accessibilityRole="button" disabled={sending} className="gap-1 border-b border-border px-5 py-3 active:opacity-70" onPress={() => choose(row.prompt)}>
                    <Text numberOfLines={1} className="font-mono text-sm text-primary-text">
                      {row.prompt.command}
                      {row.prompt.arguments.length ? <Text className="text-foreground-tertiary"> {argumentHint(row.prompt)}</Text> : null}
                    </Text>
                    {row.prompt.description ? <Text numberOfLines={2} className="text-xs text-foreground-tertiary">{row.prompt.description}</Text> : null}
                  </Pressable>
                ) : (
                  <Pressable accessibilityRole="button" className="gap-1 border-b border-border px-5 py-3 active:opacity-70" onPress={() => props.onSignIn(row.server)}>
                    <Text numberOfLines={1} className="text-sm font-t3-medium text-primary">
                      {row.server.needs === "environment" ? `Give the values of ${row.server.integrationName}` : `Sign in to ${row.server.integrationName}`}
                    </Text>
                    <Text numberOfLines={1} className="text-xs text-foreground-tertiary">Its prompts show here after you connect.</Text>
                  </Pressable>
                )
              }
            />
          </>
        )}
      </View>
    </Modal>
  );
}
