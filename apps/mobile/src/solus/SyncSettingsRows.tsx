import { useGT } from "gt-react-native";
import { useSyncExternalStore } from "react";
import { View } from "react-native";

import { ListToggleRow } from "../components/ui/ListToggleRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { solus } from "./runtime";

/**
 * Sync settings on the phone (docs/plans/settings-sync-hosts.md). Signed in, the
 * account keeps every host the same, so neither row shows.
 */

const subscribe = (listener: () => void) => {
  const stops = [solus.settingsSync.changes.subscribe(listener), solus.personal.changes.subscribe(listener)];
  return () => {
    for (const stop of stops) stop();
  };
};

const isShown = () => solus.settingsSync.isShown;

/** The checkbox of the pairing form: on, the new host takes this person's server settings. */
export function SyncSettingsChoice(props: {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const shown = useSyncExternalStore(subscribe, isShown);
  if (!shown) return null;
  return (
    <View
      collapsable={false}
      className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card"
    >
      <ListToggleRow
        label={gt("Sync settings")}
        description={gt("Copy your settings to this host, and keep them the same on your hosts.")}
        disabled={props.disabled}
        value={props.value}
        onValueChange={props.onValueChange}
      />
    </View>
  );
}

/** The switch of one host, on its environment page. */
export function HostSyncSettingsSection(props: { readonly hostId: string }) {
  const gt = useGT();
  const shown = useSyncExternalStore(subscribe, isShown);
  const value = useSyncExternalStore(subscribe, () => solus.settingsSync.switchOf(props.hostId));
  const saving = useSyncExternalStore(subscribe, () => solus.settingsSync.isSaving(props.hostId));
  if (!shown) return null;
  return (
    <SettingsSection title={gt("Settings")}>
      <ListToggleRow
        label={gt("Sync settings")}
        description={
          value === null
            ? gt("Connect to this host to change it.")
            : value
              ? gt("On · a change to your settings on a synced host also goes to this host.")
              : gt("Off · this host keeps its own settings.")
        }
        disabled={value === null || saving}
        value={value ?? true}
        onValueChange={(next) => {
          void solus.settingsSync.setSwitch(props.hostId, next).catch(() => {});
        }}
      />
    </SettingsSection>
  );
}
