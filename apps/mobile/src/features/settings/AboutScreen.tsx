// Adapted from T3 Code apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../components/EnvironmentMachineSymbol";
import type { ScreenProps } from "../../navigation/routes";
import { hostMachineKind } from "../connection/lib/host-connection-status";
import type { NativeHost } from "../hosts/host-registry";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { updateStatusText } from "./lib/update-status";
import { useHostUpdateStatus } from "./use-host-update-status";

/** This build, each host's Solus version, and the notices the app carries. */
export function AboutScreen(_props: ScreenProps<"About">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const hosts = useListened(app.registry.changes, app.registry.hosts);

  return (
    <SettingsScreen title="About Solus">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="App">
          <SettingsRow
            icon="doc.on.doc"
            label="Open source notices"
            onPress={() => Alert.alert("T3 Code", T3_CODE_NOTICE)}
          />
          <SettingsValueRow
            icon="info.circle"
            label="Version"
            value={app.platform.appVersion ?? "Unknown"}
          />
        </SettingsSection>
        {hosts.length > 0 ? (
          <View className="gap-3">
            <SettingsSection title="Hosts">
              {hosts.map((host) => (
                <HostVersionRow key={host.id} host={host} />
              ))}
            </SettingsSection>
            <SettingsNote>
              Update a host where Solus runs on it. A cloud host is updated for you.
            </SettingsNote>
          </View>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}

/** One host's version and what its last update check found. */
function HostVersionRow({ host }: { readonly host: NativeHost }) {
  const { version, status } = useHostUpdateStatus(host.id);
  return (
    <SettingsValueRow
      icon={ENVIRONMENT_MACHINE_SYMBOLS[hostMachineKind(host)]}
      label={host.label}
      value={version}
      detail={status ? updateStatusText(status) : undefined}
    />
  );
}

/** The notice the T3 Code license requires with the adapted pieces (UPSTREAM.md). */
const T3_CODE_NOTICE = `Parts of this app adapt T3 Code's mobile app.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
