<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import type { WorkerModelSelection } from "@solus/contracts/settings";
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
    workerModelAgents,
    workerModelFor,
    pickerFromWorkerModel,
    initialFallbackModel,
  } from "./lib/worker-models";

  let { isVisible }: { isVisible: (id: string) => boolean } = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const agents = $derived(workerModelAgents(agentContext.metadata));

  /** What a model switch turns on with: the default agent's default model,
   *  or the first available worker provider. */
  function initialModel(): WorkerModelSelection | null {
    const agent = agents[0];
    return (
      workerModelFor(
        theme.activeAgent,
        defaultModelIdFor(theme.activeAgent, agentContext.metadata),
      ) ?? (agent ? workerModelFor(agent.id, agent.defaultModel) : null)
    );
  }

  // The picker edits a detached selection that follows the saved value.
  let workerPickerSelection = $state<PickerSelection | null>(null);

  $effect(() => {
    const workerModel = theme.workerModel;
    workerPickerSelection = workerModel ? pickerFromWorkerModel(workerModel) : null;
  });

  function setWorkerModelEnabled(enabled: boolean) {
    theme.setPersonal("workerModel", enabled ? initialModel() : null);
  }

  function selectWorkerModel(selection: PickerSelection) {
    const workerModel = workerModelFor(selection.provider, selection.modelId, selection.reasoningEffort);
    if (workerModel) theme.setPersonal("workerModel", workerModel);
  }

  let fallbackPickerSelection = $state<PickerSelection | null>(null);

  $effect(() => {
    const fallbackModel = theme.fallbackModel;
    fallbackPickerSelection = fallbackModel ? pickerFromWorkerModel(fallbackModel) : null;
  });

  function setFallbackModelEnabled(enabled: boolean) {
    theme.setPersonal(
      "fallbackModel",
      enabled ? initialFallbackModel(agents, theme.workerModel?.provider ?? theme.activeAgent) : null,
    );
  }

  function selectFallbackModel(selection: PickerSelection) {
    const fallbackModel = workerModelFor(selection.provider, selection.modelId, selection.reasoningEffort);
    if (fallbackModel) theme.setPersonal("fallbackModel", fallbackModel);
  }

  // Saved on blur, not per keystroke: a synced profile sends after a pause anyway.
  let delegationInstructionsDraft = $state("");
  $effect(() => {
    delegationInstructionsDraft = theme.delegationInstructions;
  });

  function commitDelegationInstructions() {
    if (delegationInstructionsDraft !== theme.delegationInstructions) {
      theme.setPersonal("delegationInstructions", delegationInstructionsDraft);
    }
    requestInputFocus();
  }
</script>

<SettingsSection
  {...settingsDefinitions["sessions.section-delegation"]}
  visible={["worker-model", "fallback-model", "delegation-instructions"].some(isVisible)}
>
  <SettingsRow
    {...settingsDefinitions["sessions.worker-model"]}
    managed={managedSetting("workerModel")}
    visible={isVisible("worker-model")}
  >
    {#snippet control()}
      <div class="flex items-center justify-end gap-2">
        {#if workerPickerSelection}
          <SessionChip
            browseAgents
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
    {...settingsDefinitions["sessions.fallback-model"]}
    managed={managedSetting("fallbackModel")}
    visible={isVisible("fallback-model")}
  >
    {#snippet control()}
      <div class="flex items-center justify-end gap-2">
        {#if fallbackPickerSelection}
          <SessionChip
            browseAgents
            selection={fallbackPickerSelection}
            {agents}
            allowFastMode={false}
            menuSide="bottom"
            ariaLabel="Fallback model and reasoning"
            returnFocusOnClose
            class="w-full @min-[30rem]/pane:w-56"
            onSelectionChange={selectFallbackModel}
          />
        {/if}
        <Switch
          checked={!!theme.fallbackModel}
          onCheckedChange={setFallbackModelEnabled}
          aria-label="Use a fallback model"
        />
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["sessions.delegation-instructions"]}
    managed={managedSetting("delegationInstructions")}
    visible={isVisible("delegation-instructions")}
  >
    {#snippet body()}
      <SettingsTextField
        label="Delegation instructions"
        value={delegationInstructionsDraft}
        onValueChange={(text) => (delegationInstructionsDraft = text)}
        onBlur={commitDelegationInstructions}
        placeholder="Send frontend work to Claude Opus and backend work to Codex. Ask before you start more than three workers."
        class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>
