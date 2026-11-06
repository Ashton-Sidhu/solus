<script lang="ts">
  import { checkoutGit } from "../../contexts/workspace/run-location";
  import { agentForProject } from "@solus/contracts/provider-instance-models";
  import { isModelPickerAgentVisible } from "@solus/client-core/model-picker-agents";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { tick, untrack } from "svelte";
  import { AUTO_MODEL_ID } from "@solus/contracts/model-routing";
  import { solusToolsStore } from "../settings/solus-tools.store.svelte";
  import {
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    Check as CheckIcon,
    Code as CodeIcon,
    Sparkles as SparklesIcon,
    Zap as LightningIcon,
  } from "@lucide/svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "./OpenAIBlossom.svelte";
  import { getSettingsContext, getWorkspaceContext, getAgentContext, getStatusBarContext } from "../../contexts";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { workPolicy } from "../../contexts/policy/work-policy.svelte";
  import { modelPolicyDenial, withProviderPolicy } from "./lib/policy-locks";
  import {
    REASONING_EFFORT_LABELS,
    isLegacyModel,
    type AgentMetadata,
    type ReasoningEffort,
    type AgentId,
    type RunConfig,
  } from "@solus/contracts/types";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { cn } from "@solus/workspace-ui/lib/tw";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PermissionModePicker from "./PermissionModePicker.svelte";
  import { PERMISSION_MODE_DISPLAY } from "../../lib/permission-modes";
  import {
    clampReasoningEffort,
    defaultModelIdFor,
    defaultReasoningFor,
    isSessionSettingsShortcutTarget,
    modelPickerFocusTarget,
    pickClosesModelPicker,
    modelPickerNavigationTarget,
    modelOptionsFor,
    offersFastMode,
    reservedReasoningRows,
    reasoningLevelsFor,
    splitLegacyModels,
    supportsFastModeFor,
    LEGACY_SECTION_VALUE,
    type ModelPickerColumn,
    type ModelPickerFocusReason,
    type PickerSelection,
  } from "./lib/picker-selection";

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const statusBar = getStatusBarContext();

  interface Props {
    tabId?: string;
    draftId?: string;
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
    /** Offer Auto in a model-only picker. Only a setting whose value seeds a new
     *  session may: Auto routes a first prompt, so nothing already running can
     *  take it. */
    allowAuto?: boolean;
    /** Show the fast-mode switch. A host that cannot send fast mode with its
     *  run turns it off, so the switch never promises what the run ignores. */
    allowFastMode?: boolean;
    /** Show the permission mode in the chip and offer it in the footer. Only a
     *  composer may: nothing else this chip edits has a mode. */
    allowPermissionMode?: boolean;
    /** A session draft's run, whose mode the footer edits. A chip with a tab
     *  edits that tab's session instead. */
    run?: RunConfig;
    onRun?: (next: RunConfig) => void;
    /** Host-scoped metadata can differ from the active workspace host. */
    agents?: AgentMetadata[];
    /** The host whose TypeSafe key decides whether Auto can run. Defaults to
     *  the host of `tabId`. */
    serverId?: string;
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
    draftId,
    selection = $bindable(),
    isPrimary = false,
    menuSide = "top",
    modelOnly = false,
    allowAuto = false,
    allowFastMode = true,
    allowPermissionMode = false,
    run,
    onRun,
    agents,
    serverId,
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

  const activeAgent = $derived(selection?.provider ?? ctx.activeAgent);

  // The work's policy on its host: the session's record organization, else the window's (plans/030 §7).
  const policyHostId = $derived(serverId ?? ((tabId || draftId) ? session.serverIdFor(tabId ?? draftId!) : undefined));
  const policy = $derived(policyHostId ? workPolicy(policyHostId, sess?.organizationId) : null);

  const metadata = $derived.by(() => {
    const hostId = policyHostId;
    const hostAgents = agents ?? (hostId ? hosts.get(hostId).machineInfo?.agents : undefined);
    if (!hostAgents) return agentContext.metadata;
    const entries = hostAgents.map((agent) => [agent.id, agentForProject(agent, modelOnly ? undefined : checkoutGit(sess?.run ?? (draftId ? session.drafts.sessionDrafts.get(draftId)?.run : undefined))?.repoRoot ?? ctx.workingDirectory)] as const);
    return Object.fromEntries(entries);
  });

  const modelMeta = $derived(
    metadata[activeAgent] ?? (detached ? null : agentContext.activeMetadata),
  );
  const models = $derived(
    !isModelPickerAgentVisible(activeAgent, Boolean(import.meta.env.DEV)) || (modelOnly && modelMeta?.available === false)
      ? []
      : detached
        ? modelOptionsFor(activeAgent, metadata)
        : (modelMeta?.models ?? []),
  );
  // Superseded models stay selectable but sit behind a disclosure, so the column
  // reads as the generation we expect people to pick.
  const modelSections = $derived(splitLegacyModels(activeAgent, models, modelMeta?.modelProfiles));
  let legacyExpanded = $state(false);
  const canRoute = $derived(!modelOnly && isPrimary && !sess?.agentSessionId && !sess?.forked);
  // A model-only picker hides the reasoning column Auto normally sits in, so its
  // Auto row joins the model list instead.
  const routeInModelColumn = $derived(modelOnly && allowAuto);
  // Auto asks Jev to classify the first prompt, and Jev needs this host's
  // TypeSafe key. Without it Auto cannot route, so it cannot be picked.
  const autoServerId = $derived(canRoute || routeInModelColumn ? (serverId ?? (tabId ? session.serverIdFor(tabId) : undefined)) : undefined);
  $effect(() => {
    const targetServerId = autoServerId;
    if (targetServerId) return untrack(() => solusToolsStore.watch(targetServerId));
  });
  const autoNeedsKey = $derived(!!autoServerId && solusToolsStore.isTypeSafeKeyMissing(autoServerId));
  const defaultModel = $derived(defaultModelIdFor(activeAgent, metadata, settings.defaultModels[activeAgent], canRoute || routeInModelColumn) ?? models[0]?.id ?? null);
  const currentModelId = $derived(
    selection
      ? (selection.modelId ?? defaultModel)
      : (ctx.model || defaultModel),
  );
  const isAuto = $derived(currentModelId === AUTO_MODEL_ID);
  const modelLabel = $derived(
    currentModelId === AUTO_MODEL_ID ? "Auto" : models.find((m) => m.id === currentModelId)?.label ?? currentModelId ?? "",
  );

  // Reasoning — the primary knob, surfaced inline in the chip + menu root.
  const reasoningEffort = $derived(
    selection?.reasoningEffort ?? ctx.reasoningEffort,
  );
  const reasoningLevels = $derived(
    isAuto ? reasoningLevelsFor(activeAgent, defaultModel, modelMeta) : detached ? reasoningLevelsFor(activeAgent, currentModelId, modelMeta) : ctx.reasoningLevels,
  );
  const reasoningLabel = $derived(REASONING_EFFORT_LABELS[reasoningEffort] ?? "High");
  const fastMode = $derived(selection?.fastMode ?? ctx.fastMode);
  const permissionMode = $derived((onRun ? statusBar.ctxForRun(run) : ctx).permissionMode);
  const permissionDisplay = $derived(PERMISSION_MODE_DISPLAY[permissionMode]);
  const supportsPermissions = $derived(modelMeta?.capabilities?.permissions !== false);
  const triggerLabel = $derived(allowPermissionMode ? `${ariaLabel} · ${permissionDisplay.label}` : ariaLabel);

  // Agent. Unavailable agents stay on the list, disabled: dropping them left the
  // flyout blank whenever a binary probe came back empty, with nothing on screen
  // to say why there was nothing to pick.
  const agentRows = $derived(
    withProviderPolicy(buildAgentAvailabilityRows(agents ?? agentContext.agents, metadata, Boolean(import.meta.env.DEV)), policy),
  );
  const agentName = $derived(agentLabel(activeAgent, metadata));

  // Leading brand glyph on the chip — Claude's starburst for claude-code, the
  // OpenAI mark for codex, a generic code glyph otherwise.
  const isCodex = $derived(activeAgent === "codex");

  let open = $state(false);
  let permissionOpen = $state(false);
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
      ? defaultReasoningFor(activeAgent, hoveredModelId, modelMeta)
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
  // The right column tracks whatever model is under the cursor — otherwise the
  // preview check can land on a level that model doesn't offer.
  const shownReasoningLevels = $derived(
    hoveredModelId ? reasoningLevelsFor(activeAgent, hoveredModelId, modelMeta) : reasoningLevels,
  );
  const showsFastMode = $derived(
    allowFastMode && isCodex && supportsFastModeFor(activeAgent, isAuto ? defaultModel : currentModelId, modelMeta),
  );
  const showsFooter = $derived(
    !modelOnly && (allowPermissionMode || canRoute || (allowFastMode && offersFastMode(agentRows.map((agent) => agent.id), metadata))),
  );
  // Models offer different numbers of levels (Haiku 4, Sonnet 5, Opus 7), so the
  // column is held at the deepest set any agent's model offers. Without the
  // reservation the menu resizes — and, being
  // top-anchored, repositions — under the cursor on every model you pass over
  // and on every agent switch.
  const reservedLevelRows = $derived(
    Math.max(reservedReasoningRows(agentRows.map((agent) => agent.id), metadata), reasoningLevels.length),
  );

  function openFromShortcut(targetTabId?: string) {
    // An unaddressed shortcut targets the primary composer. This includes a
    // detached new-session draft, whose model choice is local until dispatch.
    if (!isSessionSettingsShortcutTarget({ isPrimary, tabId, targetTabId })) return;
    // Multiple mounted conversation surfaces can each render a SessionChip and
    // receive this shortcut. Only the one in the visible layout should open
    // (a display:none ancestor reports offsetParent === null).
    if (triggerEl && triggerEl.offsetParent === null) return;
    // Already open: the shortcut jumps to the levels, the way → does.
    if (open) focusPickerRow("shortcut");
    else open = true;
  }

  // The mode lives in the footer flyout, so its shortcut opens both at once.
  function openPermissionFromShortcut(targetTabId?: string) {
    if (!allowPermissionMode || !supportsPermissions) return;
    if (!isSessionSettingsShortcutTarget({ isPrimary, tabId, targetTabId })) return;
    if (triggerEl && triggerEl.offsetParent === null) return;
    permissionOpen = true;
    open = true;
  }

  // Focus by value, not index: the row moves when the legacy list opens or the
  // agent changes. Auto sits in the footer when this picker can route, so a
  // value missing from its column is looked up in the others.
  function focusPickerRow(reason: ModelPickerFocusReason) {
    const target = modelPickerFocusTarget({
      reason,
      modelId: currentModelId,
      effort: reasoningEffort,
      levels: modelOnly || isAuto ? [] : reasoningLevels,
    });
    const rows = [...pickerItems(target.column), ...pickerItems(target.column === "model" ? "reasoning" : "model"), ...pickerItems("footer")];
    (rows.find((row) => row.dataset.pickerValue === target.value) ?? pickerItems("model")[0])?.focus();
  }

  // The picker stays up after a model pick, on that model's current level, so
  // model then effort is one flow. Wait a tick: the levels on screen are still
  // the previous model's until the new config lands.
  async function pickModel(modelId: string) {
    selectModel(modelId);
    await tick();
    focusPickerRow("model-picked");
  }

  // Clicking a level commits the previewed model with it and closes the picker:
  // an effort is the final choice (pickClosesModelPicker). The levels on offer
  // are that model's own, so no clamping is needed. The model patch has to ride
  // along in the same call: updateModelConfig's model branch would otherwise
  // overwrite the effort with the model's default.
  function selectReasoning(effort: ReasoningEffort) {
    if (isAuto && !hoveredModelId) return;
    const pendingModelId =
      hoveredModelId && hoveredModelId !== currentModelId ? hoveredModelId : null;
    if (selection && !draftId) {
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
          }
        : { reasoningEffort: effort },
      tabId ?? draftId,
    );
  }
  function selectModel(modelId: string) {
    hoveredModelId = null;
    if (selection && !draftId) {
      selection.modelId = modelId;
      selection.reasoningEffort = modelId === AUTO_MODEL_ID ? "medium" : clampReasoningEffort(selection.provider, modelId, selection.reasoningEffort);
      selection.fastMode = false;
      onSelectionChange?.(selection);
      return;
    }
    if (modelId === AUTO_MODEL_ID) {
      session.updateModelConfig({ modelId, fastMode: false, reasoningEffort: "medium" }, tabId ?? draftId);
    } else {
      session.updateModelConfig({ modelId }, tabId ?? draftId);
    }
  }
  function selectAgent(id: AgentId) {
    // The menu stays up across the switch, so the disclosure has to follow the
    // model the new agent lands on rather than keep the old agent's answer.
    legacyExpanded = isLegacyModel(id, defaultModelIdFor(id, metadata, settings.defaultModels[id], canRoute || routeInModelColumn), metadata[id]?.modelProfiles);
    if (selection && !draftId) {
      const modelId = defaultModelIdFor(id, metadata, settings.defaultModels[id], canRoute || routeInModelColumn);
      selection.provider = id;
      selection.modelId = modelId;
      const run = sess?.run ?? (draftId ? session.drafts.sessionDrafts.get(draftId)?.run : undefined);
      const config = session.config.modelConfigFor(id, modelId, run);
      selection.reasoningEffort = modelId === AUTO_MODEL_ID ? "medium" : config.reasoningEffort;
      selection.fastMode = modelId !== AUTO_MODEL_ID && config.fastMode;
      onSelectionChange?.(selection);
      return;
    }
    session.config.switchActiveAgent(id, tabId ?? draftId);
  }

  function applyFastMode(modelId: string, enabled: boolean) {
    if (selection && !draftId) {
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
      tabId ?? draftId,
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
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const focusedItem =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-picker-column]")
        : null;
    const pickerColumn = focusedItem?.dataset.pickerColumn;
    const column: ModelPickerColumn | undefined =
      pickerColumn === "model" || pickerColumn === "reasoning" || pickerColumn === "footer" || pickerColumn === "rail" ? pickerColumn : undefined;
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
    const railRows = pickerItems("rail");
    const destination = modelPickerNavigationTarget({
      key: event.key,
      column,
      index,
      columnLength: columnItems.length,
      oppositeColumnLength: oppositeItems.length,
      preferredOppositeIndex,
      footerLength: pickerItems("footer").length,
      railIndex: railRows.length > 0 ? Math.max(0, railRows.findIndex((row) => row.dataset.pickerValue === activeAgent)) : undefined,
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

  $effect(() => {
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      openPermissionFromShortcut(detail?.tabId);
    };
    window.addEventListener("solus:toggle-permission-menu", handler);
    return () =>
      window.removeEventListener("solus:toggle-permission-menu", handler);
  });
</script>

<!-- The agent's brand mark. The trigger and the model list heading both name
     the agent this way, so the two read as one control. -->
{#snippet agentMark(agentId: AgentId, blossomFill = "black")}
  {#if agentId === "claude-code"}
    <ClaudeIcon size={16} />
  {:else if agentId === "codex"}
    <OpenAIBlossom size={16} fill={blossomFill} />
  {:else}
    <CodeIcon size={16} class="flex-shrink-0" />
  {/if}
{/snippet}

<!-- The mark at menu size. Codex takes the row's ink: a white plate is heavier
     than the glyph at this size. -->
{#snippet agentMenuMark(agentId: AgentId)}
  <span class="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5 {agentId === 'codex' ? '' : 'text-(--solus-accent)'}" aria-hidden="true">
    {@render agentMark(agentId, "currentColor")}
  </span>
{/snippet}

<DropdownMenu.Root
  bind:open
  onOpenChange={(nextOpen) => {
    hoveredModelId = null;
    hoveredLevel = null;
    if (!nextOpen) permissionOpen = false;
    // Open on the section holding the current choice: a session already running
    // a superseded model must not have to go looking for what it is running.
    if (nextOpen) legacyExpanded = isLegacyModel(activeAgent, currentModelId, modelMeta?.modelProfiles);
  }}
>
  <DropdownMenu.Trigger {disabled} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <!-- The brand mark is the model's category glyph and carries the
                 only accent on the control. -->
            <!-- `overflow-hidden` is load-bearing, not decoration. `min-w-0`
                 lets this box shrink past its content, but the glyph, the
                 reasoning label and the caret are all rigid, so without a clip
                 they paint outside the border box and over the neighbour. -->
            <button {...tooltipProps} {...props} data-slot="session-chip" type="button" aria-label={triggerLabel} class={cn("flex h-[1.875rem] min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border-[0.5px] border-(--solus-container-border) px-2.5 font-secondary text-workspace-chrome text-(--solus-text-tertiary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)", open && "bg-(--solus-surface-hover)", className)} style="cursor:{disabled ? 'not-allowed' : 'pointer'}">
        <!-- Codex's mark is solid black, so it keeps a white plate to stay
             legible in dark mode; the others take the accent directly. Auto
             belongs to no one provider, so it carries a sparkles glyph in the
             same slot rather than a brand mark. -->
        <span
        class="flex flex-shrink-0 items-center justify-center {isCodex && !isAuto
            ? fastMode
              ? 'h-5 w-5 text-amber-500 dark:text-amber-300'
              : 'h-5 w-5 rounded-full bg-white text-(--solus-accent)'
            : isAuto && autoNeedsKey
              ? 'text-(--solus-text-tertiary)'
              : 'text-(--solus-accent)'}"
        >
          {#if isAuto}
            <SparklesIcon size={16} />
          {:else if isCodex && fastMode}
            <LightningIcon size={16} fill="currentColor" />
          {:else}
            {@render agentMark(activeAgent)}
          {/if}
        </span>
        <!-- Composer ladder, rung 5: below 22rem the chip is the glyph alone.
             It stays a hit target and keeps its ⌥ shortcut; only the label
             goes. Named `/composer` so the rung is inert wherever the chip is
             not in a composer. The label inherits the chip's muted colour. -->
        <span class="truncate max-w-48 font-medium @max-[22rem]/composer:hidden">{modelOnly && !isAuto ? `${agentName} · ${modelLabel}` : modelLabel}</span>
        {#if !modelOnly && !isAuto}
          <!-- Rung 2: the reasoning label is the first thing the chip can spend. -->
          <span class="flex-shrink-0 text-(--solus-text-tertiary) @max-[31rem]/composer:hidden">{reasoningLabel}</span>
        {/if}
        <!-- ml-auto is inert while the chip shrink-wraps; it only bites when a
             call site sets a width floor, keeping the caret on the edge. -->
        <CaretDownIcon size={12} strokeWidth={1.5} class="ml-auto text-(--solus-text-tertiary) transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={open ? null : isBusy ? "Changes apply to later work; a provider change applies when you send" : isAuto && autoNeedsKey ? "Auto needs a TypeSafe key. Until you add one in Settings → Tools, sessions use the General use model." : triggerLabel} />
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
      // `text-menu`, not the chrome rung. A menu is a decision surface, and
      // every other menu in the app takes `text-menu` too.
      "overflow-visible p-0 text-menu",
      // Capped to the window, per WP5: anchored in a 356px pane a 452px menu is
      // wider than the pane it drops out of. The cap is honest in any container
      // — it only ever says "never wider than the window".
      modelOnly
        ? "w-[min(21.5rem,calc(100vw-2rem))]"
        : "w-[min(31rem,calc(100vw-2rem))]",
    )}
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      // The shortcut opened the flyout too, and the flyout takes focus.
      if (!permissionOpen) focusPickerRow("open");
    }}
    onCloseAutoFocus={handleCloseAutoFocus}
    onkeydown={handlePickerKeyDown}
    onpointerleave={() => {
      hoveredModelId = null;
      hoveredLevel = null;
    }}
  >
    <div class="flex items-stretch rounded-[inherit]">
      {#if !modelOnly}
        <!-- The agent decides everything beside it, so it is the one surface of
             its own, the full height of the popup, set apart by tint and not by
             another line. Picking an agent keeps the picker up so its models can
             follow. The title sits on a wrapper because a disabled row takes no
             pointer. -->
        <DropdownMenu.RadioGroup value={activeAgent} aria-label="Agent" class="flex w-11 shrink-0 flex-col items-center gap-1 rounded-l-[inherit] bg-(--solus-menu-footer-bg) p-1.5">
          {#each agentRows as agent (agent.id)}
            <span class="block" title={agent.enabled ? agent.label : `${agent.label}: ${agent.policyDenial ? "Not allowed" : "Not installed"}`}>
              <DropdownMenu.RadioItem
                value={agent.id}
                disabled={!agent.enabled}
                aria-label={agent.label}
                data-picker-column="rail"
                data-picker-value={agent.id}
                closeOnSelect={pickClosesModelPicker("agent")}
                onSelect={() => selectAgent(agent.id)}
                onfocus={() => { hoveredModelId = null; hoveredLevel = null; }}
                onpointerenter={() => { hoveredModelId = null; hoveredLevel = null; }}
                class="size-8 justify-center p-0 data-[state=checked]:bg-(--solus-surface-hover) [&_[data-slot=dropdown-menu-radio-item-indicator]]:hidden"
              >
                <span class="flex size-4 shrink-0 items-center justify-center {agent.id === activeAgent ? (agent.id === 'codex' ? '' : 'text-(--solus-accent)') : 'opacity-55 grayscale'}" aria-hidden="true">
                  {@render agentMark(agent.id, "currentColor")}
                </span>
              </DropdownMenu.RadioItem>
            </span>
          {/each}
        </DropdownMenu.RadioGroup>
      {/if}
      <div class="min-w-0 flex-1">
      <div class="flex items-stretch">
      <!-- Beside the Reasoning column the model list takes no height of its
           own: it scrolls inside the column's reserved height, so opening the
           legacy list or switching agent never resizes the popup. -->
      <div class="relative min-w-0 flex-1">
      <div class={cn("p-1.5", !modelOnly && "absolute inset-0 overflow-y-auto")}>
        <!-- The preview clears on the way out of the whole surface, never on a
             row: row-level leave/enter pairs flash the column back to the
             current model between every two rows you sweep across, and clearing
             at the column edge would drop the pending model on the walk to the
             level you're about to click. -->
        <DropdownMenu.RadioGroup value={currentModelId ?? ""}>
          <!-- Names whose models these are. Beside the rail the mark is already
               lit, so only the Agent column's picker repeats it here. -->
          <DropdownMenu.GroupHeading class="flex items-center gap-1.5">
            {#if modelOnly}{@render agentMenuMark(activeAgent)}{/if}
            <span class="min-w-0 truncate">{agentName}</span>
          </DropdownMenu.GroupHeading>
          {#each modelSections.current as model (model.id)}
            {@const denial = modelPolicyDenial(policy, activeAgent, model.id)}
            <DropdownMenu.RadioItem
              value={model.id}
              disabled={denial !== null}
              title={denial ?? undefined}
              data-picker-column="model"
              data-picker-value={model.id}
              closeOnSelect={pickClosesModelPicker("model")}
              onSelect={() => pickModel(model.id)}
              onfocus={() => {
                hoveredModelId = model.id;
                hoveredLevel = null;
              }}
              onpointerenter={() => {
                hoveredModelId = model.id;
                // Back in the model column the level under the cursor is stale —
                // the wash would advertise a pair that isn't on offer.
                hoveredLevel = null;
              }}
              data-menu-preview={previewedModelId === model.id ? "" : undefined}
            >
              <span class="min-w-0 flex-1 truncate" title={model.label}>{model.label}</span>
              {#if denial}<span class="shrink-0 text-xs text-(--solus-text-tertiary)">Not allowed</span>{/if}
              <!-- The same faded check the Reasoning column shows on a previewed
                   level: both halves of the pending pair are marked the same way. -->
              {#if previewedModelId === model.id && model.id !== currentModelId}
                <CheckIcon size={12} class="absolute right-2 shrink-0 text-(--solus-accent) opacity-40" />
              {/if}
            </DropdownMenu.RadioItem>
          {/each}
          {#if modelSections.legacy.length > 0}
            <!-- A row in the same column, not a flyout: arrow keys reach it on
                 the way down the list, and Enter opens it in place rather than
                 sending the cursor sideways into a second surface. -->
            <DropdownMenu.Item
              closeOnSelect={false}
              aria-expanded={legacyExpanded}
              data-picker-column="model"
              data-picker-value={LEGACY_SECTION_VALUE}
              onSelect={() => (legacyExpanded = !legacyExpanded)}
              onfocus={() => { hoveredModelId = null; hoveredLevel = null; }}
              onpointerenter={() => { hoveredModelId = null; hoveredLevel = null; }}
            >
              <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">Legacy models</span>
              <span class="shrink-0 text-(--solus-text-tertiary)">{modelSections.legacy.length}</span>
              <CaretRightIcon size={11} class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 {legacyExpanded ? 'rotate-90' : ''}" />
            </DropdownMenu.Item>
            {#if legacyExpanded}
              {#each modelSections.legacy as model (model.id)}
                {@const denial = modelPolicyDenial(policy, activeAgent, model.id)}
                <DropdownMenu.RadioItem
                  value={model.id}
                  disabled={denial !== null}
                  title={denial ?? undefined}
                  data-picker-column="model"
                  data-picker-value={model.id}
                  closeOnSelect={pickClosesModelPicker("model")}
                  onSelect={() => pickModel(model.id)}
                  onfocus={() => {
                    hoveredModelId = model.id;
                    hoveredLevel = null;
                  }}
                  onpointerenter={() => {
                    hoveredModelId = model.id;
                    hoveredLevel = null;
                  }}
                  data-menu-preview={previewedModelId === model.id ? "" : undefined}
                >
                  <span class="min-w-0 flex-1 truncate" title={model.label}>{model.label}</span>
                  {#if denial}<span class="shrink-0 text-xs text-(--solus-text-tertiary)">Not allowed</span>{/if}
                  {#if previewedModelId === model.id && model.id !== currentModelId}
                    <CheckIcon size={12} class="absolute right-2 shrink-0 text-(--solus-accent) opacity-40" />
                  {/if}
                </DropdownMenu.RadioItem>
              {/each}
            {/if}
          {/if}
          {#if routeInModelColumn}
            <DropdownMenu.Separator />
            <DropdownMenu.RadioItem
              value={AUTO_MODEL_ID}
              disabled={autoNeedsKey}
              data-picker-column="model"
              data-picker-value={AUTO_MODEL_ID}
              closeOnSelect={pickClosesModelPicker("model")}
              onSelect={() => pickModel(AUTO_MODEL_ID)}
              onfocus={() => { hoveredModelId = null; hoveredLevel = null; }}
              onpointerenter={() => { hoveredModelId = null; hoveredLevel = null; }}
            >
              <span class="min-w-0 flex-1 truncate">Auto</span>
              {#if autoNeedsKey}
                <span class="shrink-0 text-xs text-(--solus-text-tertiary)">Needs TypeSafe key</span>
              {/if}
            </DropdownMenu.RadioItem>
          {/if}
        </DropdownMenu.RadioGroup>
      </div>
      </div>

      {#if !modelOnly}
        <!-- Short of the footer line, so the two never meet in a T. -->
        <div class="my-2 w-px shrink-0 bg-(--solus-menu-hairline)"></div>

        <div class="flex w-[184px] shrink-0 flex-col p-1.5">
          <DropdownMenu.RadioGroup value={isAuto || previewReasoning ? "" : reasoningEffort}>
            <!-- Which model these levels belong to is said by the model row,
                 which keeps its wash (`data-menu-preview`) while its levels
                 are on offer — not by the heading. -->
            <DropdownMenu.GroupHeading>Reasoning</DropdownMenu.GroupHeading>
            <div style="min-height:{reservedLevelRows * 2}rem">
              {#each shownReasoningLevels as level (level)}
                <!-- No entry stagger: this list re-renders as the cursor moves down
                     the model column, and replaying the animation — the tail rows
                     land a quarter-second late — reads as flicker. -->
                <DropdownMenu.RadioItem
                  value={level}
                  disabled={isAuto && !hoveredModelId}
                  data-picker-column="reasoning"
                  data-picker-value={level}
                  closeOnSelect={pickClosesModelPicker("effort")}
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
        </div>
      {:else}
        <div class="w-px shrink-0 bg-(--solus-menu-hairline)"></div>
        <div class="flex w-[152px] shrink-0 flex-col p-1.5">
          <DropdownMenu.RadioGroup value={activeAgent}>
            <DropdownMenu.GroupHeading>Agent</DropdownMenu.GroupHeading>
            {#each agentRows as agent (agent.id)}
              <DropdownMenu.RadioItem value={agent.id} disabled={!agent.enabled} title={agent.enabled ? undefined : agent.reason} closeOnSelect={pickClosesModelPicker("agent")} onSelect={() => selectAgent(agent.id)}>
                {@render agentMenuMark(agent.id)}
                <span class="min-w-0 flex-1 truncate">{agent.label}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </div>
      {/if}
    </div>
    {#if showsFooter}
      <!-- Settings of the whole run, not of the model under the cursor, so they
           sit under both columns and leaving a model for them drops its preview.
           The keys are taken on the way down: → moves along the row, and only
           the last row keeps it to open its flyout. The flyout opens on a click,
           never on hover: a row this close to its neighbours would open it on
           the way past. -->
      <div class="mx-2.5 h-px bg-(--solus-menu-hairline)"></div>
      <div
        role="none"
        class="flex items-center gap-1 p-1.5"
        onkeydowncapture={handlePickerKeyDown}
        onpointerenter={() => { hoveredModelId = null; hoveredLevel = null; }}
        onfocusin={() => { hoveredModelId = null; hoveredLevel = null; }}
      >
        {#if canRoute}
          <DropdownMenu.RadioGroup class="min-w-0" value={currentModelId ?? ""}>
            <DropdownMenu.RadioItem
              value={AUTO_MODEL_ID}
              disabled={autoNeedsKey}
              data-picker-column="footer"
              data-picker-value={AUTO_MODEL_ID}
              closeOnSelect={pickClosesModelPicker("model")}
              onSelect={() => pickModel(AUTO_MODEL_ID)}
              class="gap-1.5 pr-2.5 data-[state=checked]:bg-(--solus-accent-light) [&_[data-slot=dropdown-menu-radio-item-indicator]]:hidden"
            >
              <SparklesIcon class={isAuto ? "text-(--solus-accent)" : "text-(--solus-text-tertiary)"} />
              <span class="shrink-0">Auto</span>
              {#if autoNeedsKey}
                <span class="min-w-0 truncate text-xs text-(--solus-text-tertiary)">Needs TypeSafe key</span>
              {/if}
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        {/if}
        {#if showsFastMode}
          <DropdownMenu.CheckboxItem
            class="shrink-0 gap-1.5 pr-2.5 data-[state=checked]:bg-(--solus-accent-light) [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
            checked={fastMode}
            disabled={isAuto}
            closeOnSelect={pickClosesModelPicker("fast-mode")}
            onCheckedChange={setFastMode}
            aria-label="Fast mode for {modelLabel}"
            data-picker-column="footer"
            data-picker-value="fast-mode"
          >
            <LightningIcon class={fastMode ? "text-(--solus-accent)" : "text-(--solus-text-tertiary)"} fill={fastMode ? "currentColor" : "none"} />
            <span>Fast mode</span>
          </DropdownMenu.CheckboxItem>
        {/if}
        {#if allowPermissionMode}
          <PermissionModePicker
            {tabId}
            {run}
            {onRun}
            {permissionMode}
            capabilities={modelMeta?.capabilities}
            bind:open={permissionOpen}
          />
        {/if}
      </div>
    {/if}
      </div>
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
