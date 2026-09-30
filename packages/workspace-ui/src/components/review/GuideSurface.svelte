<script lang="ts">
  import { CircleAlert as CircleAlertIcon, Clock as ClockIcon, Info as InfoIcon, LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import type { ReviewGuideStatus, ReviewGuideStatusEvent } from "@solus/contracts/review";
  import type { DiffComment } from "@solus/contracts/types";
  import type { GuideDiffCommentSave } from "../pr-review/guide/lib/guide-data";
  import GuideView from "../pr-review/guide/GuideView.svelte";
  import ReviewProgress from "./ReviewProgress.svelte";
  import ReviewGuideGlyph from "./ReviewGuideGlyph.svelte";
  import { Button } from "../ui/button";
  import type { GuideLoader } from "./lib/guide-loader.svelte";

  // Presentation for a loaded guide: stepped progress while loading (cache read
  // or generation), the native GuideView once data is ready, or an empty note.
  // Owns no chrome and no data loading — the host supplies the loader.
  let {
    loader,
    meta,
    onFileJump,
    comments = [],
    onCommentSave,
    onCommentDelete,
    emptyHint,
    generationStatus,
    generationEvent,
    unavailable = false,
    onCancel,
    onGenerate,
    onAlwaysGenerate,
  }: {
    loader: GuideLoader;
    /** PR identity for the guide's intro header; absent for local-branch reviews. */
    meta?: { repo?: string; number?: number; baseRef: string; branch: string };
    /** Routed to GuideView so file chips can switch a host's Diff tab. */
    onFileJump?: (path: string) => void;
    /** Review-draft comments + handlers for inline guide comments. */
    comments?: DiffComment[];
    onCommentSave?: (comment: GuideDiffCommentSave) => void;
    onCommentDelete?: (id: string) => void;
    /** What generating will cost, in this change's terms ("18 files · about a
     *  minute"). Hosts that can't size the change omit it. */
    emptyHint?: string;
    /** Durable background generation state for PR guides. Unlike the loader's
     *  local state, this survives leaving and reopening the review surface. */
    generationStatus?: ReviewGuideStatus;
    generationEvent?: ReviewGuideStatusEvent;
    unavailable?: boolean;
    onCancel?: () => void;
    /** Queue durable background generation. Standalone guides without this
     *  callback continue to generate through their local loader. */
    onGenerate?: () => void;
    /** Turn on generate-on-open, so the choice made here sticks. Absent where
     *  no such preference exists (local-branch reviews). */
    onAlwaysGenerate?: () => void;
  } = $props();

  const status = $derived(generationEvent?.status ?? generationStatus);
  const generationInProgress = $derived(status === "queued" || status === "generating");
  const stale = $derived(loader.stale || status === "outdated");
  const failure = $derived(generationEvent?.error || loader.error);
  const failed = $derived(status === "failed" || !!failure);
  const hasGuide = $derived(!!loader.guide);
  const step = $derived(generationEvent?.step ?? loader.progressStep);
  const phase = $derived(status === "queued" ? "Queued" : step === "analyzing" ? "Analyzing changes" : step === "writing" ? "Writing guide" : "Preparing changes");
</script>

<div class="text-sm flex min-h-0 flex-1 flex-col overflow-hidden">
  <!-- Notices above the guide: a hairline band on the faintest wash rather than
       a filled grey slab, led by the glyph for its state and closed by the one
       move that answers it. They sit at the chrome rung, so a notice never
       competes with the guide's own prose for the eye. -->
  {#if unavailable}
    <div role="status" class="flex shrink-0 items-center gap-2.5 border-b border-[var(--hairline)] bg-[var(--wash-1)] px-4 py-2 text-workspace-chrome text-muted-foreground">
      <InfoIcon size={14} class="shrink-0 opacity-70" aria-hidden="true" />
      <span class="min-w-0 flex-1">Guide status unavailable. Reconnect or reopen this view to check again.</span>
    </div>
  {:else if generationInProgress && hasGuide}
    <div role="status" class="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-[var(--hairline)] bg-[var(--wash-1)] px-4 py-2 text-workspace-chrome text-muted-foreground">
      {#if status === "queued"}
        <ClockIcon size={14} class="shrink-0 opacity-70" aria-hidden="true" />
      {:else}
        <SpinnerIcon size={14} class="shrink-0 animate-spin text-(--solus-accent) motion-reduce:animate-none" aria-hidden="true" />
      {/if}
      <span class="min-w-0 flex-1">{phase} · you can keep reading the saved guide.</span>
      {#if onCancel}<Button variant="ghost" size="xs" class="-my-0.5 shrink-0" onclick={onCancel}>Cancel</Button>{/if}
    </div>
  {:else if (failed || status === "cancelled") && hasGuide}
    <div role="status" class="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-[var(--hairline)] bg-[var(--wash-1)] px-4 py-2 text-workspace-chrome text-muted-foreground">
      <CircleAlertIcon size={14} class="shrink-0 {failed ? 'text-(--solus-art-negative)' : 'opacity-70'}" aria-hidden="true" />
      <span class="min-w-0 flex-1 break-words">{failed ? `Guide generation failed${failure ? `: ${failure}` : ""}` : "Guide generation cancelled"} · the saved guide is still available.</span>
      <Button variant="ghost" size="xs" class="-my-0.5 shrink-0" onclick={() => onGenerate ? onGenerate() : loader.refresh()}>Retry</Button>
    </div>
  {/if}
  {#if loader.freshnessUnknown && hasGuide && !unavailable && !stale}
    <div role="status" class="flex shrink-0 items-center gap-2.5 border-b border-[var(--hairline)] bg-[var(--wash-1)] px-4 py-2 text-workspace-chrome text-muted-foreground">
      <InfoIcon size={14} class="shrink-0 opacity-70" aria-hidden="true" />
      <span class="min-w-0 flex-1">Cannot check whether this guide is current. Refresh this view to check again.</span>
    </div>
  {/if}
  <!-- Not while a replacement is generating: that notice already says the
       saved guide is being superseded, and its Cancel is the only move that
       makes sense then. Outdated returns if the run fails or is cancelled. -->
  {#if stale && hasGuide && !generationInProgress}
    <div role="status" class="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-[var(--hairline)] bg-[var(--wash-1)] px-4 py-2 text-workspace-chrome text-muted-foreground">
      <CircleAlertIcon size={14} class="shrink-0 opacity-70" aria-hidden="true" />
      <span class="min-w-0 flex-1"><strong class="font-medium text-foreground">Outdated</strong> — the changes differ from this guide.</span>
      <Button variant="ghost" size="xs" class="-my-0.5 shrink-0" disabled={generationInProgress || unavailable} onclick={() => onGenerate ? onGenerate() : loader.refresh()}>Regenerate</Button>
    </div>
  {/if}
  {#if !hasGuide && !unavailable && (loader.loading || generationInProgress)}
    <ReviewProgress subject="guide" {step} queued={status === "queued"} onCancel={generationInProgress ? onCancel : undefined} />
  {:else if loader.guide}
    <GuideView
      guide={loader.guide}
      ledger={loader.ledger}
      patch={loader.patch}
      loadDiffFiles={loader.loadDiffFiles}
      {meta}
      {onFileJump}
      {comments}
      {onCommentSave}
      {onCommentDelete}
    />
  {:else}
    <!-- Guides are opt-in, so this is a real offer, not an error. Center it in
         the available guide canvas so returning to an empty tab has one clear
         focal point. -->
    <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto px-[clamp(20px,2.6cqi,56px)] py-10 text-workspace-chrome">
      <div class="flex max-w-[520px] flex-col items-center text-center">
        <!-- A neutral medallion, not an accent one: the accent belongs to the
             Generate button below, which is the actual offer. -->
        <span
          class="flex size-[44px] shrink-0 items-center justify-center rounded-2xl bg-[color:color-mix(in_oklab,var(--muted)_70%,transparent)] text-muted-foreground"
          aria-hidden="true"
        >
          <ReviewGuideGlyph size={20} />
        </span>

        <h2 class="mt-4  font-medium ">
          {failed ? "Guide generation failed" : status === "cancelled" ? "Guide generation cancelled" : status === "outdated" ? "The PR changed during generation" : "No guide yet"}
        </h2>

        <p
          class="mt-2  leading-[1.7] text-pretty text-muted-foreground"
        >
          {failure ?? (status === "outdated" ? "Generate a new guide for the current PR changes." :
            "Guides are opt-in. Generate one and the review companion reads the diff, orders the files into a narrative, and explains what each change is doing and why it matters.")}
        </p>

        <div class="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <Button
            type="button"
            class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-primary px-3.5  font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
            disabled={generationInProgress || unavailable}
            onclick={() => (onGenerate ? onGenerate() : loader.refresh())}
          >
            {failed || status === "cancelled" ? "Retry" : status === "outdated" ? "Regenerate" : "Generate guide"}
          </Button>
          {#if onAlwaysGenerate}
            <Button
              type="button"
              class="inline-flex h-[34px] cursor-pointer items-center rounded-lg border-0 bg-muted px-3  font-medium text-muted-foreground transition-colors hover:text-foreground"
              disabled={unavailable}
              onclick={onAlwaysGenerate}
            >
              Always generate on open
            </Button>
          {/if}
        </div>

        {#if emptyHint}
          <p
            class="mt-3 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
          >
            <ClockIcon size={12} class="shrink-0" />
            {emptyHint}
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>
