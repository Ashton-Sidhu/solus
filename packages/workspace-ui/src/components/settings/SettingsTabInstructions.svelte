<script lang="ts">
  import PlainTextEditor from "../ui/plain-text-editor/plain-text-editor.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { getAgentContext, getSettingsContext } from "../../contexts";
  import { buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();

  const agentRows = $derived(
    buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata).filter((a) => a.enabled),
  );

  // Models across all enabled agents, grouped by agent for display but deduped
  // by id — instructions are keyed by resolved model id alone (matching
  // statusBar.model), not per-agent, so an id claimed by an earlier agent is
  // skipped in later groups rather than shown twice.
  const groupedModelRows = $derived.by(() => {
    const seen = new Set<string>();
    return agentRows
      .map((agent) => ({
        agent,
        models: (agentContext.metadata[agent.id]?.models ?? []).filter((model) => {
          if (seen.has(model.id)) return false;
          seen.add(model.id);
          return true;
        }),
      }))
      .filter((group) => group.models.length > 0);
  });
  const modelRows = $derived(groupedModelRows.flatMap((group) => group.models));

  let selectedModelId = $state(agentContext.metadata[theme.activeAgent]?.defaultModel ?? "");

  $effect(() => {
    if (!selectedModelId && modelRows.length > 0) selectedModelId = modelRows[0].id;
  });

  const selectedModelLabel = $derived(
    modelRows.find((m) => m.id === selectedModelId)?.label ?? selectedModelId,
  );

  function selectModelForInstructions(id: string) {
    selectedModelId = id;
    requestInputFocus();
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    { id: "extra-instructions", keywords: ["extra", "instructions", "system", "prompt", "agent", "general", "custom"] },
    { id: "model-instructions", keywords: ["model", "instructions", "system", "prompt", "per-model", "specific", "custom"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));

  // Markdown input styled to match the message composer: accent focus ring and a
  // forced 400 weight so typed text never reads bold. The placeholder is
  // absolutely positioned at left:0.25rem from the border, so the wrapper's
  // px-2.5 (0.625rem) must be added back to line it up with the editor text
  // (0.625rem wrapper pad + 0.25rem ProseMirror pad = 0.875rem).
  const mdFieldClass =
    "rounded-lg border border-border bg-background px-2.5 transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400]";
</script>

<SettingsSection label="Global" visible={isVisible("extra-instructions")}>
  <SettingsRow
    label="Extra instructions"
    description="Appended to the system prompt for every agent run."
  >
    {#snippet body()}
      <PlainTextEditor
        value={theme.extraInstructions}
        onValueChange={(md) => theme.update({ extraInstructions: md })}
        onBlur={() => requestInputFocus()}
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={220}
        dictation
        placeholder="Prefer concise answers. Use specific libraries. Follow my writing style."
        class={mdFieldClass}
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection label="Per model" visible={isVisible("model-instructions")}>
  <SettingsRow
    label="Per-model instructions"
    description="Appended only when this model is running, on top of the extra instructions above."
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger disabled={modelRows.length === 0}>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Model" class="min-w-44 justify-between text-xs shadow-xs">
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
            {#each groupedModelRows as group, i (group.agent.id)}
              {#if groupedModelRows.length > 1}
                {#if i > 0}<DropdownMenu.Separator />{/if}
                <DropdownMenu.GroupHeading>{group.agent.label}</DropdownMenu.GroupHeading>
              {/if}
              {#each group.models as model (model.id)}
                <DropdownMenu.RadioItem value={model.id} onSelect={() => selectModelForInstructions(model.id)}>
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
      <PlainTextEditor
        value={theme.modelInstructions[selectedModelId] ?? ""}
        onValueChange={(md) => theme.update({ modelInstructions: { ...theme.modelInstructions, [selectedModelId]: md } })}
        onBlur={() => requestInputFocus()}
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={220}
        dictation
        placeholder="Instructions that only apply when {selectedModelLabel || 'this model'} is running."
        class={mdFieldClass}
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6">
    No settings match your search
  </div>
{/if}
