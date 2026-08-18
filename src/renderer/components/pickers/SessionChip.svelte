<script lang="ts">
  import { CaretDownIcon, CheckIcon, CodeIcon, SpinnerGapIcon } from "phosphor-svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "./OpenAIBlossom.svelte";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from "../../contexts";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import {
    REASONING_EFFORT_LABELS,
    type AgentMetadata,
    type ReasoningEffort,
    type AgentId,
  } from "../../../shared/types";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { cn } from "@renderer/lib/tw";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { MenuFooter } from "../ui/menu";
  import {
    clampReasoningEffort,
    defaultModelIdFor,
    defaultReasoningFor,
    modelPickerNavigationTarget,
    modelOptionsFor,
    reasoningLevelsFor,
    type ModelPickerColumn,
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
    /** This chip is the workspace composer's, so the shortcut targets it and
     *  dismissing returns focus there. */
    isPrimary?: boolean;
    menuSide?: "top" | "bottom";
    /** Model-only settings still use the shared provider/model picker, but do
     *  not expose reasoning effort that their setting cannot persist. */
    modelOnly?: boolean;
    /** Host-scoped metadata can differ from the active workspace host. */
    agents?: AgentMetadata[];
    disabled?: boolean;
    ariaLabel?: string;
    returnFocusOnClose?: boolean;
    /** Detached composers can return focus to their own editor instead of the
     *  workspace input bar. */
    onReturnFocus?: () => void;
    /** Extra trigger classes, for call sites that must align several chips on a
     *  shared width instead of letting each shrink-wrap its own label. */
    class?: string;
    onSelectionChange?: (selection: PickerSelection) => void;
  }
  let {
    tabId,
    selection = $bindable(),
    isPrimary = false,
    menuSide = "top",
    modelOnly = false,
    agents,
    disabled = false,
    ariaLabel = "Session settings",
    returnFocusOnClose = false,
    onReturnFocus,
    class: className,
    onSelectionChange,
  }: Props = $props();

  const detached = $derived(selection !== undefined);

  // No fallback to the active tab: a composer with no session of its own edits
  // a `selection`, and must not read or write whichever session is on screen.
  const ctx = $derived(statusBar.ctxFor(tabId ?? ""));
  const sess = $derived(tabId ? session.sessionFor(tabId) : undefined);
  // A detached chip edits a local draft, so a busy session never locks it.
  const isBusy = $derived(
    !detached && (sess?.status === "running" || sess?.status === "connecting"),
  );
  const handoffInProgress = $derived(!detached && session.handoffInProgress);

  const activeAgent = $derived(selection?.provider ?? ctx.activeAgent);

  const metadata = $derived.by(() => {
    if (!agents) return agentContext.metadata;
    const entries = agents.map((agent) => [agent.id, agent] as const);
    return Object.fromEntries(entries);
  });

  // Model
  const modelMeta = $derived(
    metadata[activeAgent] ?? (detached ? null : agentContext.activeMetadata),
  );
  const models = $derived(
    modelOnly && modelMeta?.available === false
      ? []
      : detached
        ? modelOptionsFor(activeAgent, metadata)
        : (modelMeta?.models ?? []),
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

  // Agent. Unavailable agents stay on the list, disabled: dropping them left the
  // flyout blank whenever a binary probe came back empty, with nothing on screen
  // to say why there was nothing to pick.
  const agentRows = $derived(
    buildAgentAvailabilityRows(agents ?? agentContext.agents, metadata),
  );
  const agentName = $derived(agentLabel(activeAgent, metadata));

  // Leading brand glyph on the chip — Claude's starburst for claude-code, the
  // OpenAI mark for codex, a generic code glyph otherwise.
  const isClaude = $derived(activeAgent === "claude-code");
  const isCodex = $derived(activeAgent === "codex");

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let contentEl: HTMLElement | null = $state(null);

  // Hovering a model previews the effort that picking it would land on, so the
  // consequence of the choice is visible before committing to it. The preview
  // survives the trip across the divider (see the Content pointerleave), which
  // is what lets a click in the Reasoning column apply the pair in one go.
  let hoveredModelId: string | null = $state(null);
  let hoveredLevel: ReasoningEffort | null = $state(null);
  const previewModelLabel = $derived(
    hoveredModelId ? (models.find((m) => m.id === hoveredModelId)?.label ?? null) : null,
  );
  const previewReasoning = $derived(
    hoveredModelId && hoveredModelId !== currentModelId
      ? defaultReasoningFor(activeAgent, hoveredModelId)
      : null,
  );
  // The right column tracks whatever model is under the cursor — otherwise the
  // preview check can land on a level that model doesn't offer.
  const shownReasoningLevels = $derived(
    hoveredModelId ? reasoningLevelsFor(activeAgent, hoveredModelId) : reasoningLevels,
  );
  // Models offer different numbers of levels (Haiku 4, Sonnet 5, Opus 7), so the
  // column is held at the deepest set on offer. Without the reservation the menu
  // resizes — and, being top-anchored, repositions — under the cursor on every
  // model you pass over.
  const reservedLevelRows = $derived(
    models.reduce(
      (deepest, model) =>
        Math.max(deepest, reasoningLevelsFor(activeAgent, model.id).length),
      reasoningLevels.length,
    ),
  );

  function openFromShortcut(targetTabId?: string) {
    // The shortcut targets the input bar's session-mutating chip, never a
    // detached composer copy.
    if (detached) return;
    // Unaddressed, the shortcut means the workspace's own chip; addressed, the
    // chip standing for that tab.
    if (targetTabId === undefined ? !isPrimary : targetTabId !== tabId) return;
    if (isBusy || handoffInProgress) return;
    // Both the editor- and pill-mode layouts stay mounted, so two SessionChips
    // receive this shortcut. Only the one in the visible layout should open
    // (a display:none ancestor reports offsetParent === null).
    if (triggerEl && triggerEl.offsetParent === null) return;
    open = true;
  }

  // Clicking a level commits the previewed model with it — the levels on offer
  // are that model's own, so no clamping is needed. The model patch has to ride
  // along in the same call: updateModelConfig's model branch would otherwise
  // overwrite the effort with the model's default.
  function selectReasoning(effort: ReasoningEffort) {
    const pendingModelId =
      hoveredModelId && hoveredModelId !== currentModelId ? hoveredModelId : null;
    if (selection) {
      if (pendingModelId) selection.modelId = pendingModelId;
      selection.reasoningEffort = effort;
      onSelectionChange?.(selection);
      return;
    }
    session.updateModelConfig(
      pendingModelId ? { modelId: pendingModelId, reasoningEffort: effort } : { reasoningEffort: effort },
      tabId,
    );
  }
  function selectModel(modelId: string) {
    hoveredModelId = null;
    if (selection) {
      selection.modelId = modelId;
      selection.reasoningEffort = clampReasoningEffort(selection.provider, modelId, selection.reasoningEffort);
      onSelectionChange?.(selection);
      return;
    }
    session.updateModelConfig({ modelId }, tabId);
  }
  function selectAgent(id: AgentId) {
    if (selection) {
      const modelId = defaultModelIdFor(id, metadata);
      selection.provider = id;
      selection.modelId = modelId;
      selection.reasoningEffort = clampReasoningEffort(id, modelId, selection.reasoningEffort);
      onSelectionChange?.(selection);
      return;
    }
    void session.switchActiveAgent(id, tabId);
  }

  function handleCloseAutoFocus(event: Event) {
    if (detached && !returnFocusOnClose && !onReturnFocus) return;
    event.preventDefault();
    if (onReturnFocus) onReturnFocus();
    else requestInputFocus({ tabId });
  }

  function pickerItems(column: ModelPickerColumn): HTMLElement[] {
    return contentEl
      ? Array.from(
          contentEl.querySelectorAll<HTMLElement>(
            `[data-picker-column="${column}"]`,
          ),
        )
      : [];
  }

  function handlePickerKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const focusedItem =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-picker-column]")
        : null;
    const pickerColumn = focusedItem?.dataset.pickerColumn;
    const column: ModelPickerColumn | undefined =
      pickerColumn === "model" || pickerColumn === "reasoning" ? pickerColumn : undefined;
    if (!focusedItem || !column) return;

    const columnItems = pickerItems(column);
    const index = columnItems.indexOf(focusedItem);
    if (index === -1) return;

    const oppositeColumn: ModelPickerColumn =
      column === "model" ? "reasoning" : "model";
    const oppositeItems = pickerItems(oppositeColumn);
    const preferredValue =
      oppositeColumn === "reasoning"
        ? (previewReasoning ?? reasoningEffort)
        : (hoveredModelId ?? currentModelId);
    const preferredOppositeIndex = Math.max(
      0,
      oppositeItems.findIndex(
        (item) => item.dataset.pickerValue === preferredValue,
      ),
    );
    const destination = modelPickerNavigationTarget({
      key: event.key,
      column,
      index,
      columnLength: columnItems.length,
      oppositeColumnLength: oppositeItems.length,
      preferredOppositeIndex,
    });
    if (!destination) return;

    event.preventDefault();
    event.stopPropagation();
    pickerItems(destination.column)[destination.index]?.focus();
  }

  $effect(() => {
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      openFromShortcut(detail?.tabId);
    };
    window.addEventListener("solus:toggle-session-settings-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-settings-picker", handler);
  });
