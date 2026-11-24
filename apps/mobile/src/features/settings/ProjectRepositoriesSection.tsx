import {
  appendTrackedFolders,
  suggestedTrackedFolders,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { PROJECT_TRACKED_FOLDERS_MAX, type ProjectTrackedFolder } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { codebaseFolders } from "../../solus/codebase-folders";
import { codebaseFolderRowKey, type CodebaseFolderRow } from "../../solus/codebase-rows";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/**
 * The folders of one Solus codebase, in one section: the folders on the environment that
 * `member` names, then the folders on each other environment of the codebase, each with the name
 * of its environment below it.
 */
export function ProjectRepositoriesSection(props: {
  readonly member: Pick<EnvironmentProject, "environmentId" | "trackedFolders">;
  readonly codebaseId: string;
  readonly title: string;
  /** In the heading of the section, for example the menu of the codebase. */
  readonly trailing?: ReactNode;
  /** Rows after the folders, for example an action that adds a folder. */
  readonly children?: ReactNode;
}) {
  const { member, codebaseId } = props;
  const gt = useGT();
  const tracked = member.trackedFolders ?? [];
  const canEdit = useAtomValue(codebaseFolders.update.permissionAtom(member.environmentId));
  // The record and the members of a codebase need the same permission.
  const canReadFiles = canEdit;
  // Read from disk: the record holds the roots only.
  const listQuery = useEnvironmentQuery(
    canReadFiles
      ? codebaseFolders.listFolders({
          environmentId: member.environmentId,
          input: { codebaseId },
        })
      : null,
  );
  const folders: ReadonlyArray<CodebaseFolderRow> = listQuery.data?.folders ?? tracked;
  // A folder on a different environment is not a path of this one.
  const onMember = folders.filter((folder) => folder.otherHost === undefined);
  // Only a workspace file's folders are offered: the rest is found without asking.
  const scanQuery = useEnvironmentQuery(
    canReadFiles
      ? codebaseFolders.scanFolders({
          environmentId: member.environmentId,
          input: { codebaseId },
        })
      : null,
  );
  const suggested = suggestedTrackedFolders(onMember, scanQuery.data?.folders ?? []);
  const updateProject = useAtomCommand(codebaseFolders.update, { reportFailure: false });
  const [isSaving, setIsSaving] = useState(false);
  // A save builds on the listed folders, so it waits for the list that follows the last one.
  const isBusy = isSaving || listQuery.isPending;
  const added = onMember.filter((folder) => folder.discovered !== true);

  // One folder in or out: the server applies it to its own list, which another client may have
  // changed while a confirmation was open here.
  const save = async (
    change: { readonly track: ProjectTrackedFolder } | { readonly untrack: CodebaseFolderRow },
  ) => {
    setIsSaving(true);
    const result = await updateProject({
      environmentId: member.environmentId,
      input: {
        codebaseId,
        ...("track" in change
          ? { trackFolders: [{ path: change.track.path, name: change.track.name }] }
          : {
              untrackFolders: [{ path: change.untrack.path, otherHost: change.untrack.otherHost }],
            }),
      },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Failed to update repositories"),
          error instanceof Error ? error.message : gt("An error occurred."),
        );
      }
      return;
    }
    listQuery.refresh();
  };

  const remove = (folder: CodebaseFolderRow) =>
    Dialog.confirm({
      title: gt("Remove folder"),
      message: gt(
        "A new session in this codebase does not work in {name}. No file on the disk is deleted.",
        { name: folder.name },
      ),
      confirmText: gt("Remove", { $context: "verb, removes a folder from the codebase" }),
      destructive: true,
      onConfirm: () => void save({ untrack: folder }),
    });

  const add = (folder: ProjectTrackedFolder) => {
    const next = appendTrackedFolders(added, [folder]);
    if (next === null) {
      Dialog.alert(
        gt("Too many folders"),
        gt("A codebase has at most {max} folders.", { max: PROJECT_TRACKED_FOLDERS_MAX }),
      );
      return;
    }
    void save({ track: folder });
  };

  return (
    <SettingsSection title={props.title} trailing={props.trailing}>
      {folders.map((folder) => (
        <ListRowLayout
          key={codebaseFolderRowKey(folder)}
          icon="folder"
          label={folder.name}
          description={
            folder.otherHost ? (folder.otherHost.label ?? gt("Unknown host")) : folder.path
          }
          detail={
            folder.state === "missing"
              ? gt("Missing", { $context: "folder state: not found on disk" })
              : undefined
          }
          accessory={
            // A repository inside the project folder is there for as long as it is on disk.
            folder.discovered === true ? undefined : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Remove {name} from the codebase", { name: folder.name })}
                disabled={!canEdit || isBusy}
                onPress={() => remove(folder)}
                className="rounded-full border border-border bg-card px-3 py-1.5 disabled:opacity-40"
              >
                <Text className="font-t3-medium text-xs text-danger-foreground">
                  <T context="verb, removes a folder from the codebase">Remove</T>
                </Text>
              </Pressable>
            )
          }
        />
      ))}
      {suggested.map((folder) => (
        <ListActionRow
          key={folder.path}
          icon="plus"
          label={gt("Add {name}", { name: folder.name })}
          description={folder.path}
          disabled={!canEdit || isBusy}
          onPress={() => add(folder)}
        />
      ))}
      {props.children}
    </SettingsSection>
  );
}
