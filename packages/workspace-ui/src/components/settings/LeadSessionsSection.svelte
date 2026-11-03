<script lang="ts">
  /** Lead sessions: the model a new lead session starts on, the default model
   *  its workers start on, and the instructions added to its contract. Lives
   *  under Sessions; the Sessions tab owns the search entries. */
  import type { LeadModelSelection } from "@solus/contracts/settings";
  import { Switch } from "../ui/switch";
  import SessionChip from "../pickers/SessionChip.svelte";
  import {
    defaultModelIdFor,
    type PickerSelection,
  } from "../pickers/lib/picker-selection";
  import { getAgentContext, getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { managedSetting } from "./policy/managed-setting.svelte";
  import SettingsTextField from "./SettingsTextField.svelte";
  import {
    leadModelAgents,
    leadModelFor,
    pickerFromLeadModel,
  } from "./lib/lead-models";

  let { isVisible }: { isVisible: (id: string) => boolean } = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const agents = $derived(leadModelAgents(agentContext.metadata));

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
</script>

<SettingsSection
  label="Coordinator mode"
  visible={["lead-model", "worker-model", "lead-instructions"].some(isVisible)}
>
  <SettingsRow
    label="Coordinator mode model"
    managed={managedSetting("leadModel")}
    description="What a session in Coordinator mode starts on. Off uses the default for new sessions."
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
          aria-label="Use a separate model for Coordinator mode sessions"
        />
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Default worker model"
    managed={managedSetting("workerModel")}
    description="What a Coordinator mode session starts its workers on when its instructions name none. Off lets it choose."
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
    label="Coordinator mode instructions"
    managed={managedSetting("leadInstructions")}
    description="Added after the built-in rules a Coordinator mode session follows."
    visible={isVisible("lead-instructions")}
  >
    {#snippet body()}
      <SettingsTextField
        label="Coordinator mode instructions"
        value={leadInstructionsDraft}
        onValueChange={(text) => (leadInstructionsDraft = text)}
        onBlur={commitLeadInstructions}
        placeholder="Send frontend work to Claude Opus and backend work to Codex. Ask before you start more than three workers."
        class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>
