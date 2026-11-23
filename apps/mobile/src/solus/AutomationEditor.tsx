import {
  WeeklyScheduleFields,
  OnceScheduleFields,
} from "../features/settings/components/ScheduledTaskTimeFields";
import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "../state/atom-registry";
import { automationModelDraft } from "./AutomationModelPicker";
import { Button } from "../components/ui/Button";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { ScheduledTaskPromptField } from "../features/settings/components/ScheduledTaskPromptField";
import { useVoiceInputController } from "../features/voice-input/useVoiceInputController";
import { useRoute } from "@react-navigation/native";
import { newSessionModel, selectModel } from "@solus-mobile/features/conversation/lib/run-settings";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useNavigation, useFocusEffect, usePreventRemove } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Automation, AutomationTrigger, AgentId } from "@solus/contracts/types";
import { resourceAllows } from "@solus/contracts/permissions";
import { modelChoices } from "@solus-mobile/features/conversation/lib/run-settings";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import { FormField, SelectRow } from "../features/settings/components/ScheduledTaskFields";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import {
  ScheduledTaskDetails,
  ScheduledTaskEditor,
} from "../features/settings/components/ScheduledTaskEditor";
import { useSettingsAction } from "./SettingsFeedback";
import { solus, useSolusWorkspace } from "./runtime";
import { automationEditPatch, editedTrigger, weeklySchedule } from "./automation-settings";

