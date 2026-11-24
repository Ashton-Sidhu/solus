import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useListened } from "@solus-mobile/app/app-context";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoriesFoundIn } from "@solus/client-core/codebases";
import type { Codebase } from "@solus/contracts/codebases";
import { relativeHostPath } from "@solus/contracts/host-path";
import { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Fragment, useEffect, useState } from "react";

import { AppText as Text } from "../components/ui/AppText";
import * as Dialog from "../components/ui/Dialog";
import { ListActionRow } from "../components/ui/ListActionRow";
import { ListRowLayout } from "../components/ui/ListRowLayout";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import {
  FOLDER_STATE_LABELS,
  ProjectRepositoriesSection,
} from "../features/settings/ProjectRepositoriesSection";
import { codebaseFolders, readProjectCodebases } from "./codebase-folders";
import type { CodebaseOtherHost, ProjectCodebaseSection } from "./codebase-rows";
import { solus } from "./runtime";

/** One command of the codebases model: a save answers the saved copy, and a delete answers nothing. */
type CodebaseChange = () => Promise<Codebase | void>;

/**
 * The repositories and the codebases of one project in the project overview
 * (docs/plans/codebases.md §10). A Solus project is one folder on one host,
 * and it covers the repositories inside it with no codebase: they show in one
 * Repositories section, as a project and its found repositories do in T3
 * Code. A codebase is a named set of two or more folders that can hold the
 * project. Each codebase that holds the folder gets T3's repositories section
 * for the host of the project, then one section for each other host of the
 * codebase. A project in no codebase gets one action that makes a codebase
 * with a second folder.
 */
export function ProjectCodebases(props: {
  readonly project: Pick<EnvironmentProject, "environmentId" | "title" | "workspaceRoot">;
  /** The name of the project's host, when the page shows the project on more than one host. */
  readonly hostLabel?: string;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { environmentId, workspaceRoot } = props.project;
  useEffect(() => solus.codebases.watch(), []);
  const { status, sections } = useListened(solus.codebases.changes, () =>
    readProjectCodebases(environmentId, workspaceRoot),
  );
  const canEdit = useAtomValue(codebaseFolders.update.permissionAtom(environmentId));
  const [isBusy, setIsBusy] = useState(false);
  // A promise chain, not `try` with `finally`: the React Compiler does not compile that statement.
  const run = (failureTitle: string, change: CodebaseChange) => {
    setIsBusy(true);
    return change()
      .then(
        () => undefined,
        (error) =>
          Dialog.alert(
            failureTitle,
            error instanceof Error ? error.message : gt("An error occurred."),
          ),
      )
      .then(() => setIsBusy(false));
  };

  const projectRepositories = (
    <ProjectRepositories environmentId={environmentId} workspaceRoot={workspaceRoot} />
  );
  if (sections.length > 0) {
    return (
      <>
        {projectRepositories}
        {sections.map((section) => (
          <CodebaseSections
            key={section.codebase.id}
            section={section}
            environmentId={environmentId}
            hostLabel={props.hostLabel}
            disabled={!canEdit || isBusy}
            run={run}
          />
        ))}
      </>
    );
  }
  // A list that is not read yet does not show that the project is in no codebase.
  if (status !== "ready") {
    return status === "unavailable" ? (
      <SettingsSection
        title={gt("Codebase")}
        footer={gt("This host did not give its codebases. Update Solus on the host.")}
      >
        {null}
      </SettingsSection>
    ) : null;
  }
  return (
    <>
      {projectRepositories}
      <SettingsSection
        title={gt("Codebase")}
        footer={gt(
          "A codebase is a named set of two or more folders that one piece of work covers. The folders can be on more than one host. This project works in the repositories inside its folder with no codebase.",
        )}
      >
        <ListActionRow
          icon="plus"
          label={gt("Make a codebase")}
          description={gt("Choose a second folder. The folder of this project is the first one.")}
          disabled={!canEdit || isBusy}
          onPress={() =>
            navigation.navigate("AddProjectLocal", { environmentId, codebaseWith: workspaceRoot })
          }
        />
      </SettingsSection>
    </>
  );
}

/**
 * The repositories that the host found inside the folder of a project. The
 * project covers them with no codebase (docs/plans/codebases.md decision 14),
 * so the section has no Add and no Remove: a repository is there for as long
 * as it is on the disk. A project that holds no repository has no section.
 */
function ProjectRepositories(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, workspaceRoot } = props;
  useEffect(() => {
    void solus.codebases.readFolder(environmentId, workspaceRoot);
  }, [environmentId, workspaceRoot]);
  const scan = useListened(solus.codebases.changes, () =>
    solus.codebases.projectScanAt(environmentId, workspaceRoot),
  );
  const found = scan ? repositoriesFoundIn(scan) : [];
  if (found.length === 0) return null;
  return (
    <SettingsSection
      title={gt("Repositories")}
      footer={gt(
        "Repositories inside the folder of this project are part of it as soon as they are there. A session of the project works in each one.",
      )}
    >
      {found.map((repository) => (
        <ListRowLayout
          key={repository.path}
          icon="folder"
          label={repository.name}
          description={relativeHostPath(workspaceRoot, repository.path) || repository.path}
          meta={
            <Text textRole="footnote" className="text-foreground-muted">
              {m(FOLDER_STATE_LABELS[repository.state])}
            </Text>
          }
        />
      ))}
    </SettingsSection>
  );
}

