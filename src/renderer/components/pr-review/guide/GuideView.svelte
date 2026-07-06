<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { ReviewGuide, ReviewLedger } from "../../../../shared/review";
  import type { DiffComment } from "../../../../shared/types";
  import { markdownSanitizeUrl } from "../../../lib/markdownSanitize";
  import CodeSpan from "../../ui/CodeSpan.svelte";
  import { splitPatchByFile, type GuideDiffCommentSave } from "./lib/guide-data";
  import GuideSection from "./GuideSection.svelte";
  import GuideRail from "./GuideRail.svelte";

  const markdownRenderers = { codespan: CodeSpan };

  // The native guided-review surface: a centered walkthrough where each section
  // pairs a sticky "why" summary on the left with its scrolling diffs on the
  // right. The guide opens with a title + overview summary, then each section's
  // diffs scroll past until the next section comes up. Low-signal concerns
  // collapse into a single group, closed by default.
  let {
    guide,
    ledger,
    patch,
    meta,
    onFileJump,
    comments = [],
    onCommentSave,
    onCommentDelete,
  }: {
    guide: ReviewGuide;
    ledger: ReviewLedger | null;
    patch: string;
    /** PR identity for the intro header's metadata line (`repo#number · base ←
     *  branch`). Absent for standalone local-branch reviews. */
    meta?: { repo?: string; number?: number; baseRef: string; branch: string };
    /** Forwarded to each section so file chips can route to a host Diff tab. */
    onFileJump?: (path: string) => void;
    /** Review-draft comments + handlers, forwarded to every section's diff cards.
     *  Absent for the read-only standalone local-branch companion. */
    comments?: DiffComment[];
    onCommentSave?: (comment: GuideDiffCommentSave) => void;
    onCommentDelete?: (id: string) => void;
  } = $props();

  const patchByPath = $derived(splitPatchByFile(patch));
  const records = $derived(ledger?.records ?? []);

  const mainSections = $derived(guide.sections.filter((s) => s.significance !== "low-signal"));
  const lowSignalSections = $derived(guide.sections.filter((s) => s.significance === "low-signal"));

  // The guide owns its own scroller so the rail can pin to its viewport.
  let scrollEl = $state<HTMLElement | null>(null);
  const railItems = $derived(mainSections.map((s) => ({ id: s.id, title: s.title })));
</script>

<div class="relative min-h-0 flex-1">
  <GuideRail items={railItems} {scrollEl} />

  <div bind:this={scrollEl} class="h-full overflow-y-auto">
    {#if guide.sections.length > 0}
      <div class="mx-auto flex w-full max-w-[92rem] flex-col">
        <!-- Guide overview: a large title with PR identity + summary, given room
             to read before the diffs. -->
        <header class="guide-intro border-b border-(--solus-art-border) py-11 pr-8 pl-14">
          <h1 class="text-[2rem] leading-[1.15] font-bold tracking-tight text-balance text-(--solus-text-primary)">
            {guide.title}
          </h1>

          {#if meta}
            <div
              class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-(--solus-text-tertiary)"
            >
              {#if meta.repo}
                <span class="font-medium text-(--solus-text-secondary)">{meta.repo}#{meta.number}</span>
                <span class="opacity-50">·</span>
              {/if}
              <span class="inline-flex items-center gap-1.5 font-mono text-[0.75rem]">
                <span>{meta.baseRef}</span>
                <span aria-hidden="true">←</span>
                <span class="text-(--solus-text-secondary)">{meta.branch}</span>
              </span>
            </div>
          {/if}

          {#if guide.summary}
            <div class="prose-cloud prose-reading mt-4 max-w-[54rem] text-(--solus-text-secondary)">
              <SvelteMarkdown source={guide.summary} renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
            </div>
          {/if}
        </header>

        <div class="flex flex-col">
          {#each mainSections as section, i (section.id)}
            <GuideSection
              {section}
              {records}
              {patchByPath}
              {onFileJump}
              {comments}
              {onCommentSave}
              {onCommentDelete}
              index={i + 1}
              total={mainSections.length}
            />
          {/each}
        </div>

        {#if lowSignalSections.length > 0}
          <details class="group border-t border-(--solus-art-border)">
            <summary
              class="flex cursor-pointer list-none items-center gap-1.5 py-3.5 pr-8 pl-14 text-[0.8125rem] font-semibold text-(--solus-text-tertiary) select-none hover:text-(--solus-text-secondary)"
            >
              <span
                class="inline-block size-1.5 rotate-45 border-r-[1.5px] border-b-[1.5px] border-current transition-transform duration-150 group-open:rotate-[225deg]"
              ></span>
              Low-signal changes ({lowSignalSections.length})
            </summary>
            <div class="lowsig-body">
              {#each lowSignalSections as section (section.id)}
                <GuideSection
                  {section}
                  {records}
                  {patchByPath}
                  {onFileJump}
                  {comments}
                  {onCommentSave}
                  {onCommentDelete}
                />
              {/each}
            </div>
          </details>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Stagger the overview title + summary in on load, so the guide resolves
     instead of appearing all at once after the generation spinner. */
  .guide-intro > :global(*) {
    animation: guide-intro-in 0.4s ease-out backwards;
  }
  .guide-intro > :global(*:nth-child(2)) {
    animation-delay: 0.08s;
  }

  /* Fade the low-signal group in when the disclosure opens. */
  details[open] .lowsig-body {
    animation: lowsig-body-in 0.22s ease-out;
  }

  @keyframes guide-intro-in {
    from {
      opacity: 0;
      transform: translateY(0.375rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes lowsig-body-in {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .guide-intro > :global(*),
    details[open] .lowsig-body {
      animation: none;
    }
  }
</style>
