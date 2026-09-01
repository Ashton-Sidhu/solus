<script lang="ts">
  import {
    Check as CheckIcon,
    Minus as MinusIcon,
    Plus as PlusIcon,
    Search as MagnifyingGlassIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import {
    SHEET_CARD,
    SHEET_ROW_META,
    SHEET_SECTION_LABEL,
    SHEET_STEP_BUTTON,
  } from "./lib/sheet-styles";
  import { SEGMENT_GROUP, SEGMENT_OFF, SEGMENT_ON } from "./lib/plus-menu-styles";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from "@solus/workspace-ui/contexts";
  import { buildAgentAvailabilityRows } from "@solus/workspace-ui/lib/agentAvailability";
  import { providerUsage } from "@solus/workspace-ui/components/project-panel/lib/usage-meters";
  import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";
  import { REASONING_EFFORT_LABELS } from "@solus/contracts/types";
  import { portal } from "@solus/workspace-ui/components/portal";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import MobileSheet from "./MobileSheet.svelte";
  import WebPushBell from "./WebPushBell.svelte";
  import { filterModelGroups, groupModels } from "../lib/mobile-model-groups";

  interface Props {
    /** The composer this sheet edits — a started session's tab, or the id of
     *  the draft composing one. `runFor` reaches the run either way, so the
     *  sheet reads and writes the settings of whichever composer opened it. */
    sourceId?: string;
  }
  let { sourceId }: Props = $props();

  const session = getWorkspaceContext();
  const agent = getAgentContext();
  const statusBar = getStatusBarContext();

  const composerSourceId = $derived(sourceId ?? session.activeTabId);
  const composerRun = $derived(session.runFor(composerSourceId));
  const ctx = $derived(statusBar.ctxForRun(composerRun));
  const sess = $derived(session.sessionFor(composerSourceId));
  const isBusy = $derived(sess?.status === "running" || sess?.status === "connecting");

  const tabMetadata = $derived(agent.metadata[ctx.activeAgent] ?? agent.activeMetadata);
  const models = $derived(tabMetadata?.models ?? []);
  const defaultModel = $derived(tabMetadata?.defaultModel ?? models[0]?.id ?? null);
  const preferredModel = $derived(ctx.model || null);

  const selectedModelId = $derived(
    preferredModel && models.some((m) => m.id === preferredModel)
      ? preferredModel
      : defaultModel,
  );
  const activeLabel = $derived(
    models.find((m) => m.id === selectedModelId)?.label ?? "",
  );

  const reasoningLevels = $derived(ctx.reasoningLevels);
  const currentReasoning = $derived(ctx.reasoningEffort);
  const reasoningIndex = $derived(
    Math.max(0, reasoningLevels.indexOf(currentReasoning)),
  );

  const activeAgent = $derived(ctx.activeAgent);
  const agentRows = $derived(
    buildAgentAvailabilityRows(agent.agents, agent.metadata).filter((row) => row.enabled),
  );

  const capabilities = $derived(tabMetadata?.capabilities);
  const supportsPermissions = $derived(capabilities?.permissions !== false);
  const supportsPlan = $derived(capabilities?.planMode !== false);
  const permissionMode = $derived(ctx.permissionMode);
  const permissionOptions = $derived(
    (["ask", "auto", "plan"] as const).filter((id) => id !== "plan" || supportsPlan),
  );

  // Only the agent this composer runs on: the sheet answers "what happens on my
  // next turn", so a second provider's quota is a different question.
  let usageReadAt = $state(Date.now());
  const usageRow = $derived(
    providerUsage(agent.agents, agent.usage, usageReadAt).find(
      (row) => row.provider === activeAgent,
    ) ?? null,
  );

  const usageBarTone = {
    ok: "bg-(--solus-status-complete)",
    low: "bg-(--solus-status-running)",
    spent: "bg-(--solus-status-error)",
  } satisfies Record<string, string>;

  let open = $state(false);
  let query = $state("");
  let triggerEl: HTMLButtonElement | undefined = $state();

  const groups = $derived(
    filterModelGroups(groupModels(ctx.activeAgent, models, selectedModelId), query),
  );

  registerBackOverlay("mobile-session-sheet", () => open, () => (open = false));

  function toggle() {
    if (models.length === 0) return;
    open = !open;
  }

  function close() {
    open = false;
  }

  function selectModel(modelId: string) {
    if (isBusy) return;
    session.updateModelConfig({ modelId }, composerSourceId);
    close();
    requestAnimationFrame(() => requestInputFocus());
  }

  function stepReasoning(delta: number) {
    const next = reasoningLevels[reasoningIndex + delta];
    if (next) session.updateModelConfig({ reasoningEffort: next }, composerSourceId);
  }

  // The agent decides which models exist, so the sheet stays open on a switch:
  // the list under this control is the next thing you were going to read.
  function selectAgent(agentId: string) {
    session.switchActiveAgent(agentId, composerSourceId);
  }

  function selectPermissionMode(mode: "ask" | "auto" | "plan") {
    session.setPermissionMode(mode, composerSourceId);
  }

  $effect(() => {
    const handler = () => {
      if (isBusy || models.length === 0 || triggerEl?.offsetParent === null) return;
      open = true;
    };
    window.addEventListener("solus:toggle-session-settings-picker", handler);
    return () => window.removeEventListener("solus:toggle-session-settings-picker", handler);
  });

  // The backend's quota poll suspends when nobody watches, so opening the sheet
  // is what makes the countdown current; live updates then arrive on the topic.
  $effect(() => {
    if (!open) return;
    usageReadAt = Date.now();
    void agent.refreshUsage();
  });

  // The filter is only worth its 44px once the list is long enough to scroll.
  const showsFilter = $derived(models.length > 6);
  $effect(() => {
    if (!open) query = "";
  });

  // Declared once: the sheet body is a label surface and its mono facts step
  // down one rung. The filter field is the exception — 16px is what keeps iOS
  // from zooming into it, so it states its own size.
</script>

{#if models.length > 0}
  <button
    bind:this={triggerEl}
    type="button"
    class="inline-flex h-9 max-w-44 shrink-0 cursor-pointer items-center gap-[0.4375rem] rounded-full border-0 bg-transparent px-3 shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
    onclick={toggle}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <span class="truncate font-semibold tracking-[-0.005em] text-(--solus-text-primary)">{activeLabel}</span>
    <span class="shrink-0 font-mono {SHEET_ROW_META}">
      {REASONING_EFFORT_LABELS[currentReasoning].toLocaleLowerCase()}
    </span>
  </button>
{/if}

<!-- Portaled to <body>: the input dock sets `contain: layout paint`, which
     would otherwise make the sheet's `position: fixed` resolve against the dock
     and render inside the pill instead of from the screen bottom. -->
<div use:portal={document.body} data-solus-ui>
  <!--
    Everything the next turn runs on, in one sheet: the agent, its model, how
    hard it thinks, and what it may do unasked. These were a Model button that
    opened a list and a Session tab in the `+` sheet that held the other three —
    so the model you were choosing and the effort it would run at were two
    surfaces apart, and the tab reached them through a row that closed one sheet
    to open another. One thing to open, nothing nested inside it.
  -->
  <MobileSheet {open} onClose={close} title="Session">
    {#if agentRows.length > 1}
      <div class="flex flex-col gap-2 px-4 pb-3.5">
        <span class={SHEET_SECTION_LABEL}>Agent</span>
        <div class={SEGMENT_GROUP}>
          {#each agentRows as row (row.id)}
            <button
              type="button"
              class={activeAgent === row.id ? SEGMENT_ON : SEGMENT_OFF}
              onclick={() => selectAgent(row.id)}
            >
              {row.label}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if showsFilter}
      <div class="px-4 pb-3.5">
        <label class="flex h-11 items-center gap-2.5 rounded-lg bg-(--wash-1) px-3 shadow-[inset_0_0_0_0.03125rem_var(--hairline)]">
          <MagnifyingGlassIcon size={15} class="shrink-0 text-(--muted-foreground)" aria-hidden="true" />
          <!-- 16px, or iOS zooms into the field and never zooms back out. -->
          <input
            bind:value={query}
            type="search"
            placeholder="Filter {models.length} models"
            aria-label="Filter models"
            class="min-w-0 flex-1 border-0 bg-transparent text-base text-(--solus-text-primary) outline-none placeholder:text-(--muted-foreground) [&::-webkit-search-cancel-button]:hidden"
          />
          {#if query}
            <button
              type="button"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-(--wash-3) text-(--muted-foreground) [-webkit-tap-highlight-color:transparent]"
              aria-label="Clear filter"
              onclick={() => (query = "")}
            >
              <XIcon size={12} />
            </button>
          {/if}
        </label>
      </div>
    {/if}

    <div class="flex flex-col gap-4 px-4 pb-1 text-sm">
      {#each groups as group (group.label)}
        <div class="flex flex-col gap-2">
          <span class={SHEET_SECTION_LABEL}>{group.label}</span>
          <div class={SHEET_CARD}>
            {#each group.models as model, index (model.id)}
              {@const isSelected = model.id === selectedModelId}
              {#if index > 0}<div class="h-px bg-(--hairline)"></div>{/if}
              <button
                type="button"
                class="flex h-14 w-full cursor-pointer items-center gap-2.5 border-0 px-3.5 text-left disabled:opacity-40 [-webkit-tap-highlight-color:transparent] {isSelected
                  ? 'bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                  : 'bg-transparent active:bg-(--wash-1)'}"
                disabled={isBusy && !isSelected}
                onclick={() => selectModel(model.id)}
              >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span
                    class="truncate tracking-[-0.005em] text-(--solus-text-primary) {isSelected
                      ? 'font-semibold'
                      : 'font-medium'}"
                  >{model.label}</span>
                  {#if model.fact}
                    <span class="mt-0.5 truncate font-mono {SHEET_ROW_META}">{model.fact}</span>
                  {/if}
                </span>
                {#if isSelected}
                  <CheckIcon size={16} class="shrink-0 text-(--primary)" />
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}

      {#if groups.length === 0}
        <p class="px-0.5 py-2 text-(--muted-foreground)">
          No model matches “{query.trim()}”.
        </p>
      {/if}

      {#if isBusy}
        <p class="px-0.5 {SHEET_ROW_META}">Stop the run to switch model.</p>
      {/if}

      <!-- Effort belongs to the model above it, so it sits directly under the
           list: full word on its own line, nothing clipped. -->
      {#if reasoningLevels.length > 1}
        <div class="{SHEET_CARD} px-3.5 pt-3 pb-3.5">
          <div class="flex items-baseline justify-between">
            <span class="font-medium text-(--solus-text-primary)">Reasoning effort</span>
            <span class="text-(--muted-foreground)">{REASONING_EFFORT_LABELS[currentReasoning]}</span>
          </div>
          <div class="mt-3 flex items-center gap-3">
            <button
              type="button"
              class={SHEET_STEP_BUTTON}
              disabled={reasoningIndex === 0}
              aria-label="Less reasoning effort"
              onclick={() => stepReasoning(-1)}
            >
              <MinusIcon size={15} />
            </button>
            <span class="flex flex-1 items-center gap-[0.3125rem]" aria-hidden="true">
              {#each reasoningLevels as level, index (level)}
                <span
                  class="h-1 flex-1 rounded-full {index <= reasoningIndex
                    ? 'bg-(--primary)'
                    : 'bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]'}"
                ></span>
              {/each}
            </span>
            <button
              type="button"
              class={SHEET_STEP_BUTTON}
              disabled={reasoningIndex >= reasoningLevels.length - 1}
              aria-label="More reasoning effort"
              onclick={() => stepReasoning(1)}
            >
              <PlusIcon size={15} />
            </button>
          </div>
          <div class="mt-2 flex justify-between font-mono {SHEET_ROW_META}">
            <span>{REASONING_EFFORT_LABELS[reasoningLevels[0]]}</span>
            <span>{REASONING_EFFORT_LABELS[reasoningLevels[reasoningLevels.length - 1]]}</span>
          </div>
        </div>
      {/if}

      <!-- What is left to spend on the model above, in the same two windows the
           environment section shows: the session window and the week. -->
      {#if usageRow}
        <div
          class="{SHEET_CARD} flex flex-col gap-3 px-3.5 pt-3 pb-3.5"
          class:opacity-60={usageRow.stale}
        >
          <div class="flex items-baseline justify-between">
            <span class="font-medium text-(--solus-text-primary)">Usage remaining</span>
            {#if usageRow.status}
              <span class={SHEET_ROW_META}>
                {usageRow.status === "api" ? "API billing" : "Unavailable"}
              </span>
            {/if}
          </div>
          {#each usageRow.meters as meter (meter.key)}
            <div class="flex flex-col gap-1.5">
              <div class="flex items-baseline gap-2">
                <span class="shrink-0 text-(--solus-text-primary)">{meter.label}</span>
                {#if meter.resetText}
                  <span class="truncate {SHEET_ROW_META}">resets in {meter.resetText}</span>
                {/if}
                <span class="order-last ml-auto shrink-0 font-mono tabular-nums {SHEET_ROW_META}">
                  {Math.round(meter.remainingPercent)}%
                </span>
              </div>
              <div class="h-1 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]">
                <div
                  class="h-full rounded-full {usageBarTone[meter.tone]}"
                  style="width: {meter.remainingPercent}%"
                ></div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if supportsPermissions}
        <div class="flex flex-col gap-2">
          <span class={SHEET_SECTION_LABEL}>Mode</span>
          <div class={SEGMENT_GROUP}>
            {#each permissionOptions as mode (mode)}
              <button
                type="button"
                class={permissionMode === mode ? SEGMENT_ON : SEGMENT_OFF}
                onclick={() => selectPermissionMode(mode)}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <div class={SHEET_CARD}>
        <WebPushBell variant="row" />
      </div>
    </div>
  </MobileSheet>
</div>
