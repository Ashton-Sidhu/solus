import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useListened } from "@solus-mobile/app/app-context";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { Codebase } from "@solus/contracts/codebases";
import {
  CODEBASE_COLORS,
  codebaseColorSchema,
  codebaseIconText,
  parseCodebaseIcon,
  type CodebaseColor,
} from "@solus/contracts/codebase-badge";
import { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { ControlPill } from "../components/ui/ControlPill";
import * as Dialog from "../components/ui/Dialog";
import { ListActionRow } from "../components/ui/ListActionRow";
import { Menu } from "../components/ui/Menu";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { ProjectRepositoriesSection } from "../features/settings/ProjectRepositoriesSection";
import { codebaseFolders, readProjectPageCodebases } from "./codebase-folders";
import type { ProjectPageCodebases } from "./codebase-rows";
import { solus } from "./runtime";

/**
 * The codebases of one project on the project page (docs/plans/codebases.md
 * §10). A project is one folder on one host. Each codebase that holds a
 * checkout of the project gets one section: T3's repositories section, with
 * the folders on each host of the codebase. A checkout in no codebase gets
 * one action that makes a codebase with a second folder.
 */
export function ProjectCodebases(props: {
  readonly projects: readonly Pick<EnvironmentProject, "environmentId" | "workspaceRoot">[];
}) {
  const gt = useGT();
  const page = useListened(solus.codebases.changes, () =>
    readProjectPageCodebases(
      props.projects.map((project) => ({
        hostId: project.environmentId,
        path: project.workspaceRoot,
      })),
    ),
  );
  return (
    <>
      {page.sections.map(({ codebase, hostId }) => (
        <CodebaseSection
          key={codebase.id}
          codebase={codebase}
          environmentId={EnvironmentId.make(hostId)}
          hosts={page.readyHosts}
        />
      ))}
      {page.loose.length > 0 ? (
        <SettingsSection title={gt("Codebase")}>
          {page.loose.map((checkout) => (
            <MakeCodebaseRow
              key={`${checkout.hostId}\n${checkout.path}`}
              environmentId={EnvironmentId.make(checkout.hostId)}
              path={checkout.path}
              // More than one checkout: the row names its host.
              hostLabel={props.projects.length > 1 ? checkout.hostLabel : undefined}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function MakeCodebaseRow(props: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly hostLabel: string | undefined;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const canEdit = useAtomValue(codebaseFolders.update.permissionAtom(props.environmentId));
  return (
    <ListActionRow
      icon="plus"
      label={gt("Make a codebase")}
      description={props.hostLabel}
      disabled={!canEdit}
      onPress={() =>
        navigation.navigate("AddProjectLocal", {
          environmentId: props.environmentId,
          codebaseWith: props.path,
        })
      }
    />
  );
}

/** One codebase: its folders on each host, "Add folder", and its menu (Rename, Delete) in the heading. */
function CodebaseSection(props: {
  readonly codebase: Codebase;
  readonly environmentId: EnvironmentId;
  readonly hosts: ProjectPageCodebases["readyHosts"];
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { codebase, environmentId, hosts } = props;
  const canEdit = useAtomValue(codebaseFolders.update.permissionAtom(environmentId));
  const [isBusy, setIsBusy] = useState(false);
  const disabled = !canEdit || isBusy;
  // A promise chain, not `try` with `finally`: the React Compiler does not compile that statement.
  const run = (failureTitle: string, change: () => Promise<Codebase | void>) => {
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
  const rename = () =>
    Dialog.prompt({
      title: gt("Rename codebase"),
      initialValue: codebase.name,
      confirmText: gt("Rename", { $context: "verb, renames a codebase" }),
      onConfirm: (name) =>
        void run(gt("Failed to rename the codebase"), () =>
          solus.codebases.rename(codebase.id, name),
        ),
    });
  // The badge marks each session of the codebase in the session list (docs/plans/codebases.md §9, "Badge").
  const changeIcon = () =>
    Dialog.prompt({
      title: gt("Codebase icon"),
      message: gt("One or two letters, or one emoji. Leave it empty to use the initials of the name."),
      initialValue: codebaseIconText(codebase.badge?.icon),
      confirmText: gt("Save"),
      onConfirm: (text) => {
        const icon = parseCodebaseIcon(text);
        if (icon === "invalid") {
          Dialog.alert(gt("Failed to change the icon"), gt("Type one or two letters, or one emoji."));
          return;
        }
        void run(gt("Failed to change the icon"), () => solus.codebases.setBadge(codebase.id, { icon }));
      },
    });
  const changeColor = (color: CodebaseColor | null) =>
    void run(gt("Failed to change the colour"), () => solus.codebases.setBadge(codebase.id, { color }));
  const colorTitles = {
    gray: gt("Gray"),
    red: gt("Red"),
    orange: gt("Orange"),
    amber: gt("Amber"),
    yellow: gt("Yellow"),
    lime: gt("Lime"),
    green: gt("Green"),
    emerald: gt("Emerald"),
    teal: gt("Teal"),
    cyan: gt("Cyan"),
    sky: gt("Sky"),
    blue: gt("Blue"),
    indigo: gt("Indigo"),
    violet: gt("Violet"),
    purple: gt("Purple"),
    fuchsia: gt("Fuchsia"),
    pink: gt("Pink"),
    rose: gt("Rose"),
  } satisfies Record<CodebaseColor, string>;
  const remove = () =>
    Dialog.confirm({
      title: gt("Delete {codebase}?", { codebase: codebase.name }),
      message: gt("Its folders and their files stay on the disk."),
      confirmText: gt("Delete", { $context: "verb, deletes a codebase" }),
      destructive: true,
      onConfirm: () =>
        void run(gt("Failed to delete the codebase"), () => solus.codebases.delete(codebase.id)),
    });
  const addFolderOn = (hostId: string) =>
    navigation.navigate("AddProjectLocal", {
      environmentId: EnvironmentId.make(hostId),
      codebaseId: codebase.id,
    });
  const optionsLabel = gt("{codebase} options", { codebase: codebase.name });
  return (
    <ProjectRepositoriesSection
      member={{ environmentId }}
      codebaseId={codebase.id}
      title={codebase.name}
      trailing={
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={optionsLabel}
          title={codebase.name}
          actions={[
            {
              id: "rename",
              title: gt("Rename", { $context: "verb, renames a codebase" }),
              image: "pencil",
              attributes: { disabled },
            },
            {
              id: "icon",
              title: gt("Icon"),
              image: "face.smiling",
              attributes: { disabled },
            },
            {
              id: "color",
              title: gt("Colour"),
              image: "paintbrush",
              attributes: { disabled },
              subactions: [
                {
                  id: "color:automatic",
                  title: gt("Automatic"),
                  state: codebase.badge?.color ? "off" : "on",
                },
                ...CODEBASE_COLORS.map((color) => ({
                  id: `color:${color}`,
                  title: colorTitles[color],
                  state: codebase.badge?.color === color ? ("on" as const) : ("off" as const),
                })),
              ],
            },
            {
              id: "delete",
              title: gt("Delete", { $context: "verb, deletes a codebase" }),
              image: "trash",
              attributes: { destructive: true, disabled },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            const event = nativeEvent.event;
            if (event === "rename") rename();
            else if (event === "icon") changeIcon();
            else if (event === "color:automatic") changeColor(null);
            else if (event.startsWith("color:")) {
              const color = codebaseColorSchema.safeParse(event.slice("color:".length));
              if (color.success) changeColor(color.data);
            } else if (event === "delete") remove();
          }}
        >
          <ControlPill icon="ellipsis" accessibilityLabel={optionsLabel} />
        </Menu>
      }
    >
      {hosts.length > 1 ? (
        // More than one host can get the folder: the row opens the list of hosts.
        <Menu
          title={gt("Add folder")}
          actions={hosts.map((host) => ({
            id: host.hostId,
            title: host.label,
            attributes: { disabled },
          }))}
          onPressAction={({ nativeEvent }) => addFolderOn(nativeEvent.event)}
        >
          <SettingsRow icon="plus" label={gt("Add folder")} disabled={disabled} />
        </Menu>
      ) : (
        <ListActionRow
          icon="plus"
          label={gt("Add folder")}
          disabled={disabled}
          onPress={() => addFolderOn(environmentId)}
        />
      )}
    </ProjectRepositoriesSection>
  );
}
