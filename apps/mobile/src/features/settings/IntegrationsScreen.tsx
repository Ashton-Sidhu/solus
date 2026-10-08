import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { CatalogEntry, Integration, IntegrationToolSummary } from "@solus/contracts/integration-types";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { AddProjectTextInput, PrimaryActionButton } from "../projects/components/add-project-ui";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  authKindLabel,
  catalogCandidate,
  customCandidate,
  errorMessage,
  firstLine,
  isIntegrationUrl,
  looksLikeUrl,
  probeOutcomeView,
  UNSUPPORTED_NOTE,
  urlHost,
  type CatalogState,
  type IntegrationCandidate,
  type IntegrationToolsState,
} from "./integrations";
import { useIntegrations } from "./use-integrations";

/**
 * The remote MCP servers one host knows (docs/plans/mcp-integrations.md §7):
 * the list, the tools of each, and the way to add one from the catalog or a
 * custom address. The probe result shows before Add. The same capability as
 * Settings → Integrations on desktop and web.
 */
export function IntegrationsScreen({ route }: ScreenProps<"Integrations">) {
  const { hostId } = route.params;
  const insets = useSafeAreaInsets();
  const integrations = useIntegrations(hostId);
  const { list, connected } = integrations;

  const confirmRemove = (integration: Integration) => {
    Alert.alert(`Remove ${integration.name}?`, "Agents on this host can no longer use its tools.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          integrations.remove(integration.id).catch((cause: unknown) => Alert.alert("Not removed", errorMessage(cause)));
        },
      },
    ]);
  };

  const promptRename = (integration: Integration) => {
    const commit = (value: string) => {
      const name = value.trim();
      if (name.length === 0 || name === integration.name) return;
      integrations.rename(integration.id, name).catch((cause: unknown) => Alert.alert("Not renamed", errorMessage(cause)));
    };
    if (Platform.OS === "ios") {
      Alert.prompt("Rename integration", undefined, (value) => commit(value ?? ""), "plain-text", integration.name);
      return;
    }
    showTextInputDialog({ title: "Rename integration", initialValue: integration.name, confirmText: "Rename", onConfirm: commit });
  };

  return (
    <SettingsScreen title="Integrations">
      <HostStatusBanner hostId={hostId} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {list.kind === "unsupported" ? (
          <SettingsNote>{UNSUPPORTED_NOTE}</SettingsNote>
        ) : list.kind === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`Integrations could not be read: ${list.message}`} />
            <Pressable
              accessibilityRole="button"
              onPress={integrations.reload}
              className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : list.kind === "loading" ? (
          connected ? (
            <View className="items-center py-2">
              <ActivityIndicator accessibilityLabel="Reading integrations" colorClassName="accent-icon-muted" />
            </View>
          ) : (
            <SettingsNote>Connect this host to manage its integrations.</SettingsNote>
          )
        ) : (
          <>
            <View className="gap-3">
              {list.integrations.length > 0 ? (
                <SettingsSection title="On this host">
                  {list.integrations.map((integration, index) => (
                    <IntegrationRow
                      key={integration.id}
                      integration={integration}
                      first={index === 0}
                      tools={integrations.tools.get(integration.id)}
                      busy={integrations.busy}
                      onToggle={() =>
                        integrations.tools.has(integration.id)
                          ? integrations.closeTools(integration.id)
                          : integrations.loadTools(integration.id)
                      }
                      onRename={() => promptRename(integration)}
                      onRemove={() => confirmRemove(integration)}
                    />
                  ))}
                </SettingsSection>
              ) : null}
              <SettingsNote>
                {list.integrations.length > 0
                  ? "Agents on this host can use the tools of these servers."
                  : "No integrations yet. Add a remote MCP server to give agents on this host its tools."}
              </SettingsNote>
            </View>
            <AddIntegrationSection integrations={integrations} />
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function IntegrationRow(props: {
  readonly integration: Integration;
  readonly first: boolean;
  readonly tools: IntegrationToolsState | undefined;
  readonly busy: string | null;
  readonly onToggle: () => void;
  readonly onRename: () => void;
  readonly onRemove: () => void;
}) {
  const { integration, tools } = props;
  const expanded = tools !== undefined;
  const detail = `${integration.slug} · ${urlHost(integration.url)} · ${authKindLabel(integration.auth)}`;
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${integration.name}, ${detail}`}
        accessibilityState={{ expanded }}
        onPress={props.onToggle}
        className="flex-row items-center gap-4 p-4 active:opacity-70"
      >
        <SymbolView name="point.3.connected.trianglepath.dotted" size={22} tintColorClassName="accent-icon" type="monochrome" weight="regular" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg text-foreground" numberOfLines={1}>{integration.name}</Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{detail}</Text>
        </View>
        <SymbolView name={expanded ? "chevron.up" : "chevron.down"} size={16} tintColorClassName="accent-chevron" type="monochrome" weight="semibold" />
      </Pressable>
      {tools ? (
        <View>
          <IntegrationTools tools={tools} />
          <SettingsActionRow icon="pencil" label="Rename" loading={props.busy === `rename:${integration.id}`} disabled={props.busy !== null} onPress={props.onRename} />
          <SettingsActionRow icon="trash" label="Remove" tone="danger" loading={props.busy === `remove:${integration.id}`} disabled={props.busy !== null} onPress={props.onRemove} />
        </View>
      ) : null}
    </View>
  );
}

function IntegrationTools(props: { readonly tools: IntegrationToolsState }) {
  const { tools } = props;
  if (tools.kind === "loading") {
    return (
      <View className="items-center py-2">
        <ActivityIndicator accessibilityLabel="Reading tools" colorClassName="accent-icon-muted" />
      </View>
    );
  }
  if (tools.kind === "error") return <View className="px-4 pb-2"><SettingsNote tone="danger">{`Tools could not be read: ${tools.message}`}</SettingsNote></View>;
  if (tools.tools.length === 0) return <View className="px-4 pb-2"><SettingsNote>This server lists no tools.</SettingsNote></View>;
  return (
    <View className="gap-3 px-4 pb-3 pl-[58px]">
      {tools.tools.map((tool) => <ToolLine key={tool.name} tool={tool} />)}
    </View>
  );
}

function ToolLine(props: { readonly tool: IntegrationToolSummary }) {
  const { tool } = props;
  const description = firstLine(tool.description);
  return (
    <View className="gap-0.5">
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Text className="font-mono text-sm text-foreground" selectable>{tool.name}</Text>
        {tool.destructive ? <Badge label="destructive" tone="danger" /> : null}
        {tool.readOnly ? <Badge label="read-only" tone="muted" /> : null}
      </View>
      {description ? <Text className="text-sm text-foreground-muted" numberOfLines={2}>{description}</Text> : null}
    </View>
  );
}

function Badge(props: { readonly label: string; readonly tone: "danger" | "muted" }) {
  return (
    <View className={cn("rounded-full px-2 py-0.5", props.tone === "danger" ? "bg-danger" : "bg-subtle")}>
      <Text className={cn("text-xs font-t3-medium", props.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")}>{props.label}</Text>
    </View>
  );
}

type IntegrationsModel = ReturnType<typeof useIntegrations>;

/** Search the catalog or type an address; choosing one runs the probe, and Add waits for its result. */
function AddIntegrationSection(props: { readonly integrations: IntegrationsModel }) {
  const { integrations } = props;
  const { catalog, connected, searchCatalog, clearCatalog, probe, clearProbe } = integrations;
  const [query, setQuery] = useState("");
  const [candidate, setCandidate] = useState<IntegrationCandidate | null>(null);

  // The most popular entries show before the person types.
  useEffect(() => {
    if (connected) searchCatalog("");
  }, [connected, searchCatalog]);

  const changeQuery = (next: string) => {
    setQuery(next);
    if (looksLikeUrl(next)) clearCatalog();
    else searchCatalog(next);
  };

  const choose = (next: IntegrationCandidate) => {
    setCandidate(next);
    probe(next.url);
  };

  const cancel = () => {
    setCandidate(null);
    clearProbe();
  };

  const add = (chosen: IntegrationCandidate) => {
    integrations.create({ ...chosen, name: chosen.name.trim() }).then(
      () => {
        cancel();
        setQuery("");
        searchCatalog("");
      },
      (cause: unknown) => Alert.alert("Not added", errorMessage(cause)),
    );
  };

  if (candidate) {
    return (
      <CandidateCard
        integrations={integrations}
        candidate={candidate}
        onRename={(name) => setCandidate({ ...candidate, name })}
        onAdd={() => add(candidate)}
        onCancel={cancel}
      />
    );
  }

  const typedUrl = looksLikeUrl(query);
  return (
    <View className="gap-3">
      <SettingsSection title="Add an integration">
        <View className="p-4">
          <AddProjectTextInput
            value={query}
            onChangeText={changeQuery}
            placeholder="Search, or enter an https:// address"
            accessibilityLabel="Search the catalog or enter an address"
            keyboardType={Platform.OS === "ios" ? "web-search" : "default"}
            returnKeyType="search"
          />
        </View>
        {typedUrl ? (
          isIntegrationUrl(query) ? (
            <CandidateRow title="Use this address" detail={query.trim()} onPress={() => choose(customCandidate(query))} />
          ) : null
        ) : (
          <CatalogResults catalog={catalog} onRetry={() => searchCatalog(query)} onChoose={(entry) => choose(catalogCandidate(entry))} />
        )}
      </SettingsSection>
      {typedUrl && !isIntegrationUrl(query) ? (
        <SettingsNote tone="danger">Use an HTTPS address with no credentials, query, or fragment.</SettingsNote>
      ) : (
        <SettingsNote>The host checks the server before you add it. Servers come from the integrations.sh catalog.</SettingsNote>
      )}
    </View>
  );
}

function CandidateRow(props: { readonly title: string; readonly detail: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.title}, ${props.detail}`}
      onPress={props.onPress}
      className="flex-row items-center gap-4 border-t border-border-subtle p-4 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground" numberOfLines={1}>{props.title}</Text>
        {props.detail ? <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="tail">{props.detail}</Text> : null}
      </View>
      <SymbolView name="plus" size={16} tintColorClassName="accent-chevron" type="monochrome" weight="semibold" />
    </Pressable>
  );
}

