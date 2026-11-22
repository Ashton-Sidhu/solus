import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import type { FoundServer, Integration } from "@solus/contracts/integration-types";
import {
  ALL_FOUND_ADDED_TEXT,
  FOUND_FOOTER_TEXT,
  FoundServerLabels,
  NO_FOUND_SERVERS_TEXT,
  configFileLabel,
  foundDeleteQuestion,
  foundFileActions,
  portScanUnavailableText,
  type FoundFileAction,
} from "@solus/contracts/integrations/found-server-labels";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { notAddedServers, type FoundServersModel, type FoundTest } from "../use-found-servers";
import { FoundSourceLogo } from "./FoundSourceLogo";
import { ServerIcon } from "./ServerIcon";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsNote } from "./SettingsNote";
import { SettingsSection } from "./SettingsSection";

/**
 * The servers found on one host (docs/plans/mcp-first-class.md §8.6, §8.8,
 * §8.9): the MCP servers in the config files of the host that Solus does not have, with Add or Review
 * change; an added one is under Installed. The approval is the native alert,
 * which shows the full command the host would run. A tap opens a row: Test and
 * show tools starts the server once and lists its tools, and a host
 * administrator turns it off or on for a tool or deletes it from a file, after
 * a question. Opening a file is the one capability of desktop and web a phone
 * does not have: it has no editor for a file of the host. Each row shows the
 * logo of each tool whose config file has the server.
 */
export function FoundServersSection(props: {
  readonly found: FoundServersModel;
  /** "Found on <host>": the screen shows one section for each host. */
  readonly title: string;
  /** The first section carries Refresh, which reads every host again. */
  readonly showsRefresh: boolean;
  /** The host's name, for the place of a server on its loopback. */
  readonly hostLabel: string;
  /** A command added without all its values: the screen opens its values panel (§7.6). */
  readonly onNeedsValues: (integration: Integration) => void;
}) {
  const { found } = props;
  const { list } = found;
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  const toggle = (foundId: string) => setOpenIds((current) => {
    const next = new Set(current);
    if (next.has(foundId)) next.delete(foundId);
    else next.add(foundId);
    return next;
  });

  const review = (server: FoundServer) => {
    const isChange = server.state === "changed";
    const labels = new FoundServerLabels(server, props.hostLabel);
    const lines = [
      labels.target,
      labels.places,
      labels.portIdentity ?? "",
      labels.missingProgram ?? "",
      server.transport?.kind === "stdio" ? `It runs on ${props.hostLabel} as the Solus server's user. It does not start until you start it.` : "",
    ].filter(Boolean);
    const confirm = (useFileValues: boolean) => {
      void found.add(server, useFileValues).then((result) => {
        if (result.kind === "found-changed") Alert.alert(`${server.name} changed`, "It changed in its file. Read it again before you add it.");
        else if (result.kind === "failed") Alert.alert(`${server.name} was not added`, result.message);
        else if (result.needsValues) props.onNeedsValues(result.integration);
      });
    };
    const valuesText = labels.fileValues;
    const verb = isChange ? "Update" : "Add";
    Alert.alert(isChange ? `Review the change to ${server.name}` : `Add ${server.name}?`, lines.join("\n\n"), [
      { text: "Cancel", style: "cancel" },
      ...(valuesText ? [{ text: `${verb} and use the file's values`, onPress: () => confirm(true) }] : []),
      { text: verb, onPress: () => confirm(false) },
    ]);
  };

  const refresh = (
    <Pressable accessibilityRole="button" accessibilityLabel="Read the config files on every host again" disabled={!found.connected || found.refreshing} onPress={found.refresh}
      className={cn("active:opacity-70", (!found.connected || found.refreshing) && "opacity-40")}>
      <Text className="text-sm text-foreground-muted">{found.refreshing ? "Reading…" : "Refresh"}</Text>
    </Pressable>
  );

  const shown = list.kind === "loaded" ? notAddedServers(list.servers) : [];
  return (
    <SettingsSection title={props.title} trailing={props.showsRefresh && list.kind !== "loading" ? refresh : undefined} footer={shown.length > 0 ? FOUND_FOOTER_TEXT : undefined}>
      {list.kind === "loading" && !found.connected ? (
        <View className="p-4"><SettingsNote>Its servers show when the connection returns.</SettingsNote></View>
      ) : list.kind === "loading" ? (
        <View className="items-center p-4">
          <ActivityIndicator accessibilityLabel="Reading the config files" colorClassName="accent-icon-muted" />
        </View>
      ) : list.kind === "unsupported" ? (
        <View className="p-4"><SettingsNote>This host is older than found servers. Update Solus on it.</SettingsNote></View>
      ) : list.kind === "error" ? (
        <View className="p-4"><SettingsNote tone="danger">{`The config files could not be read: ${list.message}`}</SettingsNote></View>
      ) : (
        <View>
          {shown.length === 0 ? <View className="p-4"><SettingsNote>{list.servers.length ? ALL_FOUND_ADDED_TEXT : NO_FOUND_SERVERS_TEXT}</SettingsNote></View> : null}
          {shown.map((server, index) => (
            <FoundRow
              key={server.foundId}
              server={server}
              labels={new FoundServerLabels(server, props.hostLabel)}
              first={index === 0}
              isOpen={openIds.has(server.foundId)}
              mayChange={list.mayChange}
              isAdding={found.adding === server.foundId}
              isChanging={found.changing === server.foundId}
              canAct={found.connected && found.adding === null && found.changing === null}
              test={found.tests.get(server.foundId)}
              onToggle={() => toggle(server.foundId)}
              onReview={review}
              onTest={() => void found.test(server)}
              onCloseTest={() => found.closeTest(server.foundId)}
              onAction={(action) => runFileAction(found, server, action)}
            />
          ))}
          {list.portScan?.state === "unavailable" ? (
            <View className="border-t border-border-subtle p-4"><SettingsNote>{portScanUnavailableText(list.portScan.reason)}</SettingsNote></View>
          ) : null}
          {list.files.filter((file) => file.problem).map((file) => (
            <View key={file.path} className="border-t border-border-subtle p-4">
              <SettingsNote>{`${configFileLabel(file.file)} (${file.path}) was not read. ${file.problem ?? ""}`}</SettingsNote>
            </View>
          ))}
        </View>
      )}
    </SettingsSection>
  );
}

