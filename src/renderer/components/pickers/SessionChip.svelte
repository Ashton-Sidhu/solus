<script lang="ts">
  import { CaretDownIcon, CodeIcon, SpinnerGapIcon } from "phosphor-svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "./OpenAIBlossom.svelte";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from "../../contexts";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { REASONING_EFFORT_LABELS, type ReasoningEffort, type AgentId } from "../../../shared/types";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    clampReasoningEffort,
    defaultModelIdFor,
    modelOptionsFor,
    reasoningLevelsFor,
    type PickerSelection,
  } from "./lib/picker-selection";

  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const statusBar = getStatusBarContext();

  interface Props {
    tabId?: string;
    /** Detached mode: the chip reads and mutates this local selection in place
     *  and never touches the session's model config or active agent. The host
     *  applies the choice at dispatch. */
    selection?: PickerSelection;
    /** Detached mode only — unlock the agent submenu (the dispatch target is a
     *  new or reset session, so switching backends is safe). */
    allowAgentSwitch?: boolean;
    menuSide?: "top" | "bottom";
    /** Compact trigger for the embedded composer — smaller glyph, text, height. */
    dense?: boolean;
  }
  let { tabId, selection = $bindable(), allowAgentSwitch = false, menuSide = "top", dense = false }: Props = $props();

  const detached = $derived(selection !== undefined);

  const ctx = $derived(statusBar.ctxFor(tabId ?? session.activeTabId));
  const sess = $derived(session.sessionFor(tabId ?? session.activeTabId));
  // A detached chip edits a local draft, so a busy session never locks it.
  const isBusy = $derived(
    !detached && (sess?.status === "running" || sess?.status === "connecting"),
  );
  const handoffInProgress = $derived(!detached && session.handoffInProgress);
  // Agent switching flips app-global state (active agent, default model
  // config), so a split-scoped chip never offers it.
  const isAgentLocked = $derived(
    detached
      ? !allowAgentSwitch
      : tabId !== undefined || isBusy || handoffInProgress,
  );

  const activeAgent = $derived(selection?.provider ?? ctx.activeAgent);

  // Model
  const modelMeta = $derived(
    agentContext.metadata[activeAgent] ?? (detached ? null : agentContext.activeMetadata),
  );
  const models = $derived(
    detached ? modelOptionsFor(activeAgent, agentContext.metadata) : (modelMeta?.models ?? []),
  );
  const defaultModel = $derived(modelMeta?.defaultModel ?? models[0]?.id ?? null);
  const currentModelId = $derived(
    selection ? (selection.modelId ?? defaultModel) : (ctx.model || defaultModel),
  );
  const modelLabel = $derived(
    models.find((m) => m.id === currentModelId)?.label ?? currentModelId ?? "",
  );

  // Reasoning — the primary knob, surfaced inline in the chip + menu root.
  const reasoningEffort = $derived(selection?.reasoningEffort ?? ctx.reasoningEffort);
  const reasoningLevels = $derived(
    detached ? reasoningLevelsFor(activeAgent, currentModelId) : ctx.reasoningLevels,
  );
  const reasoningLabel = $derived(REASONING_EFFORT_LABELS[reasoningEffort] ?? "High");

  // Agent
  const agentRows = $derived(
    buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata).filter(
      (a) => a.enabled,
    ),
  );
  const agentName = $derived(agentLabel(activeAgent, agentContext.metadata));

  // Leading brand glyph on the chip — Claude's starburst for claude-code, the
  // OpenAI mark for codex, a generic code glyph otherwise.
  const isClaude = $derived(activeAgent === "claude-code");
  const isCodex = $derived(activeAgent === "codex");

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);

  function openFromShortcut(targetTabId?: string) {
    // The shortcut targets the input bar's session-mutating chip, never a
    // detached composer copy.
    if (detached) return;
    const chipTabId = tabId ?? session.activeTabId;
    if (
      targetTabId === undefined
        ? tabId !== undefined
        : targetTabId !== chipTabId
    )
      return;
    if (isBusy || handoffInProgress) return;
    // Both the editor- and pill-mode layouts stay mounted, so two SessionChips
    // receive this shortcut. Only the one in the visible layout should open
    // (a display:none ancestor reports offsetParent === null).
    if (triggerEl && triggerEl.offsetParent === null) return;
    open = true;
  }

  function selectReasoning(effort: ReasoningEffort) {
    if (selection) {
      selection.reasoningEffort = effort;
      return;
    }
    session.updateModelConfig({ reasoningEffort: effort }, tabId);
  }
  function selectModel(modelId: string) {
    if (selection) {
      selection.modelId = modelId;
      selection.reasoningEffort = clampReasoningEffort(selection.provider, modelId, selection.reasoningEffort);
      return;
    }
    session.updateModelConfig({ modelId }, tabId);
  }
  function selectAgent(id: AgentId) {
    if (selection) {
      const modelId = defaultModelIdFor(id, agentContext.metadata);
      selection.provider = id;
      selection.modelId = modelId;
      selection.reasoningEffort = clampReasoningEffort(id, modelId, selection.reasoningEffort);
      return;
    }
    void session.switchActiveAgent(id);
  }

  $effect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      openFromShortcut(detail?.tabId);
    };
    window.addEventListener("solus:toggle-session-settings-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-settings-picker", handler);
  });
