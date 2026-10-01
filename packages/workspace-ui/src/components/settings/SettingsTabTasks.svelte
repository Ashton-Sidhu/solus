<script lang="ts">
  import { untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { AgentTaskLifecyclePolicy } from "@solus/contracts/types";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import PlainTextEditor from "../ui/plain-text-editor/plain-text-editor.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import {
    defaultModelIdFor,
    type PickerSelection,
  } from "../pickers/lib/picker-selection";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { connectionsStore, getAgentContext, getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { taskLeadSettingsStore } from "./task-lead-settings.store.svelte";
  import {
    leadModelAgents,
    leadModelFor,
    pickerFromLeadModel,
  } from "./lib/task-lead-models";
  import type { LeadModelSelection } from "@solus/contracts/host-config";

  interface Props {
    searchQuery?: string;
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }

  let { searchQuery = "", serverId, api, hostLabel }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();

  $effect(() => {
    const targetServerId = serverId;
    const targetApi = api;
    untrack(() => {
      void connectionsStore.refreshCapabilities({
        serverId: targetServerId,
        api: targetApi,
      });
    });
  });

  $effect(() => {
    const hostId = serverId;
    return untrack(() => taskLeadSettingsStore.watch(hostId));
  });

  const leadState = $derived(taskLeadSettingsStore.states.get(serverId));
  const leadSettings = $derived(leadState?.settings ?? null);
  const agents = $derived(leadModelAgents(agentContext.metadata));

  // ─── Task behavior ───

  const taskLifecyclePolicies: Array<{
    value: AgentTaskLifecyclePolicy;
    label: string;
  }> = [
    { value: "none", label: "None" },
    { value: "moderate", label: "Moderate" },
    { value: "autonomous", label: "Autonomous" },
  ];

  const taskLifecyclePolicy = $derived(
    connectionsStore.capabilitiesFor(serverId)?.agentTaskLifecyclePolicy,
  );
  const taskLifecyclePolicyLabel = $derived(
    taskLifecyclePolicies.find((option) => option.value === taskLifecyclePolicy)
      ?.label ?? "Unavailable",
  );

  async function selectTaskLifecyclePolicy(value: AgentTaskLifecyclePolicy) {
    await connectionsStore.setAgentTaskLifecyclePolicy(value, {
      serverId,
      api,
    });
    requestInputFocus();
  }

  function commitCompletedRetentionDays(value: number) {
    const days = Number.isFinite(value)
      ? Math.max(1, Math.min(365, Math.floor(value)))
      : theme.sidebarCompletedRetentionDays;
    theme.update({ sidebarCompletedRetentionDays: days });
  }

  // ─── Lead session ───

  /** What a model switch turns on with: the default agent's default model,
   *  or the first agent a lead may name. */
  function initialModel(): LeadModelSelection | null {
    const agent = agents[0];
    return (
      leadModelFor(
        theme.activeAgent,
        defaultModelIdFor(theme.activeAgent, agentContext.metadata),
      ) ?? (agent ? leadModelFor(agent.id, agent.defaultModel) : null)
    );
  }

  // The chips edit a detached selection in place, so each keeps its own
  // `$state` and follows the saved value.
  let leadPickerSelection = $state<PickerSelection | null>(null);
  let workerPickerSelection = $state<PickerSelection | null>(null);

  $effect(() => {
    leadPickerSelection = theme.leadModel ? pickerFromLeadModel(theme.leadModel) : null;
  });

  $effect(() => {
    const workerModel = leadSettings?.workerModel;
    workerPickerSelection = workerModel ? pickerFromLeadModel(workerModel) : null;
  });

  function setLeadModelEnabled(enabled: boolean) {
    theme.update({ leadModel: enabled ? initialModel() : null });
  }

  function selectLeadModel(selection: PickerSelection) {
    const leadModel = leadModelFor(selection.provider, selection.modelId, selection.reasoningEffort);
    if (leadModel) theme.update({ leadModel });
  }

  function setWorkerModelEnabled(enabled: boolean) {
    void taskLeadSettingsStore.save(serverId, {
      workerModel: enabled ? initialModel() : null,
    });
  }

  function selectWorkerModel(selection: PickerSelection) {
    const workerModel = leadModelFor(selection.provider, selection.modelId, selection.reasoningEffort);
    if (workerModel) void taskLeadSettingsStore.save(serverId, { workerModel });
  }

  // Saved on blur, not per keystroke: the host may be across a network.
  let leadInstructionsDraft = $state("");
  $effect(() => {
    leadInstructionsDraft = leadSettings?.leadInstructions ?? "";
  });

  function commitLeadInstructions() {
    if (leadSettings && leadInstructionsDraft !== leadSettings.leadInstructions) {
      void taskLeadSettingsStore.save(serverId, {
        leadInstructions: leadInstructionsDraft,
      });
    }
    requestInputFocus();
  }

  // ─── Search ───

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    {
      id: "task-lifecycle",
      keywords: ["agent", "task", "ticket", "lifecycle", "status", "done", "autonomous", "moderate"],
    },
    {
      id: "completed-retention",
      keywords: ["task", "completed", "done", "sidebar", "history", "days", "retention"],
    },
    {
      id: "lead-model",
      keywords: ["lead", "orchestration", "orchestrator", "task", "agent", "model", "reasoning", "effort", "claude", "codex"],
    },
    {
      id: "worker-model",
      keywords: ["worker", "routing", "route", "orchestration", "task", "agent", "model", "reasoning", "effort", "default"],
    },
    {
      id: "lead-instructions",
      keywords: ["lead", "orchestration", "orchestrator", "instructions", "routing", "route", "prompt", "rules"],
    },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));
