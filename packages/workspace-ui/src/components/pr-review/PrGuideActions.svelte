<script lang="ts">
  import { LoaderCircle as CircleNotchIcon, RotateCw as RotateIcon } from "@lucide/svelte";
  import type { ReviewGuideStatus } from "@solus/contracts/review";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  let { guideStatus, onGenerateGuide, onOpenGuide }: {
    guideStatus?: ReviewGuideStatus;
    onGenerateGuide?: () => void;
    onOpenGuide?: () => void;
  } = $props();
  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  // Only the states that say something the actions do not. The row's actions
  // already read "Generate" whenever no guide exists and "Open" whenever one
  // can be read, and the regenerate control spins while a run is in flight —
  // so none of those facts is repeated as a note beside them.
  const guideNote = $derived(
    guideStatus === "queued"
      ? "Queued"
      : guideStatus === "failed"
        ? "Failed"
        : guideStatus === "outdated"
          ? "Outdated"
          : guideStatus === "cancelled"
            ? "Cancelled"
            : guideStatus === "ready" && !onOpenGuide
              ? "Ready"
              : "",
  );

</script>

<!-- One fact and its actions on a single line: the state as a word at the
     rail's far edge, the way a reviewer's verdict reads, then the move that
     changes it. A word beats a second glyph — three unlabelled icons in a row
     said nothing about which one opened the guide. -->
{#if onGenerateGuide || onOpenGuide}
  <div class="flex min-h-11 w-full items-center gap-2 border-t border-[var(--hairline)] px-3.5 py-2 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:min-h-10">
    <ReviewGuideGlyph size={14} class="shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate">Review guide</span>
    {#if guideNote}
      <span
        role="status"
        class="shrink-0 whitespace-nowrap text-xs {guideStatus === 'failed'
          ? 'text-(--solus-art-negative)'
          : 'text-muted-foreground'}"
      >
        {guideNote}
      </span>
    {/if}
    {#if onOpenGuide && guideStatus}
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--wash-2)] pointer-coarse:min-h-10 pointer-coarse:px-2.5"
        onclick={onOpenGuide}
      >
        Open
      </button>
    {/if}
    {#if onGenerateGuide}
      {#if guideStatus}
        <!-- A run in flight is the same control, spinning: the row says what it
             is doing where the move to redo it would be, so the state needs no
             word of its own. -->
        <button
          type="button"
          disabled={generatingGuide}
          class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:size-10"
          aria-label={guideStatus === "generating" ? "Generating review guide" : "Regenerate review guide"}
          title={guideStatus === "generating" ? "Generating guide…" : "Regenerate guide"}
          onclick={onGenerateGuide}
        >
          {#if guideStatus === "generating"}
            <CircleNotchIcon size={14} class="animate-spin text-(--solus-accent) motion-reduce:animate-none" />
          {:else}
            <RotateIcon size={14} class={generatingGuide ? "opacity-40" : ""} />
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--wash-2)] pointer-coarse:min-h-10 pointer-coarse:px-2.5"
          onclick={onGenerateGuide}
        >
          Generate
        </button>
      {/if}
    {/if}
  </div>
{/if}
