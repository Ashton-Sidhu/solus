<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
    Code as CodeIcon,
    LoaderCircle as SpinnerGapIcon,
    Zap as LightningIcon,
  } from "@lucide/svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "./OpenAIBlossom.svelte";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from "../../contexts";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import {
    REASONING_EFFORT_LABELS,
    type AgentMetadata,
    type ReasoningEffort,
    type AgentId,
  } from "@solus/contracts/types";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { cn } from "@solus/workspace-ui/lib/tw";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Switch } from "../ui/switch";
  import { MenuFooter } from "../ui/menu";
  import {
    clampReasoningEffort,
    defaultModelIdFor,
    defaultReasoningFor,
    isSessionSettingsShortcutTarget,
    modelPickerNavigationTarget,
    modelOptionsFor,
    reasoningLevelsFor,
    supportsFastModeFor,
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
  let pendingHandoffAgent = $state<AgentId | null>(null);

  const activeAgent = $derived(selection?.provider ?? pendingHandoffAgent ?? ctx.activeAgent);

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
    selection
      ? (selection.modelId ?? defaultModel)
      : pendingHandoffAgent
        ? defaultModel
        : (ctx.model || defaultModel),
  );
  const modelLabel = $derived(
    models.find((m) => m.id === currentModelId)?.label ?? currentModelId ?? "",
  );

  // Reasoning — the primary knob, surfaced inline in the chip + menu root.
  const reasoningEffort = $derived(
    selection?.reasoningEffort ??
      (pendingHandoffAgent && currentModelId
        ? defaultReasoningFor(pendingHandoffAgent, currentModelId)
        : ctx.reasoningEffort),
  );
  const reasoningLevels = $derived(
    detached ? reasoningLevelsFor(activeAgent, currentModelId) : ctx.reasoningLevels,
  );
  const reasoningLabel = $derived(REASONING_EFFORT_LABELS[reasoningEffort] ?? "High");
  const fastMode = $derived(selection?.fastMode ?? (pendingHandoffAgent ? false : ctx.fastMode));

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
  const previewReasoning = $derived(
    hoveredModelId && hoveredModelId !== currentModelId
      ? defaultReasoningFor(activeAgent, hoveredModelId)
      : null,
  );
  // The model the Reasoning column belongs to. Once the cursor is on a level,
  // this is the model that level would commit with — the previewed one if the
  // cursor came through the model column, the current one if it came straight
  // over. The model row keeps its wash for as long as this points at it, the
  // way a parent menu stays lit while the cursor is in its submenu.
  const previewedModelId = $derived(
    hoveredModelId ?? (hoveredLevel !== null ? currentModelId : null),
  );
  const previewedModelLabel = $derived(
    models.find((m) => m.id === previewedModelId)?.label ?? modelLabel,
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
    // An unaddressed shortcut targets the primary composer. This includes a
    // detached new-session draft, whose model choice is local until dispatch.
    if (!isSessionSettingsShortcutTarget({ isPrimary, tabId, targetTabId })) return;
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
      if (pendingModelId) {
        selection.modelId = pendingModelId;
        selection.fastMode = false;
      }
      selection.reasoningEffort = effort;
      onSelectionChange?.(selection);
      return;
    }
    session.updateModelConfig(
      pendingModelId
        ? {
            modelId: pendingModelId,
            reasoningEffort: effort,
            fastMode: false,
          }
        : { reasoningEffort: effort },
      tabId,
    );
  }
  function selectModel(modelId: string) {
    hoveredModelId = null;
    if (selection) {
      selection.modelId = modelId;
      selection.reasoningEffort = clampReasoningEffort(selection.provider, modelId, selection.reasoningEffort);
      selection.fastMode = false;
      onSelectionChange?.(selection);
      return;
    }
    session.updateModelConfig({ modelId, fastMode: false }, tabId);
  }
  function selectAgent(id: AgentId) {
    if (selection) {
      const modelId = defaultModelIdFor(id, metadata);
      selection.provider = id;
      selection.modelId = modelId;
      selection.reasoningEffort = clampReasoningEffort(id, modelId, selection.reasoningEffort);
      if (!supportsFastModeFor(id, modelId)) selection.fastMode = false;
      onSelectionChange?.(selection);
      return;
    }
    pendingHandoffAgent = id;
    void session.switchActiveAgent(id, tabId).finally(() => {
      if (pendingHandoffAgent === id) pendingHandoffAgent = null;
    });
  }

  function applyFastMode(modelId: string, enabled: boolean) {
    if (selection) {
      if (selection.modelId !== modelId) {
        selection.modelId = modelId;
        selection.reasoningEffort = clampReasoningEffort(
          selection.provider,
          modelId,
          selection.reasoningEffort,
        );
      }
      selection.fastMode = enabled;
      onSelectionChange?.(selection);
      return;
    }
    session.updateModelConfig(
      modelId !== currentModelId ? { modelId, fastMode: enabled } : { fastMode: enabled },
      tabId,
    );
  }

  function setFastMode(enabled: boolean) {
    const modelId = currentModelId;
    if (!modelId) return;
    applyFastMode(modelId, enabled);
    if (!enabled) return;
    toasts.info(`Fast mode on · ${modelLabel}`, {
      id: "codex-fast-mode",
      description: "This can consume your Codex usage allowance more quickly.",
      duration: 5_000,
      closeButton: true,
      action: {
        label: "Turn off",
        onAction: () => applyFastMode(modelId, false),
      },
    });
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
    if (handoffInProgress) return;
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
            <!-- `overflow-hidden` is load-bearing, not decoration. `min-w-0`
                 lets this box shrink past its content, but the glyph, the
                 reasoning label and the caret are all rigid, so without a clip
                 they paint outside the border box and over the neighbour. -->
            <button {...tooltipProps} {...props} type="button" aria-label={ariaLabel} class={cn("flex h-[1.875rem] min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border-[0.5px] border-(--solus-container-border) px-2.5 font-secondary text-workspace-chrome text-(--solus-text-secondary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)", open && "bg-(--solus-surface-hover)", className)} style="cursor:{disabled || isBusy || handoffInProgress ? 'not-allowed' : 'pointer'}">
        <!-- Codex's mark is solid black, so it keeps a white plate to stay
             legible in dark mode; the others take the accent directly. -->
        <span
        class="flex flex-shrink-0 items-center justify-center {isCodex
            ? fastMode
              ? 'h-5 w-5 text-amber-500 dark:text-amber-300'
              : 'h-5 w-5 rounded-full bg-white text-(--solus-accent)'
            : 'text-(--solus-accent)'}"
        >
          {#if isClaude}
            <ClaudeIcon size={13} />
          {:else if isCodex}
            {#if fastMode}
              <LightningIcon size={14} fill="currentColor" />
            {:else}
              <OpenAIBlossom size={13} />
            {/if}
          {:else}
            <CodeIcon size={13} class="flex-shrink-0" />
          {/if}
        </span>
        <!-- Composer ladder, rung 5: below 15rem the chip is the brand glyph
             alone. It stays a hit target and keeps its ⌥ shortcut; only the
             label goes. Named `/composer` so the rung is inert wherever the chip
             is not in a composer. -->
        <span class="truncate max-w-48 font-medium text-(--solus-text-primary) @max-[15rem]/composer:hidden">{modelOnly ? `${agentName} · ${modelLabel}` : modelLabel}</span>
        {#if !modelOnly}
          <!-- Rung 2: the reasoning label is the first thing the chip can spend. -->
          <span class="flex-shrink-0 text-(--solus-text-tertiary) @max-[26rem]/composer:hidden">{reasoningLabel}</span>
        {/if}
        {#if handoffInProgress}
          <!-- Keep the selected model visible while the provider switch settles;
               the spinner reports transport state without replacing the choice. -->
          <SpinnerGapIcon size={11} class="ml-auto flex-shrink-0 animate-spin text-(--solus-text-tertiary) motion-reduce:animate-none" />
        {:else}
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
    class={cn(
      // `text-menu`, not the chrome rung. A menu is a decision surface: every
      // other menu in the app holds 14px on a laptop, and the chrome rung steps
      // to 12px there. Pinning it here — and restating it over every `.menu-row`
      // — made the model picker the one menu that shrank on a laptop display,
      // a rung below the rows of the very menus it sits beside.
      "overflow-visible p-0 text-menu",
      // Capped to the window, per WP5: anchored in a 356px pane a 452px menu is
      // wider than the pane it drops out of. The cap is honest in any container
      // — it only ever says "never wider than the window".
      modelOnly
        ? "w-[min(21.5rem,calc(100vw-2rem))]"
        : "w-[min(28.25rem,calc(100vw-2rem))]",
    )}
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
              disabled={handoffInProgress}
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
              data-menu-preview={previewedModelId === model.id ? "" : undefined}
            >
              <span class="min-w-0 flex-1 truncate">{model.label}</span>
              <!-- The same faded check the Reasoning column shows on a previewed
                   level: both halves of the pending pair are marked the same way. -->
              {#if previewedModelId === model.id && model.id !== currentModelId}
                <CheckIcon size={12} class="absolute right-2 shrink-0 text-(--solus-accent) opacity-40" />
              {/if}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </div>

      {#if !modelOnly}
        <div class="w-px shrink-0 bg-(--solus-menu-hairline)"></div>

        <div class="flex w-[184px] shrink-0 flex-col p-1.5">
          <DropdownMenu.RadioGroup value={previewReasoning ? undefined : reasoningEffort}>
            <!-- Which model these levels belong to is said by the model row,
                 which keeps its wash (`data-menu-preview`) while its levels
                 are on offer, and by the footer — not by the heading. -->
            <DropdownMenu.GroupHeading>Reasoning</DropdownMenu.GroupHeading>
            <div style="min-height:{reservedLevelRows * 2}rem">
              {#each shownReasoningLevels as level (level)}
                <!-- No entry stagger: this list re-renders as the cursor moves down
                     the model column, and replaying the animation — the tail rows
                     land a quarter-second late — reads as flicker. -->
                <DropdownMenu.RadioItem
                  value={level}
                  disabled={handoffInProgress}
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
          <div class="min-h-2 flex-1"></div>
          <DropdownMenu.Separator />
          {#if isCodex && supportsFastModeFor(activeAgent, currentModelId)}
            <div class="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-menu text-(--solus-text-secondary) pointer-fine:[.is-laptop-display_&]:h-7 pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-2">
              <span class="min-w-0 flex-1 text-(--solus-text-tertiary)">Fast mode</span>
              <Switch
                size="sm"
                checked={fastMode}
                disabled={handoffInProgress}
                onCheckedChange={setFastMode}
                aria-label="Fast mode for {modelLabel}"
              />
            </div>
          {/if}
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
                  <DropdownMenu.RadioItem value={agent.id} disabled={!agent.enabled || handoffInProgress} closeOnSelect={false} onSelect={() => selectAgent(agent.id)}>
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
              <DropdownMenu.RadioItem value={agent.id} disabled={!agent.enabled || handoffInProgress} closeOnSelect={false} onSelect={() => selectAgent(agent.id)}>
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
        summary="{previewedModelLabel} · {REASONING_EFFORT_LABELS[hoveredLevel ?? previewReasoning ?? reasoningEffort]}"
      />
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
