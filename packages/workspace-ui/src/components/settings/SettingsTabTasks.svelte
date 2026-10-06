<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export interface SettingItem {
    id: string;
    keywords: string[];
  }

  export const settingItems: SettingItem[] = [
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
</script>

<script lang="ts">
  import type { AgentTaskLifecyclePolicy } from "@solus/contracts/types";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsTextField from "./SettingsTextField.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import {
    defaultModelIdFor,
    type PickerSelection,
  } from "../pickers/lib/picker-selection";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { getAgentContext, getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    leadModelAgents,
    leadModelFor,
    pickerFromLeadModel,
  } from "./lib/task-lead-models";
  import type { LeadModelSelection } from "@solus/contracts/settings";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
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

  const taskLifecyclePolicyLabel = $derived(
    taskLifecyclePolicies.find((option) => option.value === theme.agentTaskLifecyclePolicy)
      ?.label ?? theme.agentTaskLifecyclePolicy,
  );

  function selectTaskLifecyclePolicy(value: AgentTaskLifecyclePolicy) {
    theme.setPersonal("agentTaskLifecyclePolicy", value);
    requestInputFocus();
  }

  function commitCompletedRetentionDays(value: number) {
    const days = Number.isFinite(value)
      ? Math.max(1, Math.min(365, Math.floor(value)))
      : theme.sidebarCompletedRetentionDays;
    theme.setPersonal("sidebarCompletedRetentionDays", days);
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
    const workerModel = theme.workerModel;
    workerPickerSelection = workerModel ? pickerFromLeadModel(workerModel) : null;
  });

  function setLeadModelEnabled(enabled: boolean) {
    theme.setPersonal("leadModel", enabled ? initialModel() : null);
  }

  function selectLeadModel(selection: PickerSelection) {
    const leadModel = leadModelFor(selection.provider, selection.modelId, selection.reasoningEffort);
    if (leadModel) theme.setPersonal("leadModel", leadModel);
  }

  function setWorkerModelEnabled(enabled: boolean) {
    theme.setPersonal("workerModel", enabled ? initialModel() : null);
  }

  function selectWorkerModel(selection: PickerSelection) {
    const workerModel = leadModelFor(selection.provider, selection.modelId, selection.reasoningEffort);
    if (workerModel) theme.setPersonal("workerModel", workerModel);
  }

  // Saved on blur, not per keystroke: a synced profile sends after a pause anyway.
  let leadInstructionsDraft = $state("");
  $effect(() => {
    leadInstructionsDraft = theme.leadInstructions;
  });

  function commitLeadInstructions() {
    if (leadInstructionsDraft !== theme.leadInstructions) {
      theme.setPersonal("leadInstructions", leadInstructionsDraft);
    }
    requestInputFocus();
  }

  // ─── Search ───


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
          <DropdownMenu.RadioGroup value={theme.agentTaskLifecyclePolicy}>
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
  </SettingsRow>

  <SettingsRow
    label="Completed task history"
    description="Days to keep completed tasks in the sidebar."
    visible={isVisible("completed-retention")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-input bg-white shadow-xs/5 dark:bg-input/30"
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
            class="w-full @min-[30rem]/pane:w-56"
            onSelectionChange={selectWorkerModel}
          />
        {/if}
        <Switch
          checked={!!theme.workerModel}
          onCheckedChange={setWorkerModelEnabled}
          aria-label="Use a default worker model"
        />
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Lead instructions"
    description="Added after the built-in lead rules on every host. Say how to route work to agents and models."
    visible={isVisible("lead-instructions")}
  >
    {#snippet body()}
      <SettingsTextField
        label="Lead instructions"
        value={leadInstructionsDraft}
        onValueChange={(text) => (leadInstructionsDraft = text)}
        onBlur={commitLeadInstructions}
        placeholder="Send frontend work to Claude Opus and backend work to Codex. Ask before you start more than three workers."
        class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
      />
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