/** A turn off or on runs at once; a delete asks first. A failure says why in an alert. */
export function runFileAction(found: FoundServersModel, server: FoundServer, action: FoundFileAction, after = ""): void {
  const run = () => {
    void found.change(server, action.place, action.change).then((error) => {
      if (error) Alert.alert(`${action.label} did not work`, error);
    });
  };
  if (action.change !== "delete") return run();
  Alert.alert(`${action.label}?`, `${foundDeleteQuestion(server.name, action.place)}${after}`, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: run },
  ]);
}

/** The icon of a file action on its row. */
export function fileActionIcon(action: FoundFileAction): "trash" | "pause.fill" | "play.fill" {
  return action.change === "delete" ? "trash" : action.change === "turn-off" ? "pause.fill" : "play.fill";
}

function FoundRow(props: {
  readonly server: FoundServer;
  readonly labels: FoundServerLabels;
  readonly first: boolean;
  readonly isOpen: boolean;
  readonly mayChange: boolean;
  readonly isAdding: boolean;
  readonly isChanging: boolean;
  readonly canAct: boolean;
  readonly test: FoundTest | undefined;
  readonly onToggle: () => void;
  readonly onReview: (server: FoundServer) => void;
  readonly onTest: () => void;
  readonly onCloseTest: () => void;
  readonly onAction: (action: FoundFileAction) => void;
}) {
  const { server, labels } = props;
  const url = server.transport && server.transport.kind !== "stdio" ? server.transport.url : "";
  const actions = props.mayChange ? foundFileActions(server) : [];
  const canTest = props.mayChange && server.state !== "unsupported";
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-3 p-4">
        {/* A tap opens the row's test and actions. A server Solus cannot add steps back, so the rows the person can act on lead. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${server.name}, ${labels.state}`}
          accessibilityState={{ expanded: props.isOpen }}
          disabled={!canTest && actions.length === 0}
          onPress={props.onToggle}
          className={cn("min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70", server.state === "unsupported" && "opacity-55")}
        >
          <ServerIcon url={url} name={server.name} />
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row items-center gap-1.5">
              <Text className="shrink text-lg text-foreground" numberOfLines={1}>{server.name}</Text>
              {labels.sources.map((source) => <FoundSourceLogo key={source.label} source={source} />)}
            </View>
            {/* One line; a server Solus cannot add says why. The add alert shows the full command. */}
            <Text className={cn("text-sm text-foreground-muted", !labels.unsupported && "font-mono")} numberOfLines={1} ellipsizeMode="middle">{labels.unsupported ?? labels.target}</Text>
          </View>
        </Pressable>
        <FoundRowAction server={server} state={labels.state} isBusy={props.isAdding || props.isChanging} canAct={props.canAct} onReview={props.onReview} />
      </View>
      {props.isOpen ? (
        <View className="border-t border-border-subtle">
          {props.test ? <FoundTestResult name={server.name} test={props.test} onClose={props.onCloseTest} /> : null}
          {canTest ? (
            <SettingsActionRow icon="bolt.circle" label="Test and show tools" loading={props.test?.kind === "running"} disabled={!props.canAct} onPress={props.onTest} />
          ) : null}
          {actions.map((action) => (
            <SettingsActionRow
              key={`${action.place.path}:${action.change}`}
              icon={fileActionIcon(action)}
              label={action.label}
              description={action.place.path}
              tone={action.change === "delete" ? "danger" : "default"}
              disabled={!props.canAct}
              onPress={() => props.onAction(action)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The row's one action: Add, Review change, a spinner while a change runs, or its state. */
function FoundRowAction(props: { readonly server: FoundServer; readonly state: string; readonly isBusy: boolean; readonly canAct: boolean; readonly onReview: (server: FoundServer) => void }) {
  const { server } = props;
  if (props.isBusy) return <ActivityIndicator size="small" colorClassName="accent-icon-muted" />;
  if (server.state !== "new" && server.state !== "changed") return <Text className="text-sm text-foreground-muted">{props.state}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={server.state === "changed" ? `Review the change of ${server.name}` : `Add ${server.name}`}
      accessibilityState={{ disabled: !props.canAct }}
      disabled={!props.canAct}
      onPress={() => props.onReview(server)}
      className={cn("rounded-full bg-subtle px-3.5 py-2 active:opacity-70", !props.canAct && "opacity-40")}
    >
      <Text className="text-xs font-t3-bold text-foreground">{server.state === "changed" ? "Review change" : "Add"}</Text>
    </Pressable>
  );
}

/** What a test found: the tools an agent would get, or why it failed. */
function FoundTestResult(props: { readonly name: string; readonly test: FoundTest; readonly onClose: () => void }) {
  const { test } = props;
  return (
    <View className="gap-1.5 bg-subtle px-4 py-3" accessibilityLiveRegion="polite">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm font-t3-medium text-foreground-muted">
          {test.kind === "running" ? `Starting ${props.name} to read its tools…` : test.kind === "failed" ? "The test failed" : `${test.tools.length} ${test.tools.length === 1 ? "tool" : "tools"}`}
        </Text>
        {test.kind === "running" ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel={`Close the test of ${props.name}`} onPress={props.onClose} className="active:opacity-70">
            <Text className="text-sm text-foreground-muted">Close</Text>
          </Pressable>
        )}
      </View>
      {test.kind === "failed" ? <SettingsNote tone="danger">{test.message}</SettingsNote> : null}
      {test.kind === "tools" ? test.tools.map((tool) => (
        <Text key={tool.name} className="text-sm text-foreground-muted" numberOfLines={1}>
          <Text className="font-mono text-sm text-foreground">{tool.name}</Text>{tool.description ? `  ${tool.description}` : ""}
        </Text>
      )) : null}
    </View>
  );
}
