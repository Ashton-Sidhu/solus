<script lang="ts">
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import {
    CheckIcon,
    CaretDownIcon,
    RobotIcon,
    SparkleIcon,
    GaugeIcon,
  } from "phosphor-svelte";
  import { MODEL_PROFILES, REASONING_EFFORT_LABELS } from "../../../shared/types";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();

  let reviewAgentTriggerEl: HTMLButtonElement | null = $state(null);
  let reviewModelTriggerEl: HTMLButtonElement | null = $state(null);
  let reviewReasoningTriggerEl: HTMLButtonElement | null = $state(null);
  let reviewAgentOpen = $state(false);
  let reviewModelOpen = $state(false);
  let reviewReasoningOpen = $state(false);

  // The review companion's agent/model/reasoning. `reviewAgent`/`reviewModel`/
  // `reviewReasoning` are overrides — null means "follow the active agent / that
  // agent's default model / that model's default reasoning effort".
  const reviewAgentId = $derived(theme.reviewAgent ?? theme.activeAgent);
  const reviewAgentMeta = $derived(agentContext.metadata[reviewAgentId] ?? null);
  const reviewAgentLabel = $derived(reviewAgentMeta?.label ?? reviewAgentId);
  const reviewModels = $derived(reviewAgentMeta?.models ?? []);
  // Only honor the stored model override when it belongs to the resolved agent —
  // otherwise a stale cross-provider id (e.g. a Claude model under codex) would
  // display while the run silently falls back to the agent default.
  const reviewModelId = $derived(
    theme.reviewModel && reviewModels.some((m) => m.id === theme.reviewModel)
      ? theme.reviewModel
      : reviewAgentMeta?.defaultModel ?? reviewModels[0]?.id ?? "",
  );
  const reviewModelLabel = $derived(
    reviewModels.find((m) => m.id === reviewModelId)?.label ?? reviewModelId,
  );
  const reviewAgentRows = $derived(
    agentContext.agents.filter((a) => a.available !== false),
  );

  // Reasoning levels are model-specific (sourced from MODEL_PROFILES), so the
  // available options change with the selected agent/model.
  const reviewModelProfile = $derived(MODEL_PROFILES[reviewAgentId]?.[reviewModelId]);
  const reviewReasoningLevels = $derived(reviewModelProfile?.reasoningLevels ?? []);
  const reviewReasoningId = $derived(
    theme.reviewReasoning && reviewReasoningLevels.includes(theme.reviewReasoning)
      ? theme.reviewReasoning
      : reviewModelProfile?.defaultReasoningEffort ?? reviewReasoningLevels[0] ?? "",
  );
  const reviewReasoningLabel = $derived(
    reviewReasoningId ? REASONING_EFFORT_LABELS[reviewReasoningId] : "",
  );

  function selectReviewAgent(id: string) {
    // Switching backend resets the model to that backend's default (its model
    // list is different), mirroring the old ModelPicker coupling. Reasoning also
    // resets, since the level set is model-specific.
    theme.update({ reviewAgent: id as typeof theme.activeAgent, reviewModel: null, reviewReasoning: null });
    reviewAgentOpen = false;
    requestInputFocus();
  }

  function selectReviewModel(id: string) {
    // Pin the agent the model belongs to. Otherwise, with `reviewAgent` left on
    // "follow active agent", this model id is dropped the moment the active agent
    // changes provider — which is how a Claude model ended up "selected" while
    // codex actually ran. Reasoning levels differ per model, so clear that too.
    theme.update({ reviewAgent: reviewAgentId, reviewModel: id, reviewReasoning: null });
    reviewModelOpen = false;
    requestInputFocus();
  }

  function selectReviewReasoning(id: (typeof reviewReasoningLevels)[number]) {
    theme.update({ reviewReasoning: id });
    reviewReasoningOpen = false;
    requestInputFocus();
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    { id: "review-agent", keywords: ["review", "companion", "agent", "code review", "backend", "claude", "codex"] },
    { id: "review-model", keywords: ["review", "companion", "model", "code review", "llm"] },
    { id: "review-reasoning", keywords: ["review", "companion", "reasoning", "effort", "thinking", "code review"] },
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

<div class="flex flex-col">
  {#if isVisible("review-agent")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <RobotIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Review companion agent</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Which agent reviews the diff for the code-review companion</div>
        </div>
      </div>
      <div>
        <button
          bind:this={reviewAgentTriggerEl}
          type="button"
          aria-label="Review companion agent"
          aria-haspopup="menu"
          aria-expanded={reviewAgentOpen}
          onclick={() => { reviewAgentOpen = !reviewAgentOpen }}
          class="flex items-center justify-between gap-1.5 min-h-8 min-w-24 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-secondary) px-2.5 text-[0.8125rem] outline-none [transition:border-color_var(--duration-base)_var(--ease-premium),box-shadow_var(--duration-base)_var(--ease-premium),color_var(--duration-base)_var(--ease-premium)] hover:text-(--solus-text-primary) hover:border-(--solus-input-focus-border) focus-visible:text-(--solus-text-primary) focus-visible:border-(--solus-input-focus-border) focus-visible:shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)]"
        >
          <span class="truncate">{reviewAgentLabel}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <Dropdown bind:open={reviewAgentOpen} triggerEl={reviewAgentTriggerEl} align="top" anchor="right" width={176}>
          <div class="py-1">
            {#each reviewAgentRows as agent (agent.id)}
              <DropdownItem selected={agent.id === reviewAgentId} onclick={() => selectReviewAgent(agent.id)}>
                <span class="truncate">{agent.label}</span>
                {#if agent.id === reviewAgentId}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </div>
  {/if}

  {#if isVisible("review-model")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <SparkleIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Review companion model</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Model the review agent uses</div>
        </div>
      </div>
      <div>
        <button
          bind:this={reviewModelTriggerEl}
          type="button"
          aria-label="Review companion model"
          aria-haspopup="menu"
          aria-expanded={reviewModelOpen}
          disabled={reviewModels.length === 0}
          onclick={() => { reviewModelOpen = !reviewModelOpen }}
          class="flex items-center justify-between gap-1.5 min-h-8 min-w-24 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-secondary) px-2.5 text-[0.8125rem] outline-none [transition:border-color_var(--duration-base)_var(--ease-premium),box-shadow_var(--duration-base)_var(--ease-premium),color_var(--duration-base)_var(--ease-premium)] hover:text-(--solus-text-primary) hover:border-(--solus-input-focus-border) focus-visible:text-(--solus-text-primary) focus-visible:border-(--solus-input-focus-border) focus-visible:shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)] disabled:opacity-50"
        >
          <span class="truncate">{reviewModelLabel || "Default"}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <Dropdown bind:open={reviewModelOpen} triggerEl={reviewModelTriggerEl} align="top" anchor="right" width={200}>
          <div class="py-1">
            {#each reviewModels as model (model.id)}
              <DropdownItem selected={model.id === reviewModelId} onclick={() => selectReviewModel(model.id)}>
                <span class="truncate">{model.label}</span>
                {#if model.id === reviewModelId}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </div>
  {/if}

  {#if isVisible("review-reasoning")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <GaugeIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Review companion reasoning</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Reasoning effort the review agent uses</div>
        </div>
      </div>
      <div>
        <button
          bind:this={reviewReasoningTriggerEl}
          type="button"
          aria-label="Review companion reasoning"
          aria-haspopup="menu"
          aria-expanded={reviewReasoningOpen}
          disabled={reviewReasoningLevels.length === 0}
          onclick={() => { reviewReasoningOpen = !reviewReasoningOpen }}
          class="flex items-center justify-between gap-1.5 min-h-8 min-w-24 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-secondary) px-2.5 text-[0.8125rem] outline-none [transition:border-color_var(--duration-base)_var(--ease-premium),box-shadow_var(--duration-base)_var(--ease-premium),color_var(--duration-base)_var(--ease-premium)] hover:text-(--solus-text-primary) hover:border-(--solus-input-focus-border) focus-visible:text-(--solus-text-primary) focus-visible:border-(--solus-input-focus-border) focus-visible:shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)] disabled:opacity-50"
        >
          <span class="truncate">{reviewReasoningLabel || "Default"}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <Dropdown bind:open={reviewReasoningOpen} triggerEl={reviewReasoningTriggerEl} align="top" anchor="right" width={176}>
          <div class="py-1">
            {#each reviewReasoningLevels as level (level)}
              <DropdownItem selected={level === reviewReasoningId} onclick={() => selectReviewReasoning(level)}>
                <span class="truncate">{REASONING_EFFORT_LABELS[level]}</span>
                {#if level === reviewReasoningId}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </div>
  {/if}

  {#if !anyVisible}
    <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No settings match your search
    </div>
  {/if}
</div>