/** The chosen server: its name, address, and what the probe found. Add waits for a result that allows it. */
function CandidateCard(props: {
  readonly integrations: IntegrationsModel;
  readonly candidate: IntegrationCandidate;
  readonly onRename: (name: string) => void;
  readonly onAdd: () => void;
  readonly onCancel: () => void;
}) {
  const { integrations, candidate } = props;
  const { probeState, connected, probe } = integrations;
  const outcome = probeState.kind === "done" && probeState.url === candidate.url ? probeOutcomeView(probeState.result) : null;
  const probeError = probeState.kind === "error" && probeState.url === candidate.url ? probeState.message : null;
  const checking = probeState.kind === "probing";
  return (
    <View className="gap-3">
      <SettingsSection title="Add an integration">
        <View className="gap-3 p-4">
          <AddProjectTextInput
            value={candidate.name}
            onChangeText={props.onRename}
            placeholder="Name"
            accessibilityLabel="Integration name"
          />
          <Text className="px-1 text-sm text-foreground-muted" selectable numberOfLines={2} ellipsizeMode="middle">{candidate.url}</Text>
          {checking ? (
            <View className="flex-row items-center gap-2 px-1">
              <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
              <Text className="text-sm text-foreground-muted">Checking the server…</Text>
            </View>
          ) : outcome ? (
            <View className="gap-0.5 px-1">
              <Text className={cn("text-base font-t3-medium", outcome.canAdd ? "text-foreground" : "text-danger-foreground")}>{outcome.title}</Text>
              {outcome.detail ? <Text className="text-sm text-foreground-muted">{outcome.detail}</Text> : null}
            </View>
          ) : probeError ? (
            <Text className="px-1 text-sm text-danger-foreground">{`The server could not be checked: ${probeError}`}</Text>
          ) : null}
          <PrimaryActionButton
            label="Add"
            disabled={!outcome?.canAdd || candidate.name.trim().length === 0 || integrations.busy !== null || !connected}
            loading={integrations.busy === "create"}
            onPress={props.onAdd}
          />
        </View>
        {outcome?.canRetry || probeError ? (
          <SettingsActionRow icon="arrow.clockwise" label="Retry" disabled={checking} onPress={() => probe(candidate.url)} />
        ) : null}
        <SettingsActionRow icon="xmark" label="Cancel" disabled={integrations.busy === "create"} onPress={props.onCancel} />
      </SettingsSection>
    </View>
  );
}

