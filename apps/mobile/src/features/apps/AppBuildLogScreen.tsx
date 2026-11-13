import { useCallback } from "react";
import { View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";

import { ListRowLayout } from "../../components/ListRowLayout";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { AppPage, MonoBlock, ReadBody } from "./app-rows";
import { durationText } from "./apps";
import { useAppRead } from "./use-app";

/**
 * The build log of one version (docs/plans/apps.md §1): the text of the
 * host's build of its revision. It is read again when the app changes, so a
 * build in progress shows its end.
 */
export function AppBuildLogScreen({ route }: ScreenProps<"AppBuildLog">) {
  const { hostId, appId, version } = route.params;
  const readLog = useCallback((api: HostApi) => api.appBuildLog({ appId, version }), [appId, version]);
  const log = useAppRead(hostId, appId, "buildLog", readLog);

  return (
    <AppPage title={`Build of v${version}`} hostId={hostId}>
      <ReadBody read={log.state} connected={log.connected} subject="The build log" onRetry={log.reload}>
        {(build) => (
          <>
            <SettingsSection title="Build">
              <ListRowLayout label="Version" detail={`v${build.version}`} />
              <ListRowLayout label="Time" detail={build.buildMs === null ? "Not known" : durationText(build.buildMs)} />
            </SettingsSection>
            <SettingsSection title="Log">
              <View className="p-4">
                {build.log === "" ? <SettingsNote>The build wrote no text.</SettingsNote> : <MonoBlock text={build.log} />}
              </View>
            </SettingsSection>
          </>
        )}
      </ReadBody>
    </AppPage>
  );
}