</script>

<DropdownMenu.Root bind:open onOpenChange={() => { hoveredModelId = null; hoveredLevel = null; }}>
  <DropdownMenu.Trigger disabled={disabled || isBusy || handoffInProgress} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <!-- Same shell as the permission picker, never merged with it: mode
                 and model are two decisions, so they are two hit targets. The
                 brand mark is the model's category glyph and carries the only
                 accent on the control. -->
            <button {...tooltipProps} {...props} type="button" aria-label={ariaLabel} class={cn("flex h-[1.875rem] min-w-0 items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) px-2.5 font-secondary text-sm text-(--solus-text-secondary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)", open && "bg-(--solus-surface-hover)", className)} style="cursor:{disabled || isBusy || handoffInProgress ? 'not-allowed' : 'pointer'}">
        <!-- Codex's mark is solid black, so it keeps a white plate to stay
             legible in dark mode; the others take the accent directly. -->
        <span
          class="flex flex-shrink-0 items-center justify-center text-(--solus-accent) {isCodex
            ? 'h-5 w-5 rounded-full bg-white'
            : ''}"
        >
          {#if isClaude}
            <ClaudeIcon size={13} />
          {:else if isCodex}
            <OpenAIBlossom size={13} />
          {:else}
            <CodeIcon size={13} class="flex-shrink-0" />
          {/if}
        </span>
        {#if handoffInProgress}
          <span class="flex min-w-0 items-center gap-1 font-medium text-(--solus-text-tertiary)">
            <SpinnerGapIcon size={11} class="flex-shrink-0 animate-spin motion-reduce:animate-none" />
            <span class="truncate">Handing off…</span>
          </span>
        {:else}
          <span class="truncate max-w-48 font-medium text-(--solus-text-primary)">{modelOnly ? `${agentName} · ${modelLabel}` : modelLabel}</span>
          {#if !modelOnly}
            <span class="flex-shrink-0 text-(--solus-text-tertiary)">{reasoningLabel}</span>
          {/if}
          <!-- ml-auto is inert while the chip shrink-wraps; it only bites when a
               call site sets a width floor, keeping the caret on the edge. -->
          <CaretDownIcon size={9} class="ml-auto text-(--solus-text-tertiary) transition-transform duration-150 {open ? 'rotate-180' : ''}" />
        {/if}
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={open ? null : handoffInProgress ? "Session handoff in progress" : isBusy ? "Stop the task to change session settings" : ariaLabel} />
      </TooltipUI.Root>
    {/snippet}
  </DropdownMenu.Trigger>
  <!-- Model and effort are one decision, so they sit side by side instead of
       behind a flyout: hovering a model previews the effort it lands on. -->
  <!-- overflow-visible: the Agent sub-content renders inside this element
       rather than a portal, so a clipping surface would cut the flyout off. -->
  <DropdownMenu.Content
    bind:ref={contentEl}
    side={menuSide}
    align="end"
    sideOffset={6}
    class={modelOnly ? "w-[344px] overflow-visible p-0" : "w-[452px] overflow-visible p-0"}
    onCloseAutoFocus={handleCloseAutoFocus}
    onkeydown={handlePickerKeyDown}
    onpointerleave={() => {
      hoveredModelId = null;
      hoveredLevel = null;
    }}
  >
    <div class="flex items-stretch">
      <div class="min-w-0 flex-1 p-1.5">
        <!-- The preview clears on the way out of the whole surface, never on a
             row: row-level leave/enter pairs flash the column back to the
             current model between every two rows you sweep across, and clearing
             at the column edge would drop the pending model on the walk to the
             level you're about to click. -->
        <DropdownMenu.RadioGroup value={currentModelId ?? undefined}>
          <DropdownMenu.GroupHeading>Model</DropdownMenu.GroupHeading>
          {#each models as model (model.id)}
            <DropdownMenu.RadioItem
              value={model.id}
              data-picker-column="model"
              data-picker-value={model.id}
              onSelect={() => selectModel(model.id)}
              onfocus={() => {
                hoveredModelId = model.id;
                hoveredLevel = null;
              }}
              onpointerenter={() => {
                hoveredModelId = model.id;
                // Back in the model column the level under the cursor is stale —
                // the footer would advertise a pair that isn't on offer.
                hoveredLevel = null;
              }}
            >
              <span class="min-w-0 flex-1 truncate">{model.label}</span>
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </div>

      {#if !modelOnly}
        <div class="w-px shrink-0 bg-(--solus-menu-hairline)"></div>

        <div class="flex w-[184px] shrink-0 flex-col p-1.5">
          <DropdownMenu.RadioGroup value={previewReasoning ? undefined : reasoningEffort}>
            <DropdownMenu.GroupHeading>Reasoning</DropdownMenu.GroupHeading>
            <div style="min-height:{reservedLevelRows * 2}rem">
              {#each shownReasoningLevels as level (level)}
                <!-- No entry stagger: this list re-renders as the cursor moves down
                     the model column, and replaying the animation — the tail rows
                     land a quarter-second late — reads as flicker. -->
                <DropdownMenu.RadioItem
                  value={level}
                  data-picker-column="reasoning"
                  data-picker-value={level}
                  onSelect={() => selectReasoning(level)}
                  onfocus={() => (hoveredLevel = level)}
                  onpointerenter={() => (hoveredLevel = level)}
                  data-menu-current={previewReasoning === level ? "" : undefined}
                  style="animation:none"
                >
                  <span class="min-w-0 flex-1 truncate">{REASONING_EFFORT_LABELS[level] ?? level}</span>
                  {#if previewReasoning === level}
                    <CheckIcon size={12} class="absolute right-2 shrink-0 text-(--solus-accent) opacity-40" />
                  {/if}
                </DropdownMenu.RadioItem>
              {/each}
            </div>
          </DropdownMenu.RadioGroup>
          <!-- Always rendered, one line tall: appearing on hover would grow the
               column and shift everything under it. -->
          <p
            class="h-[1.375rem] truncate px-2.5 pt-1.5 text-xs leading-4 text-(--solus-text-tertiary)"
            class:invisible={!(previewModelLabel && previewReasoning)}
          >
            Default for {previewModelLabel ?? ""}
          </p>

          <div class="min-h-2 flex-1"></div>
          <DropdownMenu.Separator />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger data-picker-column="reasoning">
              <span class="flex-1 text-(--solus-text-tertiary)">Agent</span>
              <span class="truncate">{agentName}</span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent class="w-[216px]">
              <DropdownMenu.RadioGroup value={activeAgent}>
                <DropdownMenu.GroupHeading>Agent</DropdownMenu.GroupHeading>
                <!-- Picking an agent is the start of a choice, not the end of one:
                     the menu stays up so its models and levels can follow. The
                     flyout closes on its own once the pointer reaches them. -->
                {#each agentRows as agent (agent.id)}
                  <DropdownMenu.RadioItem value={agent.id} disabled={!agent.enabled} closeOnSelect={false} onSelect={() => selectAgent(agent.id)}>
                    <span class="min-w-0 flex-1 truncate">{agent.label}</span>
                    {#if !agent.enabled}
                      <span class="shrink-0 text-xs text-(--solus-text-tertiary)">Not installed</span>
                    {/if}
                  </DropdownMenu.RadioItem>
                {/each}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        </div>
      {:else}
        <div class="w-px shrink-0 bg-(--solus-menu-hairline)"></div>
        <div class="flex w-[152px] shrink-0 flex-col p-1.5">
          <DropdownMenu.RadioGroup value={activeAgent}>
            <DropdownMenu.GroupHeading>Agent</DropdownMenu.GroupHeading>
            {#each agentRows as agent (agent.id)}
              <DropdownMenu.RadioItem value={agent.id} disabled={!agent.enabled} closeOnSelect={false} onSelect={() => selectAgent(agent.id)}>
                <span class="min-w-0 flex-1 truncate">{agent.label}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </div>
      {/if}
    </div>
    {#if !modelOnly}
      <MenuFooter
        hints={[["↑↓", "within"], ["←→", "columns"], [comboHint("global.cycle-model"), "cycle"]]}
        summary="{previewModelLabel ?? modelLabel} · {REASONING_EFFORT_LABELS[hoveredLevel ?? previewReasoning ?? reasoningEffort]}"
      />
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
