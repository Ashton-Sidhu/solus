import { View } from "react-native";

import { shortCommit } from "@solus/client-core/app-versions";

import { ListRowLayout } from "../../../components/ListRowLayout";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { CopyPill } from "../app-rows";
import type { AppSectionProps } from "./section-props";

/**
 * Source (docs/plans/apps.md §9.2): the slug, the repository on the host,
 * and the newest revision. Delete is at the bottom of the Overview.
 */
export function SourceSection({ state }: AppSectionProps) {
  const { app: summary, repositoryPath } = state;

  return (
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
  );
}
