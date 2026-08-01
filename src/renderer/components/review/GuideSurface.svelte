<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    BookOpenTextIcon,
    ClockIcon,
    SparkleIcon,
  } from "phosphor-svelte";
  import type { PrGuideStatus } from "../../../shared/review";
  import type { DiffComment } from "../../../shared/types";
  import type { GuideDiffCommentSave } from "../pr-review/guide/lib/guide-data";
  import GuideView from "../pr-review/guide/GuideView.svelte";
  import ReviewProgress from "./ReviewProgress.svelte";
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
    generationStatus?: PrGuideStatus;
    /** Queue durable background generation. Standalone guides without this
     *  callback continue to generate through their local loader. */
    onGenerate?: () => void;
    /** Turn on generate-on-open, so the choice made here sticks. Absent where
     *  no such preference exists (local-branch reviews). */
    onAlwaysGenerate?: () => void;
  } = $props();

  const generationInProgress = $derived(
    generationStatus === "queued" || generationStatus === "generating",
  );
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
  {#if loader.stale && loader.guide && !loader.loading}
    <div
      class="sticky top-0 z-10 flex items-center gap-2.5 border-b border-primary bg-secondary px-4 py-2 text-[11.5px] text-secondary-foreground"
      role="status"
    >
      <span class="min-w-0 flex-1 truncate">
        The change has new commits since this guide was written.
      </span>
      <button
        type="button"
        class="inline-flex h-[24px] shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[11.5px] font-medium hover:bg-muted"
        onclick={() => loader.refresh()}
      >
        <ArrowsClockwiseIcon size={11} />
        Regenerate
      </button>
    </div>
  {/if}
  {#if loader.loading && loader.guide === null}
    <ReviewProgress step={loader.progressStep} />
  {:else if loader.guide && loader.guide.sections.length > 0}
    <GuideView
      guide={loader.guide}
      ledger={loader.ledger}
      patch={loader.patch}
      loadDiffFiles={loader.loadDiffFiles}
      {meta}
      guideCurrent={!loader.stale}
      {onFileJump}
      {comments}
      {onCommentSave}
      {onCommentDelete}
    />
  {:else}
    <!-- Guides are opt-in, so this is a real offer, not an error. Center it in
         the available guide canvas so returning to an empty tab has one clear
         focal point. -->
    <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto px-[clamp(20px,2.6vw,56px)] py-10">
      <div class="flex max-w-[520px] flex-col items-center text-center">
        <!-- A neutral medallion, not an accent one: the accent belongs to the
             Generate button below, which is the actual offer. -->
        <span
          class="flex size-[44px] shrink-0 items-center justify-center rounded-2xl bg-[color:color-mix(in_oklab,var(--muted)_70%,transparent)] text-muted-foreground"
          aria-hidden="true"
        >
          <BookOpenTextIcon size={20} />
        </span>

        <h2 class="mt-4 text-[18px] font-semibold tracking-[-0.01em]">
          No guide yet for this pull request
        </h2>

        <p
          class="mt-2 text-[13.5px] leading-[1.7] text-pretty text-muted-foreground"
        >
          {loader.guide?.summary ??
            "Guides are opt-in. Generate one and the review companion reads the diff, orders the files into a narrative, and explains what each change is doing and why it matters."}
        </p>

        <div class="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <Button
            type="button"
            class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
            disabled={generationInProgress}
            onclick={() => (onGenerate ? onGenerate() : loader.refresh())}
          >
            {#if generationInProgress}
              <ArrowsClockwiseIcon
                size={13}
                class="shrink-0 animate-spin [animation-duration:1.2s] motion-reduce:animate-none"
              />
              Generating…
            {:else}
              <SparkleIcon size={13} weight="fill" class="shrink-0" />
              Generate guide
            {/if}
          </Button>
          {#if onAlwaysGenerate}
            <Button
              type="button"
              class="inline-flex h-[34px] cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              onclick={onAlwaysGenerate}
            >
              Always generate on open
            </Button>
          {/if}
        </div>

        {#if emptyHint}
          <p
            class="mt-3 flex items-center gap-1.5 text-[11.5px] tabular-nums text-muted-foreground"
          >
            <ClockIcon size={12} class="shrink-0" />
            {emptyHint}
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>
