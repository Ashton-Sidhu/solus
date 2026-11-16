import type { DiscoveredServer } from "@solus/contracts/types";
import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ConnectOptionCard } from "../connection/ConnectOptionCard";
import { nearbyHostDetail, type NearbyHosts } from "./use-nearby-hosts";

/**
 * Solus hosts on this phone's network, or on the tailnet as a connected host
 * sees it, that it has not paired yet. A tap
 * opens pairing with the host already chosen, so only its code is left to type.
 */
export function NearbyHostsSection({
  nearby,
  onSelect,
}: {
  readonly nearby: NearbyHosts;
  readonly onSelect: (server: DiscoveredServer) => void;
}) {
  if (!nearby.canScan) return null;

  return (
    <View collapsable={false} className="gap-2">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-sm font-t3-medium text-foreground-muted" accessibilityRole="header">
          Nearby
        </Text>
        {nearby.isScanning ? (
          <ActivityIndicator accessibilityLabel="Looking for hosts" colorClassName="accent-icon-muted" />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan again"
            hitSlop={10}
            className="min-h-8 flex-row items-center gap-1 active:opacity-70"
            onPress={nearby.scan}
          >
            <SymbolView name="arrow.clockwise" size={13} tintColorClassName="accent-icon-muted" type="monochrome" />
            <Text className="text-sm text-foreground-muted">Scan</Text>
          </Pressable>
        )}
      </View>
      {nearby.hosts.map((server) => (
        <ConnectOptionCard
          key={server.installationId}
          icon="desktopcomputer"
          title={server.name}
          detail={nearbyHostDetail(server)}
          onPress={() => onSelect(server)}
        />
      ))}
      {nearby.hosts.length === 0 && nearby.hasScanned && !nearby.isScanning ? (
        <Text className="px-1 text-[13px] leading-normal text-foreground-muted">
          No unpaired hosts found on this Wi-Fi network or on your tailnet. This device finds tailnet hosts
          only through a host it is connected to.
        </Text>
      ) : null}
    </View>
  );
}