</script>

<SettingsSection
  label="Task behavior"
  visible={["task-lifecycle", "completed-retention"].some(isVisible)}
>
  <SettingsRow
    label="Task lifecycle control"
    description="None: no changes. Moderate: Done is yours. Autonomous: full control."
    visible={isVisible("task-lifecycle")}
  >
    {#snippet control()}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Task lifecycle control"
              class="min-w-28 justify-between text-xs font-normal shadow-xs"
              disabled={taskLifecyclePolicy === undefined ||
                connectionsStore.agentTaskLifecyclePolicyUpdating}
            >
              <span>{taskLifecyclePolicyLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[160px]"
        >
          <DropdownMenu.RadioGroup value={taskLifecyclePolicy}>
            {#each taskLifecyclePolicies as option (option.value)}
              <DropdownMenu.RadioItem
                value={option.value}
                onSelect={() => selectTaskLifecyclePolicy(option.value)}
              >
                {option.label}
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
    {#if taskLifecyclePolicy === undefined}
      {#snippet body()}
        <p class="text-xs text-muted-foreground">
          This host does not expose task lifecycle controls. Reconnect it after
          updating Solus.
        </p>
      {/snippet}
    {/if}
  </SettingsRow>

  <SettingsRow
    label="Completed task history"
    description="Days to keep completed tasks in the sidebar."
    visible={isVisible("completed-retention")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-border bg-card shadow-xs"
      >
        <button
          type="button"
          onclick={() =>
            commitCompletedRetentionDays(
              theme.sidebarCompletedRetentionDays - 1,
            )}
          aria-label="Decrease completed task history"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >&minus;</button
        >
        <Input
          type="number"
          min={1}
          max={365}
          step={1}
          value={String(theme.sidebarCompletedRetentionDays)}
          aria-label="Completed task history in days"
          onchange={(event) => {
            commitCompletedRetentionDays(
              Number((event.target as HTMLInputElement).value),
            );
            (event.target as HTMLInputElement).value = String(
              theme.sidebarCompletedRetentionDays,
            );
          }}
          class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">d</span>
        <button
          type="button"
          onclick={() =>
            commitCompletedRetentionDays(
              theme.sidebarCompletedRetentionDays + 1,
            )}
          aria-label="Increase completed task history"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Lead session"
  visible={["lead-model", "worker-model", "lead-instructions"].some(isVisible)}
>
  <SettingsRow
    label="Lead model"
    description="Model and reasoning a new task lead starts on. Off uses the default for new sessions."
    visible={isVisible("lead-model")}
  >
    {#snippet control()}
      <div class="flex items-center justify-end gap-2">
        {#if leadPickerSelection}
          <SessionChip
            selection={leadPickerSelection}
            {agents}
            allowFastMode={false}
            menuSide="bottom"
            ariaLabel="Lead model and reasoning"
            returnFocusOnClose
            class="w-full @min-[30rem]/pane:w-56"
            onSelectionChange={selectLeadModel}
          />
        {/if}
        <Switch
          checked={theme.leadModel !== null}
          onCheckedChange={setLeadModelEnabled}
          aria-label="Use a separate model for task leads"
        />
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Default worker model"
    description="Model and reasoning the lead gives a worker when your instructions name none. Off lets the lead choose."
    visible={isVisible("worker-model")}
    disabled={!leadSettings}
  >
    {#snippet control()}
      <div class="flex items-center justify-end gap-2">
        {#if workerPickerSelection}
          <SessionChip
            selection={workerPickerSelection}
            {agents}
            allowFastMode={false}
            menuSide="bottom"
            ariaLabel="Default worker model and reasoning"
            returnFocusOnClose
            disabled={leadState?.saving}
            class="w-full @min-[30rem]/pane:w-56"
            onSelectionChange={selectWorkerModel}
          />
        {/if}
        <Switch
          checked={!!leadSettings?.workerModel}
          disabled={!leadSettings || leadState?.saving}
          onCheckedChange={setWorkerModelEnabled}
          aria-label="Use a default worker model"
        />
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Lead instructions"
    description="Added after the built-in lead rules on {hostLabel}. Say how to route work to agents and models."
    visible={isVisible("lead-instructions")}
  >
    {#snippet body()}
      {#if leadSettings}
        <PlainTextEditor
          value={leadInstructionsDraft}
          onValueChange={(text) => (leadInstructionsDraft = text)}
          onBlur={commitLeadInstructions}
          enterInsertsNewline
          hidePlaceholderOnFocus
          maxHeight={220}
          dictation
          placeholder="Send frontend work to Claude Opus and backend work to Codex. Ask before you start more than three workers."
          class="rounded-lg border border-border bg-background px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
        />
      {/if}
      {#if leadState?.error}
        <div class="flex items-center gap-2 text-workspace-chrome" role="status">
          <span class="text-destructive">{leadState.error}</span>
          <button
            type="button"
            class="underline"
            onclick={() => taskLeadSettingsStore.load(serverId)}>Retry</button
          >
        </div>
      {:else if !leadSettings}
        <p class="text-xs text-muted-foreground">Loading…</p>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div
    class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)"
  >
    No settings match your search
  </div>
{/if}
