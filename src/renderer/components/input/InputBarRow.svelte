<script lang="ts">
  import { PaperclipIcon, CameraIcon, PencilIcon, PlusIcon, MinusIcon } from "phosphor-svelte";
  import InputBar from "./InputBar.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { tooltip } from "../../lib/tooltip";

  interface Props {
    mode: "pill" | "editor";
    onAttachFile: () => void;
    onScreenshot: () => void;
    onDesignMode: () => void;
  }
  let { mode, onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const sess = $derived(session.sessionFor(session.activeTabId));
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );

  // Hysteresis around the 1800px breakpoint: once crossed, don't flip back
  // until the width moves 50px past it. Stops the `zoom` (below) — and the
  // collapsed/expanded layout — from toggling, and visibly popping, every frame
  // when the window is dragged near 1800. $derived can't express this (it needs
  // the prior value), so an $effect is the right tool here.
  let isLaptop = $state(windowCtx.workAreaWidth < 1800);
  $effect(() => {
    const w = windowCtx.workAreaWidth;
    if (isLaptop && w >= 1850) isLaptop = false;
    else if (!isLaptop && w < 1800) isLaptop = true;
  });
  const isCollapsed = $derived(mode === "pill" || isLaptop);
  let actionsExpanded = $state(false);
</script>

<div class="flex w-full min-w-0 items-end px-1.5">
  {#if isCollapsed}
    <!-- Plus/minus toggle that expands to reveal all action buttons + git strip -->
    <div class="flex items-center flex-shrink-0" style="padding-bottom:0.375rem">
      <div class="flex items-center">
        <button
          class="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
          class:text-(--solus-text-muted)={isRunning}
          class:text-(--solus-text-tertiary)={!isRunning}
          onclick={() => (actionsExpanded = !actionsExpanded)}
          aria-label={actionsExpanded ? "Collapse actions" : "Expand actions"}
        >
          {#if actionsExpanded}
            <MinusIcon size={16} />
          {:else}
            <PlusIcon size={16} />
          {/if}
        </button>
        <div
          class="flex items-center transition-[max-width] duration-200 ease-out"
          class:max-w-0={!actionsExpanded}
          class:max-w-[6.75rem]={actionsExpanded}
          style="overflow-x: clip"
        >
          <button
            class="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
            title="Attach file (⌥⇧A)"
            onclick={onAttachFile}
            disabled={isRunning}
            class:text-(--solus-text-muted)={isRunning}
            class:text-(--solus-text-tertiary)={!isRunning}
          >
            <PaperclipIcon size={16} />
          </button>
          <button
            class="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
            title="Take screenshot (⌥⇧S)"
            onclick={onScreenshot}
            disabled={isRunning}
            class:text-(--solus-text-muted)={isRunning}
            class:text-(--solus-text-tertiary)={!isRunning}
          >
            <CameraIcon size={16} />
          </button>
          <button
            class="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
            title="Design mode (⌥⇧I)"
            onclick={onDesignMode}
            disabled={isRunning}
            class:text-(--solus-text-muted)={isRunning}
            class:text-(--solus-text-tertiary)={!isRunning}
          >
            <PencilIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  {:else}
    <!-- Full action buttons for editor mode on large screens -->
    <div class="flex items-center flex-shrink-0" style="padding-bottom:0.375rem">
      <button
        class="w-9 h-9 rounded-full flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
        use:tooltip={"Attach file (⌥⇧A)"}
        onclick={onAttachFile}
        disabled={isRunning}
        class:text-(--solus-text-muted)={isRunning}
        class:text-(--solus-text-tertiary)={!isRunning}
      >
        <PaperclipIcon size={16} />
      </button>
      <button
        class="w-9 h-9 rounded-full flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
        use:tooltip={"Take screenshot (⌥⇧S)"}
        onclick={onScreenshot}
        disabled={isRunning}
        class:text-(--solus-text-muted)={isRunning}
        class:text-(--solus-text-tertiary)={!isRunning}
      >
        <CameraIcon size={16} />
      </button>
      <button
        class="w-9 h-9 rounded-full flex items-center justify-center hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)]"
        use:tooltip={"Design mode (⌥⇧I)"}
        onclick={onDesignMode}
        disabled={isRunning}
        class:text-(--solus-text-muted)={isRunning}
        class:text-(--solus-text-tertiary)={!isRunning}
      >
        <PencilIcon size={16} />
      </button>
    </div>
  {/if}

  <div
    class="flex-shrink-0 mx-2 bg-(--solus-container-border)"
    style="width:0.0625rem;align-self:stretch;margin-top:0.5rem;margin-bottom:0.5rem;opacity:0.5"
  ></div>

  <div class="flex-1 min-w-0">
    <InputBar {mode} />
  </div>
</div>
