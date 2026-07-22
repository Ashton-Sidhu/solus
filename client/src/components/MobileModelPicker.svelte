<script lang="ts">
  import { CaretRightIcon, CheckIcon, XIcon } from "phosphor-svelte";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from "@renderer/contexts";
  import { requestInputFocus } from "@renderer/lib/inputFocus";
  import { REASONING_EFFORT_LABELS } from "../../../src/shared/types";
  import type { ReasoningEffort } from "../../../src/shared/types";
  import { portal } from "@renderer/components/portal";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import { swipeDismiss } from "../lib/swipe-dismiss";

  const session = getWorkspaceContext();
  const agent = getAgentContext();
  const statusBar = getStatusBarContext();

  const ctx = $derived(statusBar.ctx);
  const sess = $derived(session.sessionFor(session.activeTabId));
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

  let open = $state(false);
  let effortExpanded = $state(false);

  registerBackOverlay("mobile-model-picker", () => open, () => (open = false));

  function toggle() {
    if (models.length === 0) return;
    open = !open;
  }

  function close() {
    open = false;
  }

  function selectModel(modelId: string) {
    if (isBusy) return;
    session.updateModelConfig({ modelId });
    close();
    requestAnimationFrame(() => requestInputFocus());
  }

  function selectReasoning(effort: ReasoningEffort) {
    session.updateModelConfig({ reasoningEffort: effort });
  }

  // ─── Sheet open/close animation (mirrors MobilePlusMenu) ───
  let hasMounted = $state(false);
  let visible = $state(false);
  let sheetEl: HTMLDivElement | undefined = $state();
  let backdropEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (open) hasMounted = true;
  });

  $effect(() => {
    if (!hasMounted) return;
    if (open) {
      visible = true;
      effortExpanded = false;
      requestAnimationFrame(() => {
        if (!sheetEl || !backdropEl) return;
        sheetEl.style.transform = "translateY(100%)";
        backdropEl.style.opacity = "0";
        requestAnimationFrame(() => {
          if (!sheetEl || !backdropEl) return;
          sheetEl.style.transition = "transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)";
          backdropEl.style.transition = "opacity 0.12s ease";
          sheetEl.style.transform = "";
          backdropEl.style.opacity = "";
        });
      });
    } else if (visible) {
      if (sheetEl && backdropEl) {
        sheetEl.style.transition = "transform 0.18s ease-in";
        backdropEl.style.transition = "opacity 0.12s ease";
        sheetEl.style.transform = "translateY(100%)";
        backdropEl.style.opacity = "0";
        const done = () => {
          // Bail if a reopen landed mid-close (see WebSidebarDrawer/MobilePlusMenu).
          if (open) return;
          visible = false;
          if (sheetEl) { sheetEl.style.transition = ""; sheetEl.style.transform = ""; }
          if (backdropEl) { backdropEl.style.transition = ""; backdropEl.style.opacity = ""; }
        };
        sheetEl.addEventListener("transitionend", done, { once: true });
        setTimeout(done, 200);
      } else {
        visible = false;
      }
    }
  });

  // Solus grouped bottom-sheet utilities — matches MobilePlusMenu's language.
  const groupCard = "flex flex-col rounded-xl overflow-hidden border border-(--solus-container-border) bg-(--solus-surface-hover)";
  const listRow =
    "flex items-center gap-3 w-full min-h-12 px-3.5 py-3 border-0 bg-transparent text-left cursor-pointer transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:opacity-40 disabled:cursor-default disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]";
  const rowDivider = "h-px bg-(--solus-container-border) opacity-60 ml-3.5";
</script>

