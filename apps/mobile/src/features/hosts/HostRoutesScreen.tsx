import { newRouteRefusalText, routeBlockText, routeInUse, routeKindLabel, routeRows, type RouteRow } from "@solus/client-core/host-route-control";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

function RouteAction(props: {
  readonly icon: "arrow.up" | "arrow.down" | "xmark";
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="size-9 items-center justify-center disabled:opacity-30"
    >
      <SymbolView name={props.icon} size={18} tintColorClassName="accent-icon" />
    </Pressable>
  );
}

function HostRouteRow(props: {
  readonly row: RouteRow;
  readonly inUse: boolean;
  readonly canMove: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onMove: (step: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { row } = props;
  return (
    <View className="flex-row items-center gap-1 p-4">
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-base text-foreground">{routeKindLabel(row.kind)}</Text>
          {props.inUse ? <Text className="text-sm font-t3-medium text-foreground-muted">In use</Text> : null}
        </View>
        <Text selectable numberOfLines={2} className="text-sm text-foreground-muted">
          {row.url}{row.isLearned ? " · found automatically" : ""}
        </Text>
        {row.block ? <Text className="text-sm text-foreground-muted">{routeBlockText(row.block)}</Text> : null}
      </View>
      {props.canMove ? (
        <>
          <RouteAction icon="arrow.up" label={`Move ${row.url} up`} disabled={props.isFirst} onPress={() => props.onMove(-1)} />
          <RouteAction icon="arrow.down" label={`Move ${row.url} down`} disabled={props.isLast} onPress={() => props.onMove(1)} />
        </>
      ) : null}
      {row.canRemove ? <RouteAction icon="xmark" label={`Remove ${row.url}`} onPress={props.onRemove} /> : null}
    </View>
  );
}

/**
 * The ways this device reaches one host, the first it tries at the top
 * (docs/plans/host-routes.md §12): which one is in use, and the controls to add an
 * address, change the order, and remove a route. The rules are the ones desktop
 * and web use (`host-route-control.ts`).
 */
export function HostRoutesScreen({ route }: ScreenProps<"HostRoutes">) {
  const { hostId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const host = useListened(app.registry.changes, () => app.registry.host(hostId));
  const dialedUrl = useListened(app.connections.changes, () => app.connections.dialedUrl(hostId));
  const isReady = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === "ready");
  const [address, setAddress] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = host ? routeRows(host, { clientOrigin: "" }) : [];
  const inUse = routeInUse(rows, dialedUrl, isReady);
  const canChange = host?.uplink?.kind !== "managed";

  const addRoute = async () => {
    setIsChecking(true);
    const refusal = await app.connections.addRoute(hostId, address);
    setIsChecking(false);
    setError(refusal ? newRouteRefusalText(refusal) : null);
    if (!refusal) setAddress("");
  };

  const confirmRemove = (row: RouteRow) => {
    Alert.alert("Remove this route?", row.url, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => app.connections.removeRoute(hostId, row.url) },
    ]);
  };

  return (
    <SettingsScreen title="Routes">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <SettingsSection title="Routes">
            {rows.map((row, index) => (
              <HostRouteRow
                key={row.url}
                row={row}
                inUse={row.url === inUse}
                canMove={canChange}
                isFirst={index === 0}
                isLast={index === rows.length - 1}
                onMove={(step) => app.connections.moveRoute(hostId, row.url, step)}
                onRemove={() => confirmRemove(row)}
              />
            ))}
            {rows.length === 0 ? (
              <Text className="p-4 text-sm text-foreground-muted">This device has no route to this host.</Text>
            ) : null}
          </SettingsSection>
          <SettingsNote>
            {canChange
              ? "Solus uses the first route that answers as this host, and moves back to an earlier route when it answers again. This list is for this device."
              : "Solus Cloud sets how this host is reached."}
          </SettingsNote>
        </View>

        {canChange ? (
          <View className="gap-3">
            <ConnectionFormField
              label="Address"
              placeholder="https://solus.example.com or 10.0.0.8:3000"
              value={address}
              onChangeText={setAddress}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!isChecking}
              onSubmitEditing={() => void addRoute()}
            />
            {error ? <ErrorBanner message={error} /> : null}
            <ConnectionSheetButton
              icon="plus"
              label={isChecking ? "Checking…" : "Add route"}
              disabled={isChecking || !address.trim()}
              onPress={() => void addRoute()}
            />
          </View>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
