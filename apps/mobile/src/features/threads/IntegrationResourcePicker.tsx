import { useMemo, useState } from "react";
import { Modal, Pressable, SectionList, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AttachedIntegrationResource, IntegrationResourceTemplate } from "@solus/contracts/integration-types";
import { missingArguments, templateArgumentFields, type ArgumentValue } from "@solus/client-core/integration-prompts";
import { AppText as Text } from "../../components/AppText";
import { resourceAddress, resourceSections } from "../conversation/lib/resource-attachments";
import { useIntegrationResources } from "../conversation/use-integration-resources";
import { McpArgumentFields } from "./McpArgumentFields";

/** The composer's "MCP Resource…" sheet (docs/plans/mcp-first-class.md §11.3):
 *  the person's servers on this host, their resources, and their templates,
 *  searched by name or address. A template asks for its values in the sheet,
 *  as an MCP prompt does. The host reads the one picked into the
 *  conversation's attachments. Desktop and web pick from the `@` menu. */
export function IntegrationResourcePicker(props: {
  readonly hostId: string;
  readonly projectPath: string;
  readonly onPick: (resource: AttachedIntegrationResource) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<IntegrationResourceTemplate | null>(null);
  const [values, setValues] = useState<ArgumentValue[]>([]);
  const [hasTriedAttach, setHasTriedAttach] = useState(false);
  const list = useIntegrationResources(props.hostId, props.projectPath);
  const sections = useMemo(
    () => (list?.status === "loaded" ? resourceSections(list.value.integrations, list.value.resources, query, list.value.templates) : []),
    [query, list],
  );
  const fields = useMemo(() => (chosen ? templateArgumentFields(chosen.uriTemplate) ?? [] : []), [chosen]);
  const empty =
    list?.status !== "loaded" && list?.status !== "error"
      ? "Reading the servers' resources…"
      : list.status === "error"
        ? `Could not list resources: ${list.error}`
        : query
          ? "No matching resources."
          : "Your MCP servers list no resources.";

  const choose = (template: IntegrationResourceTemplate) => {
    setChosen(template);
    setValues((templateArgumentFields(template.uriTemplate) ?? []).map((field) => ({ name: field.name, value: "" })));
    setHasTriedAttach(false);
  };
  const attach = () => {
    if (!chosen) return;
    setHasTriedAttach(true);
    if (missingArguments(fields, values).length > 0) return;
    props.onPick({ ...chosen, arguments: values.map((entry) => ({ name: entry.name, value: entry.value.trim() })) });
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
        <View className="h-14 flex-row items-center gap-3 px-5">
          {chosen ? (
            <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={() => setChosen(null)}>
              <Text className="text-primary">Resources</Text>
            </Pressable>
          ) : null}
          <Text numberOfLines={1} className={`flex-1 font-t3-semibold text-base text-foreground ${chosen ? "text-center font-mono" : ""}`}>
            {chosen ? chosen.uriTemplate : "MCP Resource"}
          </Text>
          {chosen ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Attach resource" className="py-2 active:opacity-70" onPress={attach}>
              <Text className="font-t3-semibold text-primary">Attach</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={props.onClose}>
              <Text className="text-primary">Cancel</Text>
            </Pressable>
          )}
        </View>
        {chosen ? (
          <McpArgumentFields
            description={chosen.description ?? chosen.title}
            fields={fields}
            values={values}
            onChange={setValues}
            showsMissing={hasTriedAttach}
            submitKey="done"
            onSubmit={attach}
          />
        ) : (
          <>
            <TextInput
              accessibilityLabel="Search resources"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              clearButtonMode="while-editing"
              onChangeText={setQuery}
              placeholder="Search resources"
              placeholderTextColorClassName="accent-placeholder"
              returnKeyType="search"
              className="mx-5 mb-2 h-[40px] rounded-xl bg-subtle px-3 font-sans text-base text-foreground"
              value={query}
            />
            <SectionList
              sections={sections}
              keyExtractor={(choice) => `${choice.integrationId}:${resourceAddress(choice)}`}
              keyboardShouldPersistTaps="handled"
              stickySectionHeadersEnabled={false}
              ListEmptyComponent={<Text className="px-5 py-6 text-sm text-foreground-muted">{empty}</Text>}
              renderSectionHeader={({ section }) => (
                <View className="mb-1.5 mt-4 flex-row items-center gap-2.5 px-5">
                  <Text className="text-xs font-t3-medium text-foreground-tertiary">{section.title}</Text>
                  <View className="h-px flex-1 bg-border" />
                </View>
              )}
              renderItem={({ item: choice }) => (
                <Pressable
                  accessibilityRole="button"
                  className="gap-1 border-b border-border px-5 py-3 active:opacity-70"
                  onPress={() => ("uri" in choice ? props.onPick(choice) : choose(choice))}
                >
                  <Text numberOfLines={1} className="text-sm font-t3-medium text-primary-text">{choice.title ?? choice.name}</Text>
                  <Text numberOfLines={1} className="text-xs text-foreground-tertiary">{resourceAddress(choice)}</Text>
                </Pressable>
              )}
            />
          </>
        )}
      </View>
    </Modal>
  );
}
