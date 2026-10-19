import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CATALOG_CATEGORIES, toolAccess, type Integration, type IntegrationToolSummary } from "@solus/contracts/integration-types";
import { resourceAllows } from "@solus/contracts/permissions";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { AddProjectTextInput } from "../projects/components/add-project-ui";
import { IntegrationConnectPanel } from "./components/IntegrationConnectPanel";
import { IntegrationOAuthClientPanel } from "./components/IntegrationOAuthClientPanel";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { ServerIcon } from "./components/ServerIcon";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  afterCreate,
  catalogCandidate,
  catalogCountText,
  isNearEnd,
  customCandidate,
  errorMessage,
  filterInstalled,
  firstLine,
  installedStatus,
  isInstalled,
  isIntegrationUrl,
  looksLikeUrl,
  mayLoadTools,
  needsOAuthClient,
  UNSUPPORTED_NOTE,
  urlHost,
  type IntegrationCandidate,
  type IntegrationToolsState,
} from "./integrations";
import { useIntegrations } from "./use-integrations";

type IntegrationsModel = ReturnType<typeof useIntegrations>;

/**
 * The MCP servers of one host (docs/plans/mcp-integrations.md §7): one search
 * over the installed servers and the paged catalog. Add checks the server and
 * creates it in one step, then starts the person's sign-in when the server
 * needs one (§4). Each installed row has one status line and its Connect
 * action; opening it shows the sign-in, the OAuth client form, the tools, and
 * Rename, Remove, and Disconnect. The same capability as Settings → MCP on
 * desktop and web.
 */
