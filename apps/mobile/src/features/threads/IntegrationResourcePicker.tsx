import { useMemo, useState } from "react";
import { Modal, Pressable, SectionList, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { IntegrationResource } from "@solus/contracts/integration-types";
import { AppText as Text } from "../../components/AppText";
import { resourceSections } from "../conversation/lib/resource-attachments";
import { useIntegrationResources } from "../conversation/use-integration-resources";

/** The composer's "MCP Resource…" sheet (docs/plans/mcp-first-class.md §11.3):
 *  the person's servers on this host and their resources, searched by name or
 *  URI. The host reads the one picked into the conversation's attachments.
 *  Desktop and web pick from the `@` menu. */
export function IntegrationResourcePicker(props: {
  readonly hostId: string;
  readonly projectPath: string;
  readonly onPick: (resource: IntegrationResource) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const state = useIntegrationResources(props.hostId, props.projectPath);
  const sections = useMemo(
    () => (state.kind === "loaded" ? resourceSections(state.integrations, state.resources, query) : []),
    [query, state],
  );
  const empty =
    state.kind === "loading"
      ? "Reading the servers' resources…"
      : state.kind === "error"
        ? `Could not list resources: ${state.message}`
        : query
          ? "No matching resources."
          : "Your MCP servers list no resources.";
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
        <View className="h-14 flex-row items-center gap-3 px-5">
          <Text className="flex-1 font-t3-semibold text-base text-foreground">MCP Resource</Text>
          <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={props.onClose}>
            <Text className="text-primary">Cancel</Text>
          </Pressable>
        </View>
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
          keyExtractor={(resource) => `${resource.integrationId}:${resource.uri}`}
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={<Text className="px-5 py-6 text-sm text-foreground-muted">{empty}</Text>}
          renderSectionHeader={({ section }) => (
            <View className="mb-1.5 mt-4 flex-row items-center gap-2.5 px-5">
              <Text className="text-xs font-t3-medium text-foreground-tertiary">{section.title}</Text>
              <View className="h-px flex-1 bg-border" />
            </View>
          )}
          renderItem={({ item: resource }) => (
            <Pressable accessibilityRole="button" className="gap-1 border-b border-border px-5 py-3 active:opacity-70" onPress={() => props.onPick(resource)}>
              <Text numberOfLines={1} className="text-sm font-t3-medium text-primary-text">{resource.title ?? resource.name}</Text>
              <Text numberOfLines={1} className="text-xs text-foreground-tertiary">{resource.uri}</Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}