function CatalogResults(props: { readonly catalog: CatalogState; readonly onRetry: () => void; readonly onChoose: (entry: CatalogEntry) => void }) {
  const { catalog } = props;
  return catalog.kind === "loading" ? (
    <View className="items-center pb-4">
      <ActivityIndicator accessibilityLabel="Searching the catalog" colorClassName="accent-icon-muted" />
    </View>
  ) : catalog.kind === "error" ? (
    <View className="gap-2 px-4 pb-4">
      <SettingsNote tone="danger">{`The catalog is unavailable: ${catalog.message}`}</SettingsNote>
      <Pressable
        accessibilityRole="button"
        onPress={props.onRetry}
        className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
      >
        <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
      </Pressable>
    </View>
  ) : catalog.kind === "loaded" && catalog.entries.length === 0 ? (
    <View className="px-4 pb-4">
      <SettingsNote>No catalog entry matches. Enter the server's https:// address instead.</SettingsNote>
    </View>
  ) : catalog.kind === "loaded" ? (
    <>
      {catalog.entries.map((entry) => (
        <CandidateRow
          key={entry.id}
          title={entry.name}
          detail={[entry.domain, firstLine(entry.description)].filter(Boolean).join(" · ")}
          onPress={() => props.onChoose(entry)}
        />
      ))}
    </>
  ) : null;
}
