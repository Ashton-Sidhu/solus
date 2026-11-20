import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import type { FoundServer } from "@solus/contracts/integration-types";
import {
  NO_FOUND_SERVERS_TEXT,
  configFileLabel,
  fileValuesText,
  foundPlacesText,
  foundStateText,
  foundTargetText,
  foundUnsupportedText,
} from "@solus/contracts/integrations/found-server-labels";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useFoundServers } from "../use-found-servers";
import { ServerIcon } from "./ServerIcon";
import { SettingsNote } from "./SettingsNote";
import { SettingsSection } from "./SettingsSection";

/**
 * Found on this host (docs/plans/mcp-first-class.md §8.6): the MCP servers in
 * the config files of the host, with Add, Review change, or why one cannot be
 * added. The rows follow the catalog's `AddRow`; the approval is the native
 * alert, which shows the full command the host would run.
 */
export function FoundServersSection(props: { readonly hostId: string }) {
  const found = useFoundServers(props.hostId);
  const { list } = found;

  const review = (server: FoundServer) => {
    const isChange = server.state === "changed";
    const lines = [
      foundTargetText(server),
      foundPlacesText(server),
      server.transport?.kind === "stdio" ? "It runs on this host as the Solus server's user. It does not start until you start it." : "",
    ].filter(Boolean);
    const confirm = (useFileValues: boolean) => {
      void found.add(server, useFileValues).then((result) => {
        if (result.kind === "found-changed") Alert.alert(`${server.name} changed`, "It changed in its file. Read it again before you add it.");
        else if (result.kind === "failed") Alert.alert(`${server.name} was not added`, result.message);
      });
    };
    const valuesText = fileValuesText(server);
    const verb = isChange ? "Update" : "Add";
    Alert.alert(isChange ? `Review the change to ${server.name}` : `Add ${server.name}?`, lines.join("\n\n"), [
      { text: "Cancel", style: "cancel" },
      ...(valuesText ? [{ text: `${verb} and use the file's values`, onPress: () => confirm(true) }] : []),
      { text: verb, onPress: () => confirm(false) },
    ]);
  };

  const refresh = (
    <Pressable accessibilityRole="button" accessibilityLabel="Read the config files again" disabled={!found.connected || found.refreshing} onPress={found.refresh}
      className={cn("active:opacity-70", (!found.connected || found.refreshing) && "opacity-40")}>
      <Text className="text-sm text-foreground-muted">{found.refreshing ? "Reading…" : "Refresh"}</Text>
    </Pressable>
  );

  return (
    <SettingsSection title="Found on this host" trailing={list.kind === "loaded" ? refresh : undefined}>
      {list.kind === "loading" ? (
        <View className="items-center p-4">
          <ActivityIndicator accessibilityLabel="Reading the config files" colorClassName="accent-icon-muted" />
        </View>
      ) : list.kind === "unsupported" ? (
        <View className="p-4"><SettingsNote>This host is older than found servers. Update Solus on it.</SettingsNote></View>
      ) : list.kind === "error" ? (
        <View className="p-4"><SettingsNote tone="danger">{`The config files could not be read: ${list.message}`}</SettingsNote></View>
      ) : (
        <View>
          {list.servers.length === 0 ? <View className="p-4"><SettingsNote>{NO_FOUND_SERVERS_TEXT}</SettingsNote></View> : null}
          {list.servers.map((server, index) => (
            <FoundRow key={server.foundId} server={server} first={index === 0} isAdding={found.adding === server.foundId} canAdd={found.connected && found.adding === null} onReview={review} />
          ))}
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

function FoundRow(props: { readonly server: FoundServer; readonly first: boolean; readonly isAdding: boolean; readonly canAdd: boolean; readonly onReview: (server: FoundServer) => void }) {
  const { server } = props;
  const url = server.transport && server.transport.kind !== "stdio" ? server.transport.url : "";
  const canReview = server.state === "new" || server.state === "changed";
  return (
    <View className={cn("gap-1 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-3">
        <ServerIcon url={url} name={server.name} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg text-foreground" numberOfLines={1}>{server.name}</Text>
          <Text className="font-mono text-sm text-foreground-muted" selectable>{foundTargetText(server)}</Text>
          <Text className="text-sm text-foreground-muted">{foundPlacesText(server)}</Text>
        </View>
        {props.isAdding ? (
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : canReview ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={server.state === "changed" ? `Review the change of ${server.name}` : `Add ${server.name}`}
            accessibilityState={{ disabled: !props.canAdd }}
            disabled={!props.canAdd}
            onPress={() => props.onReview(server)}
            className={cn("self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70", !props.canAdd && "opacity-40")}
          >
            <Text className="text-xs font-t3-bold text-foreground">{server.state === "changed" ? "Review change" : "Add"}</Text>
          </Pressable>
        ) : (
          <Text className="text-sm text-foreground-muted">{foundStateText(server)}</Text>
        )}
      </View>
      {server.state === "unsupported" && server.unsupported ? <SettingsNote>{foundUnsupportedText(server.unsupported)}</SettingsNote> : null}
    </View>
  );
}
