<script lang="ts">
  import { CircleCheck as CheckCircleIcon, CircleAlert as CircleAlertIcon, CircleMinus as MinusCircleIcon, Clock as ClockIcon, LoaderCircle as CircleNotchIcon, ChevronRight as CaretRightIcon, RotateCw as RotateIcon } from "@lucide/svelte";
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
  // Only the states that say something the trailing action does not. The action
  // beside this row already reads "Generate" whenever no guide exists, so a
  // "Not generated yet" sub-line under it was the same fact twice on one row.
  const guideNote = $derived(
    guideStatus === "ready"
      ? "Ready to read"
      : guideStatus === "queued"
        ? "Queued"
        : guideStatus === "generating"
          ? "Generating…"
          : guideStatus === "failed"
            ? "Generation failed"
            : guideStatus === "outdated" ? "Outdated" : guideStatus === "cancelled" ? "Cancelled" : "",
  );

</script>

  {#if onGenerateGuide || onOpenGuide}
    <div class="flex min-h-11 w-full items-center gap-2 border-t border-[var(--hairline)] px-3.5 py-2 text-workspace-chrome">
      <ReviewGuideGlyph size={14} class="shrink-0 text-muted-foreground" />
      <span class="flex-1 whitespace-nowrap">Review guide</span>
      {#if guideNote}
        <span role="img" aria-label={guideNote} title={guideNote} class="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
          {#if guideStatus === "generating"}<CircleNotchIcon size={15} class="animate-spin motion-reduce:animate-none" />
          {:else if guideStatus === "queued"}<ClockIcon size={15} />
          {:else if guideStatus === "ready"}<CheckCircleIcon size={15} />
          {:else if guideStatus === "cancelled"}<MinusCircleIcon size={15} />
          {:else}<CircleAlertIcon size={15} />{/if}
        </span>
      {/if}
      {#if onOpenGuide && guideStatus}
        <button type="button" class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-[var(--wash-2)] pointer-coarse:size-10" aria-label="Open review guide" title="Open guide" onclick={onOpenGuide}><CaretRightIcon size={16} /></button>
      {/if}
      {#if onGenerateGuide}
        <button type="button" disabled={generatingGuide} class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-[var(--wash-2)] disabled:opacity-40 pointer-coarse:size-10" aria-label={guideStatus ? "Regenerate review guide" : "Generate review guide"} title={guideStatus ? "Regenerate guide" : "Generate guide"} onclick={onGenerateGuide}><RotateIcon size={15} /></button>
      {/if}
    </div>
  {/if}
