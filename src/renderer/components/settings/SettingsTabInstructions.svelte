<script lang="ts">
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { CaretDownIcon, NotePencilIcon } from "phosphor-svelte";
  import { getAgentContext, getSettingsContext } from "../../contexts";
  import { buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { requestInputFocus } from "../../lib/inputFocus";

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

  let modelInstructionsOpen = $state(false);
  let selectedModelId = $state(agentContext.metadata[theme.activeAgent]?.defaultModel ?? "");

  $effect(() => {
    if (!selectedModelId && modelRows.length > 0) selectedModelId = modelRows[0].id;
  });

  const selectedModelLabel = $derived(
    modelRows.find((m) => m.id === selectedModelId)?.label ?? selectedModelId,
  );

  function selectModelForInstructions(id: string) {
    selectedModelId = id;
    modelInstructionsOpen = false;
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

  // Markdown input styled to match the message composer: transparent field,
  // accent focus ring, and a forced 400 weight so typed text never reads bold.
  // The placeholder is absolutely positioned at left:0.25rem from the border,
  // so the wrapper's px-2.5 (0.625rem) must be added back to line it up with the
  // editor text (0.625rem wrapper pad + 0.25rem ProseMirror pad = 0.875rem).
  const mdFieldClass =
    "rounded-lg border border-(--solus-container-border) bg-transparent px-2.5 transition-colors focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.solus-md-editor_.ProseMirror]:![min-height:4.5rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![left:0.875rem]";
</script>

<div class="flex flex-col">
  {#if isVisible("extra-instructions")}
    <div class="flex flex-col gap-3 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <NotePencilIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Extra instructions</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Appended to the system prompt for every agent run</div>
        </div>
      </div>
      <MarkdownEditor
        value={theme.extraInstructions}
        onValueChange={(md) => theme.update({ extraInstructions: md })}
        onBlur={() => requestInputFocus()}
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={220}
        placeholder="Prefer concise answers. Use specific libraries. Follow my writing style."
        class={mdFieldClass}
      />
    </div>
  {/if}

  {#if isVisible("model-instructions")}
    <div class="flex flex-col gap-3 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <NotePencilIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
          <div>
            <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Per-model instructions</div>
            <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Appended only when this model is running, on top of the extra instructions above</div>
          </div>
        </div>
        <DropdownMenu.Root bind:open={modelInstructionsOpen} onOpenChange={(next) => { if (!next) requestInputFocus() }}>
          <DropdownMenu.Trigger disabled={modelRows.length === 0}>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                aria-label="Model"
                class="flex items-center justify-between gap-1.5 min-h-8 min-w-44 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-secondary) px-2.5 text-[0.8125rem] outline-none [transition:border-color_var(--duration-base)_var(--ease-premium),box-shadow_var(--duration-base)_var(--ease-premium),color_var(--duration-base)_var(--ease-premium)] hover:text-(--solus-text-primary) hover:border-(--solus-input-focus-border) focus-visible:text-(--solus-text-primary) focus-visible:border-(--solus-input-focus-border) focus-visible:shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)] disabled:opacity-50"
              >
                <span class="flex items-center gap-1.5 min-w-0">
                  {#if theme.modelInstructions[selectedModelId]?.trim()}
                    <span class="w-1.5 h-1.5 rounded-full bg-(--solus-accent) shrink-0"></span>
                  {/if}
                  <span class="truncate">{selectedModelLabel || "Select model"}</span>
                </span>
                <CaretDownIcon size={11} style="opacity:0.6" />
              </button>
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
                    <span class="flex items-center gap-1.5 min-w-0">
                      {#if theme.modelInstructions[model.id]?.trim()}
                        <span class="w-1.5 h-1.5 rounded-full bg-(--solus-accent) shrink-0"></span>
                      {/if}
                      <span class="truncate">{model.label}</span>
                    </span>
                  </DropdownMenu.RadioItem>
                {/each}
              {/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <MarkdownEditor
        value={theme.modelInstructions[selectedModelId] ?? ""}
        onValueChange={(md) => theme.update({ modelInstructions: { ...theme.modelInstructions, [selectedModelId]: md } })}
        onBlur={() => requestInputFocus()}
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={220}
        placeholder="Instructions that only apply when {selectedModelLabel || 'this model'} is running."
        class={mdFieldClass}
      />
    </div>
  {/if}

  {#if !anyVisible}
    <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No settings match your search
    </div>
  {/if}
</div>
