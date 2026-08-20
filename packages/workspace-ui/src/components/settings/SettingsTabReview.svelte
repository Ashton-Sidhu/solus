<script lang="ts">
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { MODEL_PROFILES, REASONING_EFFORT_LABELS, projectScopeOf, type AgentId } from "@solus/contracts/types";
  import { getSettingsContext, getAgentContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const session = getWorkspaceContext();
  const projectPath = $derived(projectScopeOf(session.ctx.session));
  const warmingEnabled = $derived(theme.isReviewWarmingEnabled(projectPath));

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

  function selectReviewAgent(id: AgentId) {
    // Switching backend resets the model to that backend's default (its model
    // list is different), mirroring the old ModelPicker coupling. Reasoning also
    // resets, since the level set is model-specific.
    theme.update({ reviewAgent: id, reviewModel: null, reviewReasoning: null });
    requestInputFocus();
  }

  function selectReviewModel(id: string) {
    // Pin the agent the model belongs to. Otherwise, with `reviewAgent` left on
    // "follow active agent", this model id is dropped the moment the active agent
    // changes provider — which is how a Claude model ended up "selected" while
    // codex actually ran. Reasoning levels differ per model, so clear that too.
    theme.update({ reviewAgent: reviewAgentId, reviewModel: id, reviewReasoning: null });
    requestInputFocus();
  }

  function selectReviewReasoning(id: (typeof reviewReasoningLevels)[number]) {
    theme.update({ reviewReasoning: id });
    requestInputFocus();
  }

  function setWarmingEnabled(enabled: boolean) {
    theme.setReviewWarmingEnabled(projectPath, enabled);
    const api = session.apiForContext(session.ctx);
    void session.prsStore
      .refreshNeedsReview(api, session.serverIdForContext(session.ctx), session.ctx)
      .catch(() => {});
    requestInputFocus();
  }

  function setGenerateOnOpen(enabled: boolean) {
    theme.update({ generatePrGuidesOnOpen: enabled });
    requestInputFocus();
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    { id: "review-generate-on-open", keywords: ["review", "guide", "generate", "open", "automatic", "agent"] },
    { id: "review-warming", keywords: ["review", "guide", "warm", "background", "prefetch", "worktree"] },
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

<SettingsSection
  label="Automation"
  visible={["review-generate-on-open", "review-warming"].some(isVisible)}
>
  <SettingsRow
    label="Generate PR guides on open"
    description="Run the review agent when an opened PR has no cached guide."
    visible={isVisible("review-generate-on-open")}
  >
    {#snippet control()}
      <Switch
        checked={theme.generatePrGuidesOnOpen}
        onCheckedChange={setGenerateOnOpen}
        aria-label="Generate PR review guides when opened"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Warm review guides"
    description="Generate guides and prefetch top PR worktrees for this project."
    visible={isVisible("review-warming")}
  >
    {#snippet control()}
      <Switch
        checked={warmingEnabled}
        onCheckedChange={setWarmingEnabled}
        aria-label="Warm review guides for this project"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Model"
  visible={["review-agent", "review-model", "review-reasoning"].some(isVisible)}
>
  <SettingsRow
    label="Review companion agent"
    description="Which agent reviews the diff for the code-review companion."
    visible={isVisible("review-agent")}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Review companion agent" class="min-w-24 justify-between text-xs shadow-xs">
              <span class="truncate">{reviewAgentLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[176px]">
          <DropdownMenu.RadioGroup value={reviewAgentId}>
            {#each reviewAgentRows as agent (agent.id)}
              <DropdownMenu.RadioItem value={agent.id} onSelect={() => selectReviewAgent(agent.id)}><span class="truncate">{agent.label}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Review companion model"
    description="Model the review agent uses."
    visible={isVisible("review-model")}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger disabled={reviewModels.length === 0}>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Review companion model" class="min-w-24 justify-between text-xs shadow-xs">
              <span class="truncate">{reviewModelLabel || "Default"}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[200px]">
          <DropdownMenu.RadioGroup value={reviewModelId}>
            {#each reviewModels as model (model.id)}
              <DropdownMenu.RadioItem value={model.id} onSelect={() => selectReviewModel(model.id)}><span class="truncate">{model.label}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Review companion reasoning"
    description="Reasoning effort the review agent uses."
    visible={isVisible("review-reasoning")}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger disabled={reviewReasoningLevels.length === 0}>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Review companion reasoning" class="min-w-24 justify-between text-xs shadow-xs">
              <span class="truncate">{reviewReasoningLabel || "Default"}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[176px]">
          <DropdownMenu.RadioGroup value={reviewReasoningId}>
            {#each reviewReasoningLevels as level (level)}
              <DropdownMenu.RadioItem value={level} onSelect={() => selectReviewReasoning(level)}><span class="truncate">{REASONING_EFFORT_LABELS[level]}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6">
    No settings match your search
  </div>
{/if}
