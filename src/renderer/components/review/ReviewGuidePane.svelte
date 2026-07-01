<script lang="ts">
  import {
    XIcon,
    ArrowsClockwiseIcon,
    ArrowSquareOutIcon,
    ArrowsOutSimpleIcon,
  } from "phosphor-svelte";
  import type { PaneSlot } from "../../contexts/pane-view.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { tooltip } from "../../lib/tooltip";
  import GuideSurface from "./GuideSurface.svelte";
  import { GuideLoader } from "./lib/guide-loader.svelte";

  // The standalone guided-review surface (branch "Review changes" + session
  // walkthrough): own header + chrome over a read-only GuideView. The PR-review
  // host renders its own chrome and uses GuideLoader/GuideSurface directly.
  let {
    guideKey,
    scope = "branch",
    slot = "primary",
    onOpenInSplit,
    onClose,
  }: {
    guideKey: string;
    scope?: "branch" | "session";
    slot?: PaneSlot;
    onOpenInSplit?: () => void;
    onClose: () => void;
  } = $props();

  const session = getWorkspaceContext();
  const theme = getSettingsContext();
  const agentContext = getAgentContext();

  const loader = new GuideLoader({
    getCtx: () => session.ctx,
    getKey: () => guideKey,
    getScope: () => scope,
    getAgent: () => resolveReviewAgent(theme, agentContext),
  });

  // Refetch whenever the key changes (the pane is reused across branches).
  $effect(() => {
    void guideKey;
    void loader.load(false);
  });
</script>

<section class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  <header
    class="flex h-[var(--solus-chrome-row-h,2.9375rem)] shrink-0 items-center justify-between border-b border-[color:var(--solus-chrome-row-border,color-mix(in_srgb,var(--solus-container-border)_50%,transparent))] pr-2 pl-4"
  >
    <span class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
      >{scope === "session" ? "Session walkthrough" : "Review guide"}</span
    >
    <div class="inline-flex gap-1">
      {#if onOpenInSplit}
        <button
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
          onclick={onOpenInSplit}
          use:tooltip={slot === "secondary" ? "Move to main pane" : "Open in split"}
          aria-label={slot === "secondary" ? "Move review guide to main pane" : "Open review guide in split"}
        >
          {#if slot === "secondary"}
            <ArrowsOutSimpleIcon size={15} weight="bold" />
          {:else}
            <ArrowSquareOutIcon size={15} weight="bold" />
          {/if}
        </button>
      {/if}
      <button
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
        onclick={() => loader.refresh()}
        use:tooltip={"Regenerate review"}
        aria-label="Regenerate review guide"
      >
        <ArrowsClockwiseIcon size={15} weight="bold" />
      </button>
      <button
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
        onclick={onClose}
        use:tooltip={"Close"}
        aria-label="Close review guide"
      >
        <XIcon size={15} weight="bold" />
      </button>
    </div>
  </header>

  <GuideSurface {loader} />
</section>
