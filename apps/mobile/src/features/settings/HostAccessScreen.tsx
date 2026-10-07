import { ActivityIndicator, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsScreen } from "./components/SettingsScreen";
import { canChangeAccess, hasPairing } from "./host-access";
import { HostCloudLinkSection } from "./HostCloudLinkSection";
import {
  HostDevicesSection,
  HostNetworkSection,
  HostOrganizationsSection,
  HostPairingSection,
} from "./HostAccessSections";
import { useHostAccess } from "./use-host-access";

/**
 * How one host is reached and who reaches it: its Solus Cloud link, its
 * organizations, its network, pairing, and the devices with access. The same
 * sections, in the same order, as the Access tab of a host on desktop and web.
 */
export function HostAccessScreen({ navigation, route }: ScreenProps<"HostAccess">) {
  const { hostId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const host = useListened(app.registry.changes, () => app.registry.host(hostId));
  const access = useHostAccess(hostId);
  const { state } = access;

  return (
    <SettingsScreen title={host ? `${host.label} access` : "Access"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <HostCloudLinkSection hostId={hostId} onSignIn={() => navigation.navigate("CloudSignIn")} />

        {state.kind === "loaded" ? (
          <>
            <HostOrganizationsSection access={state} onInsightsOptIn={access.setInsightsOptIn} />
            {hasPairing(state.info) ? (
              <HostNetworkSection
                access={state}
                onRemoteAccess={access.setRemoteAccess}
                onTrustLocalNetwork={access.setTrustLocalNetwork}
              />
            ) : null}
            {hasPairing(state.info) && canChangeAccess(state.info) ? (
              <HostPairingSection access={state} onGenerate={access.generatePairCode} />
            ) : null}
            <HostDevicesSection access={state} onRevoke={access.revokeDevice} />
          </>
        ) : state.kind === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`Access could not be read: ${state.message}`} />
            <Pressable
              accessibilityRole="button"
              onPress={access.reload}
              className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : (
          <View className="items-center py-2">
            <ActivityIndicator accessibilityLabel="Reading access" colorClassName="accent-icon-muted" />
          </View>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
