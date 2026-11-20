import { settingsDefinitions } from "@solus/client-core/settings-definitions";
import { useState } from "react";
import { Alert, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { Button, Field } from "../../ui/primitives";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { linearConnectionValue, useLinearConnection } from "./use-linear-connection";

/**
 * Connect, replace, or disconnect the person's Linear key. Signed out, the
 * host keeps it; signed in, the Solus account keeps it for every host.
 */
export function LinearConnectionScreen({ route }: ScreenProps<"LinearConnection">) {
  const { hostId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { state, store } = useLinearConnection(hostId);
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  // Saving a key on the host needs `host.admin.connections`, as the host checks.
  const mayManageHost = useListened(app.connections.changes, () =>
    app.connections.may(hostId, "host.admin.connections"),
  );
  const canManage = state.location === "account" || (state.location === "host" && mayManageHost);
  const label = settingsDefinitions["integrations.linear"].label;

  const save = async () => {
    const draft = key;
    setKey("");
    if (await store.save(draft)) setReplacing(false);
  };
  const confirmDisconnect = () =>
    Alert.alert("Disconnect Linear?", "Tasks stop reading Linear teams until a key is saved again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => void store.disconnect() },
    ]);

  return (
    <SettingsScreen title={label}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={state.loading} onRefresh={() => void store.load()} />}
      >
        <View className="gap-3">
          <SettingsSection title={label}>
            <SettingsValueRow
              icon={state.connected ? "person.crop.circle" : "info.circle"}
              label="Status"
              value={linearConnectionValue(state)}
            />
            {state.connected && canManage ? (
              <>
                <SettingsActionRow icon="arrow.clockwise" label="Replace key" disabled={state.pending} onPress={() => setReplacing(!replacing)} />
                <SettingsActionRow icon="link" label="Disconnect" tone="danger" disabled={state.pending} onPress={confirmDisconnect} />
              </>
            ) : null}
          </SettingsSection>
          {canManage && (!state.connected || replacing) ? (
            <View className="gap-2">
              <Field
                label="API key"
                placeholder="Paste your Linear API key"
                value={key}
                onChangeText={setKey}
                secureTextEntry
                textContentType="password"
                editable={!state.pending}
                returnKeyType="done"
                onSubmitEditing={() => void save()}
              />
              <Button tone="primary" label="Connect" busy={state.pending} disabled={!key.trim()} onPress={() => void save()} />
            </View>
          ) : null}
          {state.error ? <SettingsNote tone="danger">{state.error}</SettingsNote> : null}
          {state.location === "host" && !mayManageHost ? (
            <SettingsNote>Only a host administrator can change this host's Linear key.</SettingsNote>
          ) : null}
          <SettingsNote>
            {`${state.location === "account"
              ? "Your Linear key is in your Solus account. Every host you use reads it from there."
              : "The host keeps the key. When you sign in to Solus, it moves to your account."} Create a personal API key in Linear Settings › Security & access.`}
          </SettingsNote>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