export function IntegrationsScreen({ route }: ScreenProps<"Integrations">) {
  const { hostId } = route.params;
  const insets = useSafeAreaInsets();
  const integrations = useIntegrations(hostId);
  const { list, connected, searchCatalog, clearCatalog, clearAdding } = integrations;
  const [query, setQuery] = useState("");

  // The most popular entries show before the person types.
  useEffect(() => {
    if (connected) searchCatalog("");
  }, [connected, searchCatalog]);

  const changeQuery = (next: string) => {
    setQuery(next);
    clearAdding();
    if (looksLikeUrl(next)) clearCatalog();
    else searchCatalog(next);
  };

  const add = (candidate: IntegrationCandidate) => {
    void integrations.add(candidate).then((integration) => {
      if (!integration) return;
      const next = afterCreate(integration);
      if (next !== "none") integrations.expand(integration.id);
      if (next === "connect") void integrations.flows.connect(integration);
    });
  };

  return (
    <SettingsScreen title="MCP">
      <HostStatusBanner hostId={hostId} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={200}
        onScroll={({ nativeEvent }) => {
          if (isNearEnd(nativeEvent.layoutMeasurement.height, nativeEvent.contentOffset.y, nativeEvent.contentSize.height)) integrations.loadMoreCatalog();
        }}
      >
        {list.kind === "unsupported" ? (
          <SettingsNote>{UNSUPPORTED_NOTE}</SettingsNote>
        ) : list.kind === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`MCP servers could not be read: ${list.message}`} />
            <PillButton label="Try again" onPress={integrations.reload} />
          </View>
        ) : list.kind === "loading" ? (
          connected ? (
            <View className="items-center py-2">
              <ActivityIndicator accessibilityLabel="Reading MCP servers" colorClassName="accent-icon-muted" />
            </View>
          ) : (
            <SettingsNote>Connect this host to manage its MCP servers.</SettingsNote>
          )
        ) : (
          <>
            <AddProjectTextInput
              value={query}
              onChangeText={changeQuery}
              placeholder="Search MCP servers"
              accessibilityLabel="Search MCP servers, or enter an https:// address"
              keyboardType={Platform.OS === "ios" ? "web-search" : "default"}
              returnKeyType="search"
            />
            <InstalledSection integrations={integrations} installed={list.integrations} query={query} />
            {looksLikeUrl(query) ? (
              <CustomAddressSection integrations={integrations} installed={list.integrations} address={query.trim()} onAdd={add} />
            ) : (
              <CatalogSection integrations={integrations} installed={list.integrations} query={query} onAdd={add} />
            )}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function InstalledSection(props: { readonly integrations: IntegrationsModel; readonly installed: readonly Integration[]; readonly query: string }) {
  const { integrations, installed } = props;
  const shown = filterInstalled(installed, looksLikeUrl(props.query) ? "" : props.query);

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

  const confirmDisconnect = (integration: Integration) => {
    Alert.alert(`Disconnect ${integration.name}?`, "Agents can no longer use its tools for you until you connect again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => {
          integrations.disconnect(integration.id).catch((cause: unknown) => Alert.alert("Not disconnected", errorMessage(cause)));
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
      Alert.prompt("Rename MCP server", undefined, (value) => commit(value ?? ""), "plain-text", integration.name);
      return;
    }
    showTextInputDialog({ title: "Rename MCP server", initialValue: integration.name, confirmText: "Rename", onConfirm: commit });
  };

  if (installed.length === 0) {
    return <SettingsNote>No MCP servers yet. Add one from the catalog to give agents on this host its tools.</SettingsNote>;
  }
  return (
    <View className="gap-3">
      <SettingsSection title="Installed">
        {shown.length === 0 ? (
          <View className="p-4">
            <SettingsNote>No installed server matches.</SettingsNote>
          </View>
        ) : (
          shown.map((integration, index) => (
            <InstalledRow
              key={integration.id}
              integration={integration}
              first={index === 0}
              integrations={integrations}
              onRename={() => promptRename(integration)}
              onRemove={() => confirmRemove(integration)}
              onDisconnect={() => confirmDisconnect(integration)}
            />
          ))
        )}
      </SettingsSection>
      <SettingsNote>Agents on this host can use the tools of these servers.</SettingsNote>
    </View>
  );
}

function InstalledRow(props: {
  readonly integration: Integration;
  readonly first: boolean;
  readonly integrations: IntegrationsModel;
  readonly onRename: () => void;
  readonly onRemove: () => void;
  readonly onDisconnect: () => void;
}) {
  const { integration, integrations } = props;
  const { busy, connections, flows } = integrations;
  const expanded = integrations.expanded.has(integration.id);
  const status = installedStatus(integration, connections);
  const connection = connections.kind === "loaded" ? connections.byIntegration.get(integration.id) : undefined;
  const flow = flows.flows.get(integration.id);
  const host = urlHost(integration.url);
  // An integration is personal: only its owner changes it (docs/plans/access-model.md §2.7).
  const canEdit = resourceAllows(integration, "edit");
  const editable = busy === null && canEdit;
  const connect = () => {
    integrations.expand(integration.id);
    void flows.connect(integration);
  };
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-3 pr-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${integration.name}, ${host}, ${status.text}`}
          accessibilityState={{ expanded }}
          onPress={() => integrations.toggle(integration.id)}
          className="min-w-0 flex-1 flex-row items-center gap-4 py-4 pl-4 active:opacity-70"
        >
          <ServerIcon url={integration.url} name={integration.name} />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-lg text-foreground" numberOfLines={1}>{integration.name}</Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{host}</Text>
            <Text className={cn("text-sm", status.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")} numberOfLines={1}>{status.text}</Text>
          </View>
        </Pressable>
        {status.action && !flow ? (
          <PillButton
            label={status.action === "connect" ? "Connect" : "Reconnect"}
            accessibilityLabel={`${status.action === "connect" ? "Connect" : "Reconnect"} ${integration.name}`}
            disabled={!flows.connected}
            onPress={connect}
          />
        ) : (
          <SymbolView name={expanded ? "chevron.up" : "chevron.down"} size={16} tintColorClassName="accent-chevron" type="monochrome" weight="semibold" />
        )}
      </View>
      {flow ? (
        <View className="px-4 pb-4 pl-[58px]">
          <IntegrationConnectPanel
            key={flow.step}
            flow={flow}
            connected={flows.connected}
            onOpen={() => flows.openSignIn(integration.id)}
            onSubmit={(value) => void flows.submit(integration.id, value)}
            onCancel={() => void flows.cancel(integration.id)}
            onDone={() => void flows.cancel(integration.id)}
          />
        </View>
      ) : null}
      {expanded ? (
        <View>
          {connection?.error ? (
            <View className="px-4 pb-3 pl-[58px]">
              <Text className="text-sm text-foreground-muted" selectable>{connection.error}</Text>
            </View>
          ) : null}
          {needsOAuthClient(integration) ? (
            <View className="px-4 pb-4 pl-[58px]">
              <IntegrationOAuthClientPanel
                integration={integration}
                saving={busy === `oauth-client:${integration.id}`}
                enabled={integrations.connected && editable}
                onSave={(client) => integrations.setOAuthClient(integration.id, client)}
              />
            </View>
          ) : null}
          {mayLoadTools(integration, connections) ? (
            <IntegrationTools
              integration={integration}
              tools={integrations.tools.get(integration.id)}
              enabled={integrations.connected && editable}
              onToggle={(toolName, isOn) => {
                integrations.setToolEnabled(integration, toolName, isOn).catch((cause: unknown) => Alert.alert("Not saved", errorMessage(cause)));
              }}
            />
          ) : (
            <View className="px-4 pb-3 pl-[58px]">
              <SettingsNote>Connect to see its tools.</SettingsNote>
            </View>
          )}
          <OwnerOnlyNote hidden={canEdit} />
          <SettingsActionRow icon="pencil" label="Rename" loading={busy === `rename:${integration.id}`} disabled={!editable} onPress={props.onRename} />
          {connection ? (
            <SettingsActionRow
              icon="xmark.circle.fill"
              label="Disconnect"
              tone="danger"
              loading={busy === `disconnect:${integration.id}`}
              disabled={!integrations.connected || busy !== null}
              onPress={props.onDisconnect}
            />
          ) : null}
          <SettingsActionRow icon="trash" label="Remove" tone="danger" loading={busy === `remove:${integration.id}`} disabled={!editable} onPress={props.onRemove} />
        </View>
      ) : null}
    </View>
  );
}

/** Why a server's changes are off: it is another person's (docs/plans/access-model.md §2.7). */
function OwnerOnlyNote(props: { readonly hidden: boolean }) {
  if (props.hidden) return null;
  return (
    <View className="px-4 pb-3 pl-[58px]">
      <SettingsNote>Only its owner can change this server.</SettingsNote>
    </View>
  );
}

/** The server's tools, each with a switch that keeps it on or turns it off for agents on this host. */
function IntegrationTools(props: {
  readonly integration: Integration;
  readonly tools: IntegrationToolsState | undefined;
  readonly enabled: boolean;
  readonly onToggle: (toolName: string, isOn: boolean) => void;
}) {
  const { tools } = props;
  if (!tools || tools.kind === "loading") {
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
      {tools.tools.map((tool) => (
        <ToolLine
          key={tool.name}
          tool={tool}
          isOn={!props.integration.disabledTools.includes(tool.name)}
          enabled={props.enabled}
          onToggle={(isOn) => props.onToggle(tool.name, isOn)}
        />
      ))}
    </View>
  );
}

function ToolLine(props: {
  readonly tool: IntegrationToolSummary;
  readonly isOn: boolean;
  readonly enabled: boolean;
  readonly onToggle: (isOn: boolean) => void;
}) {
  const { tool } = props;
  const description = firstLine(tool.description);
  const access = toolAccess(tool);
  return (
    <View className="flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Text className="font-mono text-sm text-foreground" selectable>{tool.title || tool.name}</Text>
          <Badge label={access} tone={access === "Destructive" ? "danger" : "muted"} />
        </View>
        {description ? <Text className="text-sm text-foreground-muted" numberOfLines={2}>{description}</Text> : null}
      </View>
      <ThemedSwitch
        value={props.isOn}
        disabled={!props.enabled}
        onValueChange={props.onToggle}
        accessibilityLabel={`Let agents use ${tool.title || tool.name}`}
      />
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

/** A typed https:// address: Add it as a custom server, under the name of its host. */
function CustomAddressSection(props: {
  readonly integrations: IntegrationsModel;
  readonly installed: readonly Integration[];
  readonly address: string;
  readonly onAdd: (candidate: IntegrationCandidate) => void;
}) {
  if (!isIntegrationUrl(props.address)) {
    return <SettingsNote tone="danger">Use an HTTPS address with no credentials or fragment.</SettingsNote>;
  }
  const candidate = customCandidate(props.address);
  return (
    <SettingsSection title="Custom server">
      <AddRow
        integrations={props.integrations}
        candidate={candidate}
        title={`Add ${props.address}`}
        detail="The host checks the server before it adds it."
        icon={null}
        added={isInstalled(props.installed, candidate.url)}
        first
        onAdd={props.onAdd}
      />
    </SettingsSection>
  );
}

function CatalogSection(props: {
  readonly integrations: IntegrationsModel;
  readonly installed: readonly Integration[];
  readonly query: string;
  readonly onAdd: (candidate: IntegrationCandidate) => void;
}) {
  const { integrations } = props;
  const { catalog } = integrations;
  const count = catalog.kind === "loaded" ? catalogCountText(catalog.total) : "";
  const category = CATALOG_CATEGORIES.find((entry) => entry.id === integrations.category) ?? null;
  const hasMore = catalog.kind === "loaded" && !catalog.searching && catalog.entries.length < catalog.total;
  return (
    <View className="gap-3">
      <View className="flex-row">
        <ListFilterMenu
          label={category?.label ?? "All categories"}
          accessibilityLabel="Filter the catalog by category"
          active={category !== null}
          actions={[
            { id: "all", title: "All categories", state: category === null ? "on" : "off" },
            ...CATALOG_CATEGORIES.map((entry) => ({ id: entry.id, title: entry.label, state: entry.id === category?.id ? ("on" as const) : ("off" as const) })),
          ]}
          onSelect={(id) => integrations.setCategory(CATALOG_CATEGORIES.find((entry) => entry.id === id)?.id ?? null, props.query)}
        />
      </View>
      <SettingsSection
        title={category?.label ?? "Catalog"}
        trailing={count ? <Text className="text-sm tabular-nums text-foreground-muted">{count}</Text> : undefined}
      >
        {catalog.kind === "loading" || catalog.kind === "idle" ? (
          <View className="items-center p-4">
            <ActivityIndicator accessibilityLabel="Searching the catalog" colorClassName="accent-icon-muted" />
          </View>
        ) : catalog.kind === "error" ? (
          <View className="gap-2 p-4">
            <SettingsNote tone="danger">{`The catalog is unavailable: ${catalog.message}`}</SettingsNote>
            <PillButton label="Try again" onPress={() => integrations.retryCatalog(props.query)} />
          </View>
        ) : catalog.entries.length === 0 ? (
          <View className="p-4">
            <SettingsNote>No catalog entry matches. Enter the server's https:// address instead.</SettingsNote>
          </View>
        ) : (
          <View style={{ opacity: catalog.searching ? 0.6 : 1 }} accessibilityState={{ busy: catalog.searching }}>
          {catalog.entries.map((entry, index) => (
            <AddRow
              key={entry.id}
              integrations={integrations}
              candidate={catalogCandidate(entry)}
              title={entry.name}
              detail={firstLine(entry.description) || entry.domain}
              icon={entry.icon ?? null}
              added={isInstalled(props.installed, entry.url)}
              first={index === 0}
              onAdd={props.onAdd}
            />
          ))}
          </View>
        )}
      </SettingsSection>
      {hasMore ? (
        <View className="items-center">
          {catalog.kind === "loaded" && catalog.loadingMore ? (
            <ActivityIndicator accessibilityLabel="Loading more servers" colorClassName="accent-icon-muted" />
          ) : (
            <PillButton label="Show more" onPress={integrations.loadMoreCatalog} />
          )}
        </View>
      ) : null}
      <SettingsNote>Servers come from the integrations.sh catalog.</SettingsNote>
    </View>
  );
}

/** One server to add: Add, Added, Checking…, or why the add stopped with Retry. */
function AddRow(props: {
  readonly integrations: IntegrationsModel;
  readonly candidate: IntegrationCandidate;
  readonly title: string;
  readonly detail: string;
  readonly icon: string | null;
  readonly added: boolean;
  readonly first: boolean;
  readonly onAdd: (candidate: IntegrationCandidate) => void;
}) {
  const { integrations, candidate } = props;
  const { adding } = integrations;
  const mine = adding?.url === candidate.url ? adding : null;
  const otherAddRunning = adding?.step === "checking" && !mine;
  const canAdd = integrations.connected && integrations.busy === null && !otherAddRunning;
  // A failed add says why on the detail line, so the row keeps its height.
  const failed = mine?.step === "failed" && !props.added ? mine : null;
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-3 p-4">
        <ServerIcon icon={props.icon ?? undefined} url={candidate.url} name={candidate.name} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg text-foreground" numberOfLines={1} ellipsizeMode="middle">{props.title}</Text>
          {failed ? (
            <Text className="text-sm text-danger-foreground" numberOfLines={2} accessibilityRole="alert">{failed.message}</Text>
          ) : props.detail ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>{props.detail}</Text>
          ) : null}
        </View>
        {props.added ? (
          <Text className="text-sm text-foreground-muted">Added</Text>
        ) : mine?.step === "checking" ? (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
            <Text className="text-sm text-foreground-muted">Checking…</Text>
          </View>
        ) : (
          <PillButton label={failed ? "Retry" : "Add"} accessibilityLabel={`${failed ? "Retry adding" : "Add"} ${candidate.name}`} disabled={!canAdd} onPress={() => props.onAdd(candidate)} />
        )}
      </View>
    </View>
  );
}

function PillButton(props: { readonly label: string; readonly accessibilityLabel?: string; readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn("self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70", props.disabled && "opacity-40")}
    >
      <Text className="text-xs font-t3-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
