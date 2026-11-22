import { ScheduledTaskListView } from "../features/settings/components/ScheduledTaskListView";
import { TaskEditor } from "./AutomationEditor";
import { useCallback, useRef } from "react";
import { Alert, Pressable, View } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Automation } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { resourceAllows } from "@solus/contracts/permissions";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { AppText } from "../components/ui/AppText";
import { Menu } from "../components/ui/Menu";
import { SymbolView } from "../components/ui/AppSymbol";
import { useSettingsEnvironmentMenu } from "../features/settings/components/SettingsEnvironmentFilterHeader";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import { SettingsPage } from "./SettingsPages";
import { Note, useSettingsAction } from "./SettingsFeedback";
import { useHostSettingsRead } from "./use-host-settings-read";
import { automationScheduleText } from "./automation-settings";

const listAutomations = (api: HostApi) => api.automationList();
function TaskList({
  id,
  label,
  paths,
}: {
  id: EnvironmentId;
  label: string;
  paths: string[] | null;
}) {
  const state = useHostSettingsRead(id, listAutomations, "automation.changed");
  const { busy, run } = useSettingsAction(state.refresh);
  const nav = useNavigation();
  const tasks = state.data?.filter(
    (t) => !t.archivedAt && (!paths || paths.includes(t.action.cwd)),
  );
  return (
    <SettingsSection title={label}>
      {tasks === undefined ? (
        <Note>{state.error ?? "Loading scheduled tasks…"}</Note>
      ) : (
        !tasks.length && <Note>No scheduled tasks.</Note>
      )}
      {tasks?.map((task) => {
        const canEdit = resourceAllows(task, "edit"),
          canRun = resourceAllows(task, "drive");
        return (
          <View
            key={task.id}
            className="flex-row items-center border-b border-border-subtle px-4 py-3"
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={"Edit " + task.name}
              className="flex-1 gap-1"
              onPress={() =>
                nav.navigate("SettingsScheduledTaskEdit", {
                  environmentId: id,
                  automationId: task.id,
                })
              }
            >
              <AppText textRole="body" className="text-foreground">
                {task.name}
              </AppText>
              <AppText className="text-foreground-muted">
                {automationScheduleText(task.trigger)}
                {!task.enabled
                  ? " · Paused"
                  : task.nextRunAt
                    ? " · Next " + new Date(task.nextRunAt).toLocaleString()
                    : ""}
              </AppText>
            </Pressable>
            <Menu
              actions={[
                { id: "edit", title: "Edit" },
                {
                  id: "run",
                  title: "Run now",
                  attributes: { disabled: busy || !canRun },
                },
                {
                  id: "toggle",
                  title: task.enabled ? "Pause" : "Resume",
                  attributes: { disabled: busy || !canEdit },
                },
                {
                  id: "delete",
                  title: "Delete",
                  attributes: { destructive: true, disabled: busy || !canEdit },
                },
              ]}
              onPressAction={({ nativeEvent: { event } }) => {
                if (event === "edit")
                  nav.navigate("SettingsScheduledTaskEdit", {
                    environmentId: id,
                    automationId: task.id,
                  });
                else if (event === "delete")
                  Alert.alert("Delete " + task.name + "?", undefined, [
                    { text: "Cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => void run(() => state.api!.automationDelete(task.id)),
                    },
                  ]);
                else if (event === "toggle")
                  void run(() => state.api!.automationSetEnabled(task.id, !task.enabled));
                else if (event === "run") void run(() => state.api!.automationRun(task.id));
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={"Actions for " + task.name}
                className="h-11 w-11 items-center justify-center"
              >
                <SymbolView
                  name="ellipsis"
                  size={18}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </Menu>
          </View>
        );
      })}
      {state.error && (
        <SettingsRow icon="arrow.clockwise" label="Try again" onPress={state.refresh} />
      )}
    </SettingsSection>
  );
}
export function ScheduledSettings() {
  const menu = useSettingsEnvironmentMenu(),
    nav = useNavigation();
  const { scopedTargets, selectedProjects, selectedProjectKey } = useSolusSettingsFilter();
  return (
    <ScheduledTaskListView
      disabled={!scopedTargets.length}
      menu={menu}
      onNew={() => nav.navigate("SettingsScheduledTaskNew")}
    >
      {!scopedTargets.length && <Note>Select a connected environment.</Note>}
      {scopedTargets.map((h) => (
        <TaskList
          key={h.environmentId}
          id={h.environmentId}
          label={h.environmentLabel}
          paths={
            selectedProjectKey === null
              ? null
              : selectedProjects
                  .filter((p) => p.environmentId === h.environmentId)
                  .map((p) => p.workspaceRoot)
          }
        />
      ))}
    </ScheduledTaskListView>
  );
}

export function EditScheduledSettings({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId; automationId: string }>) {
  const { environmentId, automationId } = route.params;
  const read = useCallback((api: HostApi) => api.automationRead(automationId), [automationId]);
  const task = useHostSettingsRead(environmentId, read);
  const opened = useRef<Automation | null>(null);
  if (task.data !== undefined) opened.current = task.data;
  return opened.current?.id === automationId ? (
    <TaskEditor key={automationId} environmentId={environmentId} task={opened.current} />
  ) : (
    <SettingsPage title="Scheduled task">
      <Note>
        {task.error ??
          (task.data === null ? "This task no longer exists." : "Loading scheduled task…")}
      </Note>
    </SettingsPage>
  );
}
export function NewScheduledSettings() {
  const { scopedTargets } = useSolusSettingsFilter();
  const initial = useRef<EnvironmentId | undefined>(undefined);
  if (!initial.current && scopedTargets[0]) initial.current = scopedTargets[0].environmentId;
  return initial.current ? (
    <TaskEditor environmentId={initial.current} />
  ) : (
    <SettingsPage title="New scheduled task">
      <Note>Select a connected environment.</Note>
    </SettingsPage>
  );
}
