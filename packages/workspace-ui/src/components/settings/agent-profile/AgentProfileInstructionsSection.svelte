<script lang="ts">
  /**
   * Settings → Agent profile → Instructions: the person's own instructions, a
   * personal setting every prompt carries (plans/018 §3.1), so they follow the
   * person to every host like the rest of the profile. The extra instructions
   * go with every run; the per-model instructions only when that model runs.
   * The home's CLAUDE.md and AGENTS.md are not here: they belong with a project.
   */
  import SettingsTextField from "../SettingsTextField.svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { getAgentContext, getSettingsContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import { modelInstructionGroups } from "./lib/agent-profile-entries";

  const theme = getSettingsContext();
  const agentContext = getAgentContext();

  const groups = $derived(modelInstructionGroups(agentContext.agents, agentContext.metadata));
  const modelRows = $derived(groups.flatMap((group) => group.models));

  let chosenModelId = $state(agentContext.metadata[theme.activeAgent]?.defaultModel ?? "");
  const selectedModelId = $derived(modelRows.some((m) => m.id === chosenModelId) ? chosenModelId : (modelRows[0]?.id ?? ""));
  const selectedModelLabel = $derived(modelRows.find((m) => m.id === selectedModelId)?.label ?? selectedModelId);

  function selectModel(id: string) {
    chosenModelId = id;
    requestInputFocus();
  }
</script>

<SettingsSection label="Instructions" description="Your own instructions, sent with every prompt on every host. A project's CLAUDE.md or AGENTS.md stays with the project.">
  <SettingsRow label="Extra instructions" description="Appended to the system prompt for every agent run." testId="agent-profile-extra-instructions">
    {#snippet body()}
      <!-- Both instruction fields match the message composer: accent focus ring
           and a forced 400 weight so typed text never reads bold. The
           placeholder uses the smaller workspace-chrome type rung. -->
      <SettingsTextField
        label="Extra instructions"
        value={theme.extraInstructions}
        onValueChange={(md) => theme.setPersonal("extraInstructions", md)}
        onBlur={() => requestInputFocus()}
        placeholder="Prefer concise answers. Use specific libraries. Follow my writing style."
        class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
      />
    {/snippet}
  </SettingsRow>
  <SettingsRow label="Per-model instructions" description="Added after the instructions above when this model runs." testId="agent-profile-model-instructions">
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger disabled={modelRows.length === 0}>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Model" class="min-w-44 justify-between text-xs font-normal shadow-xs">
              <span class="flex min-w-0 items-center gap-1.5">
                {#if theme.modelInstructions[selectedModelId]?.trim()}
                  <span class="size-1.5 shrink-0 rounded-full bg-(--solus-accent)"></span>
                {/if}
                <span class="truncate">{selectedModelLabel || "Select model"}</span>
              </span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[240px]">
          <DropdownMenu.RadioGroup value={selectedModelId}>
            {#each groups as group, i (group.agentLabel)}
              {#if groups.length > 1}
                {#if i > 0}<DropdownMenu.Separator />{/if}
                <DropdownMenu.GroupHeading>{group.agentLabel}</DropdownMenu.GroupHeading>
              {/if}
              {#each group.models as model (model.id)}
                <DropdownMenu.RadioItem value={model.id} onSelect={() => selectModel(model.id)}>
                  <span class="flex min-w-0 items-center gap-1.5">
                    {#if theme.modelInstructions[model.id]?.trim()}
                      <span class="size-1.5 shrink-0 rounded-full bg-(--solus-accent)"></span>
                    {/if}
                    <span class="truncate">{model.label}</span>
                  </span>
                </DropdownMenu.RadioItem>
              {/each}
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
    {#snippet body()}
      <SettingsTextField
        label={selectedModelLabel ? `${selectedModelLabel} instructions` : "Per-model instructions"}
        value={theme.modelInstructions[selectedModelId] ?? ""}
        onValueChange={(md) => theme.setPersonal("modelInstructions", { ...$state.snapshot(theme.modelInstructions), [selectedModelId]: md })}
        onBlur={() => requestInputFocus()}
        placeholder="Instructions that only apply when {selectedModelLabel || 'this model'} is running."
        class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>