function CodebaseSections(props: {
  readonly section: ProjectCodebaseSection;
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string | undefined;
  readonly disabled: boolean;
  readonly run: (failureTitle: string, change: CodebaseChange) => Promise<void>;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { codebase, otherHosts } = props.section;
  const titleOn = (hostLabel: string) =>
    gt("{codebase} · {host}", { codebase: codebase.name, host: hostLabel });
  const addFolder = (environmentId: EnvironmentId) => (
    <ListActionRow
      icon="plus"
      label={gt("Add folder")}
      description={gt("Add a folder on this host to the codebase.")}
      disabled={props.disabled}
      onPress={() => navigation.navigate("AddProjectLocal", { environmentId, codebaseId: codebase.id })}
    />
  );
  return (
    <>
      <ProjectRepositoriesSection
        member={{ environmentId: props.environmentId }}
        codebaseId={codebase.id}
        title={props.hostLabel ? titleOn(props.hostLabel) : codebase.name}
      >
        {addFolder(props.environmentId)}
      </ProjectRepositoriesSection>
      {otherHosts.map((host) => (
        <Fragment key={host.installationId}>
          {host.hostId !== null && host.presence === "ready" ? (
            <ProjectRepositoriesSection
              member={{ environmentId: EnvironmentId.make(host.hostId) }}
              codebaseId={codebase.id}
              title={titleOn(host.label ?? host.hostId)}
            >
              {addFolder(EnvironmentId.make(host.hostId))}
            </ProjectRepositoriesSection>
          ) : (
            <OtherHostFolders host={host} title={titleOn(host.label ?? gt("Unknown host"))} />
          )}
        </Fragment>
      ))}
      <SettingsSection>
        <ListActionRow
          icon="pencil"
          label={gt("Rename codebase")}
          description={codebase.name}
          disabled={props.disabled}
          onPress={() =>
            Dialog.prompt({
              title: gt("Rename codebase"),
              initialValue: codebase.name,
              confirmText: gt("Rename", { $context: "verb, renames a codebase" }),
              onConfirm: (name) =>
                void props.run(gt("Failed to rename the codebase"), () =>
                  solus.codebases.rename(codebase.id, name),
                ),
            })
          }
        />
        <ListActionRow
          icon="trash"
          tone="danger"
          label={gt("Delete codebase")}
          description={gt("Deletes the codebase on each host. No file is deleted.")}
          disabled={props.disabled}
          onPress={() =>
            Dialog.confirm({
              title: gt("Delete codebase"),
              message: gt(
                "{codebase} is deleted on each host. Its folders and their files stay on the disk. No file is deleted.",
                { codebase: codebase.name },
              ),
              confirmText: gt("Delete", { $context: "verb, deletes a codebase" }),
              destructive: true,
              onConfirm: () =>
                void props.run(gt("Failed to delete the codebase"), () =>
                  solus.codebases.delete(codebase.id),
                ),
            })
          }
        />
      </SettingsSection>
    </>
  );
}

/** The roots of a codebase on a host that this phone cannot change now: the host is away, or this phone does not know it. */
function OtherHostFolders(props: { readonly host: CodebaseOtherHost; readonly title: string }) {
  const gt = useGT();
  const m = useMessages();
  const { host } = props;
  return (
    <SettingsSection
      title={props.title}
      footer={
        host.presence === "unknown"
          ? gt("This phone does not know this host. Its folders stay in the codebase.")
          : host.isStale
            ? gt("This host is not connected. The folder states are its last answer.")
            : gt("This host is not connected. Connect it to change its folders.")
      }
    >
      {host.folders.map((folder) => (
        <ListRowLayout
          key={folder.path}
          icon="folder"
          label={folder.name}
          description={folder.path}
          meta={
            folder.state === undefined ? undefined : (
              <Text
                textRole="footnote"
                className={
                  folder.state === "missing" ? "text-warning-foreground" : "text-foreground-muted"
                }
              >
                {m(FOLDER_STATE_LABELS[folder.state])}
              </Text>
            )
          }
        />
      ))}
    </SettingsSection>
  );
}
