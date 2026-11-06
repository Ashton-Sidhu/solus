import { HOST_BALANCE_LABELS, hostBalancePreference, withHostBalancePreference } from "@solus/client-core/host-balance";
import { HOST_BALANCE_PREFERENCES, type HostBalancePreference } from "@solus/contracts/settings";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import type { NativeHost } from "./host-registry";

/**
 * Auto balance, as Settings → Hosts has it on desktop and web. The choices are
 * personal, so they apply on each client (docs/plans/resource-telemetry.md D5).
 */
export function HostBalancingScreen(_props: ScreenProps<"HostBalancing">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const balancing = useListened(app.personal.changes, () => app.personal.current().hostBalancing);
  const setPreference = (host: NativeHost, preference: HostBalancePreference) => {
    // A host's id on this client is its installation id, so desktop and web read the same key.
    app.personal.set({ hostBalancing: withHostBalancePreference(balancing, host, preference) });
  };

  return (
    <SettingsScreen title="Auto balance">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <SettingsSection title="New sessions">
            <SettingsSwitchRow
              icon="scalemass"
              label="Balance new sessions"
              value={balancing.enabled}
              onValueChange={(enabled) => app.personal.set({ hostBalancing: { ...balancing, enabled } })}
            />
          </SettingsSection>
          <SettingsNote>
            A new session chooses among the hosts that hold its project, from their CPU and memory.
            Choosing a host overrides it. Existing sessions stay where they started.
          </SettingsNote>
        </View>
        {balancing.enabled
          ? hosts.map((host) => (
              <SettingsSection key={host.id} title={host.label}>
                {HOST_BALANCE_PREFERENCES.map((preference, index) => (
                  <SettingsChoiceRow
                    key={preference}
                    separated={index > 0}
                    label={HOST_BALANCE_LABELS[preference]}
                    selected={hostBalancePreference(balancing, host) === preference}
                    onPress={() => setPreference(host, preference)}
                  />
                ))}
              </SettingsSection>
            ))
          : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