export function TaskEditor({
  environmentId,
  task: openedTask,
}: {
  environmentId: EnvironmentId;
  task?: Automation;
}) {
  const [task] = useState(openedTask);
  const nav = useNavigation(),
    directory = useSolusWorkspace();
  const { scopedTargets, selectedProjects } = useSolusSettingsFilter();
  const [host, setHost] = useState(environmentId);
  const projects = directory.projects.filter((p) => p.environmentId === host);
  const defaultCwd = (id: string) =>
    selectedProjects.find((p) => p.environmentId === id)?.workspaceRoot ??
    directory.projects.find((p) => p.environmentId === id)?.workspaceRoot ??
    "";
  const [cwd, setCwd] = useState(task?.action.cwd ?? defaultCwd(host));
  const [title, setTitle] = useState(task?.name ?? ""),
    [prompt, setPrompt] = useState(task?.action.prompt ?? "");
  const [provider, setProvider] = useState<AgentId>(
    task?.action.agentProvider ?? solus.personal.current().activeAgent,
  );
  const [model, setModel] = useState(
    task ? (task.action.modelId ?? "") : (solus.personal.current().defaultModels[provider] ?? ""),
  );
  const [reasoningEffort, setReasoningEffort] = useState(
    () =>
      task?.action.reasoningEffort ??
      (model
        ? selectModel(provider, model, solus.personal.runSettings())
        : newSessionModel(provider, solus.personal.runSettings(), undefined, false)
      ).reasoningEffort,
  );
  const [fastMode, setFastMode] = useState(task?.action.fastMode ?? false);
  const [enabled, setEnabled] = useState(task?.enabled ?? true),
    [worktree, setWorktree] = useState(task?.action.useWorktree ?? false);
  const [mode, setMode] = useState<AutomationTrigger["type"]>(task?.trigger.type ?? "cron");
  const [interval, setIntervalValue] = useState(
    String(task?.trigger.type === "interval" ? task.trigger.everyMinutes : 15),
  );
  const [cron, setCron] = useState(
    task?.trigger.type === "cron" ? task.trigger.expr : "0 9 * * 1-5",
  );
  const [zone, setZone] = useState(
    task?.trigger.type === "cron"
      ? (task.trigger.timezone ?? "")
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [once, setOnce] = useState(
    () => new Date(task?.trigger.type === "once" ? task.trigger.runAt : Date.now() + 3600000),
  );
  const [customCron, setCustomCron] = useState(
    task?.trigger.type === "cron" && !weeklySchedule(task.trigger.expr),
  );
  const weekly = weeklySchedule(cron);
  const [dirty, setDirty] = useState(false),
    saved = useRef(false);
  const { busy, run } = useSettingsAction();
  usePreventRemove(dirty, ({ data }) => {
    if (saved.current) {
      nav.dispatch(data.action);
      return;
    }
    if (!busy)
      Alert.alert("Discard changes?", "Your unsaved changes will be lost.", [
        { text: "Keep editing" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => nav.dispatch(data.action),
        },
      ]);
  });
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setDirty(true);
      set(value);
    };
  const modelList = modelChoices(provider, model);
  const modelItems = [{ id: "", label: "Provider default" }, ...modelList];
  if (model && !modelItems.some((m) => m.id === model))
    modelItems.push({ id: model, label: model });
  const canSave =
    !!directory.hostsById[host] &&
    directory.hostsById[host]?.connectionState === "connected" &&
    (!task || resourceAllows(task, "edit"));
  const route = useRoute();
  const modelAtom = automationModelDraft(route.key);
  const picked = useAtomValue(modelAtom);
  const [permissions, setPermissions] = useState(
    task?.executionPreferences?.preferences.defaultPermissionMode ??
      solus.personal.current().defaultPermissionMode,
  );
  useFocusEffect(
    useCallback(() => {
      if (!picked || !picked.changed) return;
      if (
        picked.provider !== provider ||
        picked.model !== model ||
        picked.reasoningEffort !== reasoningEffort ||
        picked.fastMode !== fastMode ||
        picked.prompt !== prompt ||
        picked.permissions !== permissions
      )
        setDirty(true);
      setProvider(picked.provider);
      setModel(picked.model);
      setReasoningEffort(picked.reasoningEffort);
      setFastMode(picked.fastMode);
      setPrompt(picked.prompt);
      setPermissions(picked.permissions);
      appAtomRegistry.set(modelAtom, null);
    }, [modelAtom, picked, provider, model, reasoningEffort, fastMode, prompt, permissions]),
  );
  useEffect(
    () => () => {
      appAtomRegistry.set(modelAtom, null);
    },
    [modelAtom],
  );
  const [selection, setSelection] = useState({
    start: prompt.length,
    end: prompt.length,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: route.key + host,
    label: title || "Scheduled task",
    selection,
    onChangeSelection: setSelection,
    readDraftMessage: () => prompt,
    onChangeDraftMessage: change(setPrompt),
    disabled: busy,
  });
  const save = () =>
    run(async () => {
      const api = solus.connections.connection(host)?.api;
      if (!canSave || !api) throw new Error("Reconnect to the environment to save.");
      if (!title.trim() || !prompt.trim() || !cwd)
        throw new Error("Enter a name, prompt and project.");
      const trigger = editedTrigger(
        mode,
        mode === "cron" ? cron : mode === "once" ? once.toISOString() : interval,
        zone,
        task?.trigger,
      );
      const action = {
        prompt: prompt.trim(),
        agentProvider: provider,
        modelId: model || null,
        reasoningEffort,
        fastMode,
        cwd,
        useWorktree: worktree,
      };
      if (task) {
        if (
          !(await api.automationUpdate(task.id, {
            ...automationEditPatch(task, { name: title.trim(), enabled, trigger, action }),
            ...(permissions !==
            (task.executionPreferences?.preferences.defaultPermissionMode ??
              solus.personal.current().defaultPermissionMode)
              ? {
                  executionPreferences: {
                    ...(task.executionPreferences?.preferences ??
                      solus.personal.executionPreferences()),
                    defaultPermissionMode: permissions,
                  },
                }
              : {}),
          }))
        )
          throw new Error("This task no longer exists.");
      } else
        await api.automationCreate(
          title.trim(),
          { ...action, fastMode: fastMode || undefined },
          enabled,
          trigger,
          {
            ...solus.personal.executionPreferences(),
            defaultPermissionMode: permissions,
          },
        );
      saved.current = true;
      nav.goBack();
    });
  return (
    <ScheduledTaskEditor
      title={task ? "Edit scheduled task" : "New scheduled task"}
      guardBack={dirty}
    >
      <ScheduledTaskDetails
        host={{
          value: directory.hostsById[host]?.environmentLabel ?? host,
          actions: task
            ? []
            : scopedTargets.map((h) => ({
                id: h.environmentId,
                title: h.environmentLabel,
              })),
          onSelect: (id) => {
            const h = scopedTargets.find((h) => h.environmentId === id);
            if (h) {
              change(setHost)(h.environmentId);
              setCwd(defaultCwd(id));
            }
          },
        }}
        name={{ value: title, onChange: change(setTitle), disabled: busy }}
        project={{
          value: projects.find((p) => p.workspaceRoot === cwd)?.title ?? cwd,
          actions: projects.map((p) => ({
            id: p.workspaceRoot,
            title: p.title,
          })),
          onSelect: change(setCwd),
        }}
        model={{
          value: modelItems.find((m) => m.id === model)?.label ?? model,
          onPress: () => {
            appAtomRegistry.set(modelAtom, {
              host,
              cwd,
              organizationId: task?.organizationId ?? solus.account.organizationId,
              provider,
              model,
              reasoningEffort,
              fastMode,
              prompt,
              permissions,
              changed: false,
            });
            nav.navigate("SettingsScheduledTaskModel", {
              editorKey: route.key,
            });
          },
          disabled: busy || voiceInput.blocksSubmission,
        }}
        prompt={
          <ScheduledTaskPromptField
            value={prompt}
            onChange={change(setPrompt)}
            selection={selection}
            onChangeSelection={setSelection}
            disabled={busy}
            voiceInput={voiceInput}
          />
        }
      />
      <SettingsSection>
        <SettingsSwitchRow label="Enabled" value={enabled} onValueChange={change(setEnabled)} />
        <SettingsSwitchRow
          label="Run in a new worktree"
          value={worktree}
          onValueChange={change(setWorktree)}
        />
      </SettingsSection>
      <SettingsSection title="Schedule">
        <View className="px-4 py-3">
          <SegmentedControl
            variant="card"
            selected={mode}
            options={
              [
                { value: "manual", label: "Manual" },
                { value: "once", label: "Once" },
                { value: "interval", label: "Interval" },
                { value: "cron", label: "Schedule" },
              ] as const
            }
            onSelect={change(setMode)}
          />
        </View>
        {mode === "interval" && (
          <FormField
            label="Every (minutes)"
            value={interval}
            keyboardType="number-pad"
            onChange={change(setIntervalValue)}
          />
        )}
        {mode === "cron" && (
          <>
            <SelectRow
              label="Schedule type"
              value={customCron ? "Custom cron" : "Fixed time"}
              actions={[
                { id: "fixed", title: "Fixed time" },
                { id: "custom", title: "Custom cron" },
              ]}
              onSelect={(id) => {
                if (id === "fixed" && !weekly) change(setCron)("0 9 * * 1-5");
                setCustomCron(id === "custom");
              }}
            />
            {!customCron && weekly ? (
              <WeeklyScheduleFields
                runAtZone={zone}
                timeOfDay={
                  String(weekly.hour).padStart(2, "0") +
                  ":" +
                  String(weekly.minute).padStart(2, "0")
                }
                weekdays={weekly.days.split(",").map(Number)}
                onTimeChange={(time) => {
                  const [hour, minute] = time.split(":").map(Number);
                  change(setCron)(minute + " " + hour + " * * " + weekly.days);
                }}
                onDaysChange={(days) => {
                  if (days.length)
                    change(setCron)(
                      weekly.minute +
                        " " +
                        weekly.hour +
                        " * * " +
                        days.sort((a, b) => a - b).join(","),
                    );
                }}
              />
            ) : (
              <FormField label="Cron schedule" value={cron} onChange={change(setCron)} />
            )}
            <FormField label="Time zone" value={zone} onChange={change(setZone)} />
          </>
        )}
        {mode === "once" && <OnceScheduleFields runAt={once} onChange={change(setOnce)} />}
      </SettingsSection>
      <Button
        label={busy ? "Saving…" : task ? "Save changes" : "Create scheduled task"}
        disabled={
          !canSave || busy || voiceInput.blocksSubmission || !title.trim() || !prompt.trim() || !cwd
        }
        onPress={() => void save()}
      />
    </ScheduledTaskEditor>
  );
}
