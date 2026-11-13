import { useCallback } from "react";
import { Alert, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppRevisionView, AppVersionView } from "@solus/contracts/apps";

import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow, ReadBody } from "../app-rows";
import { appTimeline, canDeploy, revisionLines, timelineKey } from "../app-timeline";
import { canMakeActive, makeActiveConfirmation, shortCommit, SOURCE_CHANGE_NOTE, versionLines, versionStateLabel } from "../apps";
import { useAppChange, useAppDeploy, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Versions (docs/plans/apps.md §9.2): the revisions and the versions of the
 * app in one timeline. The owner deploys a revision, makes an earlier version
 * active, and opens the build log of a version. A deploy answers only when
 * the build ended: the screen stays free, and the host says when the version
 * starts to build and when it ends.
 */
export function VersionsSection({ hostId, appId, connected, reloadState, navigation }: AppSectionProps) {
  const readRevisions = useCallback((api: HostApi) => api.appRevisions({ appId }), [appId]);
  const readVersions = useCallback((api: HostApi) => api.appVersions({ appId }), [appId]);
  const revisions = useAppRead(hostId, appId, "revisions", readRevisions);
  const versions = useAppRead(hostId, appId, "versions", readVersions);
  const { busy, change } = useAppChange(hostId);
  const { deploying, deploy } = useAppDeploy(hostId, appId);
  const disabled = busy !== null || !connected;
  const reloadVersions = versions.reload;
  const reloadRevisions = revisions.reload;
  const now = Date.now();

  const reloadAll = () => {
    reloadState();
    reloadVersions();
    reloadRevisions();
  };

  const startDeploy = (revision: AppRevisionView) => {
    deploy(revision.commit).then(
      (receipt) => {
        reloadAll();
        if (!receipt.active) Alert.alert(`Version ${receipt.version} is not active`, receipt.error ?? "The build or the start failed. The version before it still runs.");
      },
      (cause: unknown) => Alert.alert("Not deployed", errorMessage(cause)),
    );
  };

  const confirmDeploy = (revision: AppRevisionView) => {
    Alert.alert(
      `Deploy revision ${shortCommit(revision.commit)}?`,
      "The host builds this revision. When the build succeeds, the new version is active, and its new migrations change the app's data.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Deploy", onPress: () => startDeploy(revision) },
      ],
    );
  };

  const makeActive = (version: AppVersionView) => {
    const { title, message } = makeActiveConfirmation(version.number);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Make active",
        onPress: () => {
          change("activate", (api) => api.appActivate({ appId, version: version.number })).then(reloadAll, (cause: unknown) =>
            Alert.alert("Not made active", errorMessage(cause)),
          );
        },
      },
    ]);
  };

  return (
    <ReadBody read={revisions.state} connected={connected} subject="The revisions" onRetry={revisions.reload}>
      {(savedRevisions) => (
        <ReadBody read={versions.state} connected={connected} subject="The versions" onRetry={versions.reload}>
          {(builtVersions) => {
            const timeline = appTimeline(savedRevisions, builtVersions);
            return (
              <View className="gap-3">
                {deploying !== null ? <SettingsNote>The host builds a revision now. You can leave this screen: the build continues.</SettingsNote> : null}
                <SettingsSection title="Timeline">
                  {timeline.length === 0 ? (
                    <View className="px-2 py-4">
                      <SettingsNote>No save yet.</SettingsNote>
                    </View>
                  ) : (
                    timeline.map((item, index) =>
                      item.kind === "version" ? (
                        <AppDetailRow
                          key={timelineKey(item)}
                          first={index === 0}
                          title={`v${item.version.number}`}
                          trailing={versionStateLabel(item.version.state)}
                          trailingTone={item.version.state === "failed" ? "danger" : "muted"}
                          lines={versionLines(item.version, now)}
                        >
                          {canMakeActive(item.version) ? (
                            <PillButton label="Make active" disabled={disabled} onPress={() => makeActive(item.version)} />
                          ) : null}
                          <PillButton
                            label="Build log"
                            onPress={() => navigation.navigate("AppBuildLog", { hostId, appId, version: item.version.number })}
                          />
                        </AppDetailRow>
                      ) : (
                        <AppDetailRow
                          key={timelineKey(item)}
                          first={index === 0}
                          title={item.revision.message || "No message"}
                          trailing={shortCommit(item.revision.commit)}
                          lines={revisionLines(item.revision, item.isNewest, now)}
                        >
                          {canDeploy(item.revision, builtVersions) ? (
                            <PillButton
                              label={deploying === item.revision.commit ? "Deploying" : "Deploy"}
                              disabled={!connected || deploying !== null}
                              onPress={() => confirmDeploy(item.revision)}
                            />
                          ) : null}
                        </AppDetailRow>
                      ),
                    )
                  )}
                </SettingsSection>
                <SettingsNote>{SOURCE_CHANGE_NOTE}</SettingsNote>
              </View>
            );
          }}
        </ReadBody>
      )}
    </ReadBody>
  );
}
