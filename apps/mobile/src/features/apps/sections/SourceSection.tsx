import { StackActions } from "@react-navigation/native";
import { Alert, View } from "react-native";

import { ListRowLayout } from "../../../components/ListRowLayout";
import { SettingsActionRow } from "../../settings/components/SettingsActionRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { CopyPill } from "../app-rows";
import { appRoutesOnTop } from "../app-sections";
import { deleteConfirmation, shortCommit } from "../apps";
import { useAppChange } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Source (docs/plans/apps.md §9.2): the slug, the repository on the host,
 * the newest revision, and Delete. A delete leaves every screen of the app.
 */
export function SourceSection({ hostId, appId, state, connected, navigation }: AppSectionProps) {
  const { app: summary, repositoryPath } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;

  const deleteApp = () => {
    const { title, message } = deleteConfirmation(summary.name);
    const run = () => {
      change("delete", (api) => api.appDelete({ appId })).then(
        (deleted) => {
          if (!deleted) {
            Alert.alert("Not deleted", "The host did not delete the app.");
            return;
          }
          // Every screen of the app on the stack shows an app that is gone.
          const stack = navigation.getState();
          navigation.dispatch(StackActions.pop(appRoutesOnTop(stack.routes, stack.index)));
        },
        (cause: unknown) => Alert.alert("Not deleted", errorMessage(cause)),
      );
    };
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: run },
    ]);
  };

  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Source">
          <ListRowLayout label="Slug" description={summary.slug} />
          <ListRowLayout label="Repository on the host" description={repositoryPath} />
          <ListRowLayout
            label="Newest revision"
            description={summary.hasUndeployedRevision ? "It waits for a deploy." : undefined}
            detail={summary.latestRevision === null ? "None" : shortCommit(summary.latestRevision)}
          />
        </SettingsSection>
        <View className="flex-row flex-wrap gap-2 px-2">
          <CopyPill label="Copy slug" target="slug" value={summary.slug} />
          <CopyPill label="Copy repository path" target="repository path" value={repositoryPath} />
          {summary.latestRevision !== null ? <CopyPill label="Copy revision" target="revision" value={summary.latestRevision} /> : null}
        </View>
        <SettingsNote>An agent changes the source: it saves a revision, and a deploy makes a version from it.</SettingsNote>
      </View>
      <SettingsSection title="Delete">
        <SettingsActionRow icon="trash" label="Delete app" tone="danger" disabled={disabled} loading={busy === "delete"} onPress={deleteApp} />
      </SettingsSection>
    </>
  );
}
