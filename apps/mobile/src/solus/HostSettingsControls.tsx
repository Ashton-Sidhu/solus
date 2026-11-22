import { resourceAllows } from "@solus/contracts/permissions";
import { Note, useSettingsAction } from "./SettingsFeedback";
import { useCallback } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { HostApi } from "@solus/client-core/host-api";
import type { ProjectConfig } from "@solus/contracts/types";
import { WORKTREE_BRANCH_NAMING_MODES } from "@solus/contracts/worktree-branch-naming";
import { useListened } from "@solus-mobile/app/app-context";
import {
  hostUpdateControls,
  updateStatusText,
  serverUpdateText,
} from "@solus-mobile/features/settings/lib/update-status";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { ListChoiceRow } from "../components/ui/ListChoiceRow";
import { useSettingsEnvironmentMenu } from "../features/settings/components/SettingsEnvironmentFilterHeader";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import { SettingsPage, TextSetting } from "./SettingsPages";
import { solus } from "./runtime";
import { useHostSettingsRead } from "./use-host-settings-read";

const loadUpdate = (api: HostApi) => api.hostUpdateStatus();
function HostMaintenance({ id, label }: { id: string; label: string }) {
  const state = useHostSettingsRead(id, loadUpdate, "host.updateStatusChanged");
  const { run, busy } = useSettingsAction(state.refresh);
  const { canCheck, action } = hostUpdateControls(
    state.data ?? null,
    solus.connections.may(id, "host.admin"),
  );
  return (
    <SettingsSection title={label}>
      <Note>
        {state.data
          ? [
              state.data.currentVersion,
              updateStatusText(state.data),
              state.data.serverUpdate?.operation &&
                serverUpdateText(state.data.serverUpdate.operation),
            ]
              .filter(Boolean)
              .join(" · ")
          : (state.error ?? "Reading version…")}
      </Note>
      {canCheck && (
        <SettingsRow
          icon="arrow.clockwise"
          label="Check for updates"
          disabled={busy}
          onPress={() => void run(() => state.api!.hostCheckForUpdates())}
        />
      )}
      {action.kind === "update" && (
        <SettingsRow
          icon="arrow.down.circle"
          label={"Install " + action.version}
          disabled={busy}
          onPress={() =>
            Alert.alert("Update this host?", "Solus will restart on this host.", [
              { text: "Cancel" },
              {
                text: "Update",
                onPress: () => void run(() => state.api!.hostInstallUpdate()),
              },
            ])
          }
        />
      )}
      {action.kind === "cancel" && (
        <SettingsRow
          icon="xmark"
          label="Cancel update"
          onPress={() => void run(() => state.api!.hostCancelUpdate())}
        />
      )}
      {action.kind === "manual" && <Note>{action.text}</Note>}
      {state.data?.providers.map((p) => (
        <Note key={p.agent}>
          {p.agent} · {p.installedVersion ?? "Not installed"}
        </Note>
      ))}
    </SettingsSection>
  );
}
export function MaintenanceSettings() {
  const menu = useSettingsEnvironmentMenu();
  const { scopedTargets } = useSolusSettingsFilter();
  return (
    <SettingsPage title="Maintenance" menus={[menu]}>
      {!scopedTargets.length && <Note>Select a connected environment.</Note>}
      {scopedTargets.map((h) => (
        <HostMaintenance key={h.environmentId} id={h.environmentId} label={h.environmentLabel} />
      ))}
    </SettingsPage>
  );
}
export function LabsSettings() {
  return (
    <SettingsPage title="Labs">
      <Note>No experimental settings are available on this version of Solus.</Note>
    </SettingsPage>
  );
}
export function WorktreeSettings() {
  const settings = useListened(solus.personal.changes, solus.personal.current).worktreeBranchNaming;
  const change = (patch: Partial<typeof settings>) => {
    if (
      solus.personal.set({
        worktreeBranchNaming: {
          ...solus.personal.current().worktreeBranchNaming,
          ...patch,
        },
      }) === "invalid"
    )
      throw new Error("Check the length of the branch prefix and template.");
  };
  return (
    <SettingsPage title="Worktrees">
      <SettingsSection title="Worktree branch naming">
        {WORKTREE_BRANCH_NAMING_MODES.map((mode) => (
          <ListChoiceRow
            key={mode}
            label={{ generated: "Generated", static: "Static", custom: "Custom" }[mode]}
            selected={settings.mode === mode}
            onPress={() => change({ mode })}
          />
        ))}
      </SettingsSection>
      <TextSetting
        label="Branch prefix"
        value={settings.prefix}
        save={(prefix) => change({ prefix })}
      />
      {settings.mode === "custom" && (
        <TextSetting
          label="Branch template"
          hint="Available fields: {prefix}, {slug}, {id}, {user}."
          value={settings.template}
          save={(template) => change({ template })}
        />
      )}
    </SettingsPage>
  );
}
const readWorkspaceProjects = (api: HostApi) => api.workspaceProjectList();
function ProjectNameSettings({ hostId, repositoryKey }: { hostId: string; repositoryKey: string }) {
  const state = useHostSettingsRead(hostId, readWorkspaceProjects, "workspaceProjects.changed");
  const project = state.data?.find((p) => p.repositoryKey === repositoryKey);
  if (!project) return null;
  if (!resourceAllows(project, "edit"))
    return (
      <SettingsSection title="Project">
        <Note>{project.displayName}</Note>
      </SettingsSection>
    );
  return (
    <>
      <TextSetting
        label="Project name"
        value={project.displayName}
        save={async (name) => {
          if (!name.trim()) throw new Error("Enter a project name.");
          await state.api!.workspaceProjectUpdate(project.id, { displayName: name.trim() });
          state.refresh();
        }}
      />
      <TextSetting
        label="Default branch"
        value={project.defaultBranch ?? ""}
        save={async (branch) => {
          await state.api!.workspaceProjectUpdate(project.id, {
            defaultBranch: branch.trim() || null,
          });
          state.refresh();
        }}
      />
    </>
  );
}
function CheckoutSettings({
  hostId,
  path,
  label,
}: {
  hostId: string;
  path: string;
  label: string;
}) {
  const read = useCallback((api: HostApi) => api.projectConfigLoad(path), [path]);
  const state = useHostSettingsRead(hostId, read);
  const { run, busy } = useSettingsAction(state.refresh);
  const repositoryKey = solus.threads
    .projects()
    .find((p) => p.hostId === hostId && p.project.path === path)?.project.repositoryKey;
  return (
    <>
      {repositoryKey && <ProjectNameSettings hostId={hostId} repositoryKey={repositoryKey} />}
      <SettingsSection title={label}>
        <Note>{path}</Note>
        {state.data === undefined ? (
          <Note>{state.error ?? "Reading checkout…"}</Note>
        ) : (
          <SettingsSwitchRow
            label="Complete tasks when their pull request merges"
            value={state.data?.taskDoneOnMerge ?? true}
            disabled={busy}
            onValueChange={(value) =>
              void run(async () => {
                const config: ProjectConfig = (await state.api!.projectConfigLoad(path)) ?? {
                  version: 1,
                };
                await state.api!.projectConfigSave(path, {
                  ...config,
                  taskDoneOnMerge: value,
                });
              })
            }
          />
        )}
        <SettingsRow
          icon="trash"
          label="Remove checkout from projects"
          disabled={!state.api || busy}
          onPress={() =>
            Alert.alert("Remove checkout from projects?", path, [
              { text: "Cancel" },
              {
                text: "Remove",
                style: "destructive",
                onPress: () =>
                  void run(async () => {
                    await state.api!.untrackProject(path);
                    await solus.threads.load(hostId);
                  }),
              },
            ])
          }
        />
      </SettingsSection>
    </>
  );
}
export function ProjectSettings() {
  const menu = useSettingsEnvironmentMenu(),
    nav = useNavigation();
  const { selectedProjects, selectedProjectKey, scopedTargets } = useSolusSettingsFilter();
  return (
    <SettingsPage
      title="Projects"
      menus={[menu]}
      actions={[
        {
          icon: "plus",
          accessibilityLabel: "Add project",
          disabled: !scopedTargets.length,
          onPress: () => nav.navigate("AddProject"),
        },
      ]}
    >
      {selectedProjects.length === 0 && (
        <Note>
          {selectedProjectKey === null
            ? "Choose a project with the filter above to manage its checkouts."
            : "This project has no checkout on the selected environments."}
        </Note>
      )}
      {selectedProjects.map((p) => (
        <CheckoutSettings
          key={p.environmentId + p.id}
          path={p.workspaceRoot}
          hostId={p.environmentId}
          label={p.title}
        />
      ))}
    </SettingsPage>
  );
}