</script>

<DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next && !detached && tabId === undefined) requestInputFocus() }}>
  <DropdownMenu.Trigger disabled={isBusy || handoffInProgress} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <button {...props} type="button" class="flex items-center min-w-0 rounded-full transition-[background-color,color,scale] text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) {dense ? 'h-6 gap-1 pl-0.5 pr-1.5 text-[0.75rem]' : 'h-8 gap-1.5 pl-1 pr-2 text-[0.8125rem]'}" style="cursor:{isBusy || handoffInProgress ? 'not-allowed' : 'pointer'}" use:tooltip={open ? null : handoffInProgress ? "Session handoff in progress" : isBusy ? "Stop the task to change session settings" : "Session settings"}>
        <span
          class={`flex flex-shrink-0 items-center justify-center rounded-full ${dense ? "h-5 w-5" : "h-6 w-6"} ${isCodex ? "bg-white" : "bg-(--solus-accent-light) text-(--solus-accent)"}`}
        >
          {#if isClaude}
            <ClaudeIcon size={dense ? 12 : 14} />
          {:else if isCodex}
            <OpenAIBlossom size={dense ? 12 : 14} />
          {:else}
            <CodeIcon size={dense ? 12 : 14} class="flex-shrink-0" />
          {/if}
        </span>
        {#if handoffInProgress}
          <span class="flex min-w-0 items-center gap-1 font-medium text-(--solus-text-tertiary)">
            <SpinnerGapIcon size={dense ? 10 : 11} class="flex-shrink-0 animate-spin motion-reduce:animate-none" />
            <span class="truncate">Handing off…</span>
          </span>
        {:else}
          <span class="truncate max-w-28 font-medium text-(--solus-text-primary)">{modelLabel}</span>
          <span class="flex-shrink-0 text-(--solus-text-tertiary)">{reasoningLabel}</span>
          <CaretDownIcon size={dense ? 10 : 11} style="opacity:0.6" />
        {/if}
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side={menuSide} align="end" sideOffset={6} class="w-[236px] overflow-visible">
    <DropdownMenu.Group>
      <DropdownMenu.GroupHeading>Reasoning</DropdownMenu.GroupHeading>
      <DropdownMenu.RadioGroup value={reasoningEffort}>
        {#each reasoningLevels as level (level)}
          <DropdownMenu.RadioItem value={level} onSelect={() => selectReasoning(level)}>{REASONING_EFFORT_LABELS[level] ?? level}</DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
    <DropdownMenu.Separator />
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger><span class="flex-1">Model</span><span class="truncate text-(--solus-text-tertiary)">{modelLabel}</span></DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="w-[208px]">
        <DropdownMenu.RadioGroup value={currentModelId ?? undefined}>
          <DropdownMenu.GroupHeading>Model</DropdownMenu.GroupHeading>
          {#each models as model (model.id)}
            <DropdownMenu.RadioItem value={model.id} onSelect={() => selectModel(model.id)}>{model.label}</DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger disabled={isAgentLocked} title={isAgentLocked ? "Agent is fixed for this session" : undefined}><span class="flex-1">Agent</span><span class="truncate text-(--solus-text-tertiary)">{agentName}</span></DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="w-[208px]">
        <DropdownMenu.RadioGroup value={activeAgent}>
          <DropdownMenu.GroupHeading>Agent</DropdownMenu.GroupHeading>
          {#each agentRows as agent (agent.id)}
            <DropdownMenu.RadioItem value={agent.id} onSelect={() => selectAgent(agent.id)}>{agent.label}</DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  </DropdownMenu.Content>
</DropdownMenu.Root>
