import { useMemo, useState } from "react";
import { SectionList, View } from "react-native";

import type { AttachedIntegrationResource, IntegrationResourceTemplate } from "@solus/contracts/integration-types";
import { missingArguments, templateArgumentFields, type ArgumentValue } from "@solus/client-core/integration-prompts";
import { AppText as Text } from "../../components/AppText";
import { PickRow, PickSheet } from "../../components/PickSheet";
import { resourceAddress, resourceSections } from "../conversation/lib/resource-attachments";
import { useIntegrationResources } from "./use-integration-resources";
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
    <PickSheet
      title={chosen ? chosen.uriTemplate : "MCP Resource"}
      titleIsCode={!!chosen}
      back={chosen ? { label: "Resources", onPress: () => setChosen(null) } : undefined}
      confirm={chosen ? { label: "Attach", accessibilityLabel: "Attach resource", onPress: attach } : undefined}
      search={chosen ? undefined : { label: "Search resources", query, autoFocus: true, onChange: setQuery }}
      onClose={props.onClose}
    >
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
            <PickRow onPress={() => ("uri" in choice ? props.onPick(choice) : choose(choice))}>
              <Text numberOfLines={1} className="text-sm font-t3-medium text-primary-text">{choice.title ?? choice.name}</Text>
              <Text numberOfLines={1} className="text-xs text-foreground-tertiary">{resourceAddress(choice)}</Text>
            </PickRow>
          )}
        />
      )}
    </PickSheet>
  );
}
