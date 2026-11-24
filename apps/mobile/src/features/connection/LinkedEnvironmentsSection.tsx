import { Alert, View } from "react-native";
import type { ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { pairedHostRoute } from "@solus/client-core/host-linking";
import { routeKindLabel } from "@solus/client-core/host-route-control";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useMachineLinks } from "../../solus/use-machine-links";
import { useConnectSolusMachine } from "../../solus/use-connect-solus-machine";

export function LinkedEnvironmentsSection(props: {
  readonly environmentId: EnvironmentId | string;
  readonly environmentLabel: string;
  readonly children?: ReactNode;
}) {
  const machines = useMachineLinks();
  const machine = machines.find(({ info }) => info.installationId === props.environmentId);
  const { connect, connecting } = useConnectSolusMachine();
  if (!machine) return null;
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={`Linked from ${props.environmentLabel}`}>
        {!machine.snapshot ? (
          <Text className="p-4 text-foreground-muted">Machine links are unavailable.</Text>
        ) : machine.snapshot.hosts.length === 0 ? (
          <Text className="p-4 text-foreground-muted">No paired machines.</Text>
        ) : machine.snapshot.hosts.map((link) => {
          const { installationId, label } = link.listing;
          const route = pairedHostRoute(link);
          return (
            <View key={installationId} className="gap-2 p-4">
              <Text className="text-base font-t3-bold text-foreground">{label}</Text>
              <Text className="text-xs text-foreground-muted">
                Owner access{route ? ` · ${routeKindLabel(route.kind)} · ${route.url}` : ""}
              </Text>
              <View className="flex-row gap-2">
                {route ? (
                  <Button label="Connect" size="compact" tone="secondary" disabled={connecting}
                    onPress={() => void connect(installationId, label, route.url)} />
                ) : null}
                <Button label="Unlink" size="compact" tone="text" onPress={() =>
                  Alert.alert(`Unlink ${label}?`, `Remove the pairing from ${machine.label}.`, [
                    { text: "Cancel", style: "cancel" },
                    { text: "Unlink", style: "destructive", onPress: () => {
                      if (!machine.isCurrent()) return;
                      void machine.api.hostsUnlink(installationId).catch(() => Alert.alert("Could not remove this machine link."));
                    } },
                  ])
                } />
              </View>
            </View>
          );
        })}
      </SettingsSection>
      {props.children}
    </View>
  );
}