{#if models.length > 0}
  <button
    type="button"
    class="inline-flex items-center gap-1.5 max-w-[11rem] shrink-0 px-2.5 py-1 rounded-full border-0 cursor-pointer bg-(--solus-surface-hover) transition-[background-color,transform] duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.97] active:bg-(--solus-accent-light) [-webkit-tap-highlight-color:transparent]"
    onclick={toggle}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <span class="truncate text-[0.8125rem] font-[550] text-(--solus-text-primary)">{activeLabel}</span>
    <span class="shrink-0 text-[0.8125rem] text-(--solus-text-tertiary)">{REASONING_EFFORT_LABELS[currentReasoning]}</span>
  </button>
{/if}

{#if hasMounted}
  <!-- Portaled to <body>: the input dock sets `contain: layout paint`, which
       would otherwise make these `position: fixed` overlays resolve against the
       dock and render inside the pill instead of from the screen bottom. -->
  <div use:portal={document.body} data-solus-ui>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="fixed inset-0 z-40 bg-black/35 [-webkit-tap-highlight-color:transparent]"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    onclick={close}
    onkeydown={(e) => e.key === "Escape" && close()}
  ></div>

  <!-- Frosted popover surface — matches the side drawer, dropdowns & plus menu.
       The sheet doesn't scroll; touch-none claims vertical drags for swipe-to-dismiss. -->
  <div
    bind:this={sheetEl}
    class="fixed bottom-0 inset-x-0 z-[41] rounded-t-[1.25rem] border-t border-(--solus-popover-border) bg-(--solus-popover-bg) backdrop-blur-[1.25rem] backdrop-saturate-[1.1] shadow-(--solus-popover-shadow) px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom,0px))] touch-none will-change-transform"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    role="dialog"
    aria-label="Select model"
    use:swipeDismiss={{ axis: "y", sign: 1, onDismiss: close, backdrop: () => backdropEl }}
  >
    <div class="w-9 h-1 mx-auto mb-3.5 rounded-[0.125rem] bg-(--solus-text-muted) opacity-30"></div>

    <div class="relative flex items-center justify-center h-9 mb-3">
      <button
        type="button"
        class="absolute left-0 flex items-center justify-center w-9 h-9 rounded-full border border-(--solus-container-border) cursor-pointer bg-(--solus-surface-hover) text-(--solus-text-secondary) transition-colors duration-[120ms] active:bg-(--solus-accent-light) active:text-(--solus-text-primary) [-webkit-tap-highlight-color:transparent]"
        aria-label="Close"
        onclick={close}
      >
        <XIcon size={18} weight="bold" />
      </button>
      <h2 class="text-[0.9375rem] font-semibold text-(--solus-text-primary)">Select model</h2>
    </div>

    <!-- Model list -->
    <div class={groupCard}>
      {#each models as m, i (m.id)}
        {@const isSelected = m.id === selectedModelId}
        {#if i > 0}<div class={rowDivider}></div>{/if}
        <button
          type="button"
          class={listRow}
          disabled={isBusy && !isSelected}
          onclick={() => selectModel(m.id)}
        >
          <span class="flex-1 min-w-0 truncate text-[0.9375rem] font-medium text-(--solus-text-primary)">{m.label}</span>
          {#if isSelected}
            <CheckIcon size={17} weight="bold" class="shrink-0 text-(--solus-accent)" />
          {/if}
        </button>
      {/each}
    </div>

    {#if isBusy}
      <p class="px-1 mt-2 text-[0.6875rem] text-(--solus-text-tertiary)">Stop the task to switch model.</p>
    {/if}

    <!-- Effort / reasoning -->
    {#if reasoningLevels.length > 1}
      <div class="mt-3 {groupCard}">
        <button
          type="button"
          class={listRow}
          aria-expanded={effortExpanded}
          onclick={() => (effortExpanded = !effortExpanded)}
        >
          <span class="flex-1 min-w-0 text-[0.9375rem] font-medium text-(--solus-text-primary)">Effort</span>
          <span class="shrink-0 text-[0.8125rem] text-(--solus-text-tertiary)">{REASONING_EFFORT_LABELS[currentReasoning]}</span>
          <span class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-200" class:rotate-90={effortExpanded}>
            <CaretRightIcon size={15} />
          </span>
        </button>

        {#if effortExpanded}
          {#each reasoningLevels as level (level)}
            <div class={rowDivider}></div>
            <button
              type="button"
              class="flex items-center gap-3 w-full px-3.5 py-2.5 border-0 bg-transparent text-left cursor-pointer transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) [-webkit-tap-highlight-color:transparent]"
              onclick={() => selectReasoning(level)}
            >
              <span class="flex-1 min-w-0 text-[0.875rem] text-(--solus-text-secondary)">{REASONING_EFFORT_LABELS[level]}</span>
              {#if currentReasoning === level}
                <CheckIcon size={16} weight="bold" class="shrink-0 text-(--solus-accent)" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
  </div>
{/if}
