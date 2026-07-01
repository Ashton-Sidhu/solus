<script lang="ts">
  import { ArrowSquareOutIcon } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { GuideSection, LedgerRecord } from "../../../../shared/review";
  import type { DiffComment } from "../../../../shared/types";
  import { tooltip } from "../../../lib/tooltip";
  import { fileTypeIcon } from "../../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../../diagram/iconify";
  import GuideFileDiff from "./GuideFileDiff.svelte";
  import { resolveLedgerRefs, type GuideDiffCommentSave } from "./lib/guide-data";
  import GuideExplanation from "./GuideExplanation.svelte";

  // Register the (lazy, ~12MB) `logos` icon set so file-type badges can resolve
  // their vibrant brand icons. Idempotent and shared with the diagram canvas.
  ensureIconCollections();

  // One concern in the walkthrough: a sticky "why" summary (title, explanation,
  // file list) on the left, beside the diffs it spans on the right. The reader
  // scrolls through the diffs while the summary stays pinned; when the diffs end,
  // the next section comes up. Diffs are heavy, so they lazy-mount near the
  // viewport. When index/total are set the section shows its place in the guide.
  let {
    section,
    records,
    patchByPath,
    onFileJump,
    comments = [],
    onCommentSave,
    onCommentDelete,
    index,
    total,
  }: {
    section: GuideSection;
    records: LedgerRecord[];
    patchByPath: Map<string, string>;
    /** When set, the diff-card "open" action routes here (the PR-review surface
     *  switches to its Diff tab) instead of opening a separate file editor. */
    onFileJump?: (path: string) => void;
    /** Review-draft comments across all files; filtered per card by path below.
     *  When `onCommentSave` is also set, the diff cards become comment-capable. */
    comments?: DiffComment[];
    onCommentSave?: (comment: GuideDiffCommentSave) => void;
    onCommentDelete?: (id: string) => void;
    index?: number;
    total?: number;
  } = $props();

  const sectionRecords = $derived(
    resolveLedgerRefs(section.ledgerRefs, records),
  );

  // Comments for a given card. Derived map so each card reads its slice without
  // re-filtering the whole list per render.
  const commentsByPath = $derived.by(() => {
    const m = new Map<string, DiffComment[]>();
    for (const c of comments) {
      const arr = m.get(c.filePath);
      if (arr) arr.push(c);
      else m.set(c.filePath, [c]);
    }
    return m;
  });

  // Uppercase file extension, shown as a small badge on chips and diff headers.
  function ext(path: string): string {
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : "·";
  }
  function fileName(path: string): string {
    return path.split("/").pop() ?? path;
  }
  function dirName(path: string): string {
    const i = path.lastIndexOf("/");
    return i > 0 ? path.slice(0, i + 1) : "";
  }

  // Diff cards on the right, keyed by path, so a left chip can scroll to its card.
  let cards = $state<Record<string, HTMLElement>>({});
  function jumpToCard(path: string): void {
    collapsed.delete(path);
    cards[path]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Per-file collapse for the diff cards; diffs are open by default.
  const collapsed = new SvelteSet<string>();
  function toggleCard(path: string): void {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
  }

  let sectionEl: HTMLElement | undefined = $state();
  let visible = $state(false);
  $effect(() => {
    if (!sectionEl || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          visible = true;
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(sectionEl);
    return () => observer.disconnect();
  });
</script>

<!-- Vibrant brand icon for known languages; monochrome extension badge otherwise. -->
{#snippet typeBadge(path: string)}
  {@const icon = fileTypeIcon(path)}
  {#if icon}
    <Icon {icon} width="14" height="14" class="shrink-0" />
  {:else}
    <span
      class="shrink-0 rounded bg-(--solus-accent-light) px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold text-(--solus-text-tertiary)"
    >
      {ext(path)}
    </span>
  {/if}
{/snippet}

<section
  bind:this={sectionEl}
  data-guide-section-id={section.id}
  class="grid items-start gap-x-10 gap-y-6 border-b border-(--solus-art-border) py-12 pr-8 pl-14 lg:grid-cols-[24rem_minmax(0,1fr)] xl:grid-cols-[28rem_minmax(0,1fr)]"
>
  <!-- Left: the "why", pinned while the diffs scroll past. -->
  <div class="guide-why flex flex-col gap-5 lg:sticky lg:top-12 lg:self-start">
    {#if index && total}
      <span
        class="tabular-nums text-[0.8125rem] font-semibold tracking-wide text-(--solus-text-tertiary)"
      >
        {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </span>
    {/if}

    <h2
      class="text-[1.125rem] leading-snug font-semibold tracking-tight text-balance text-(--solus-text-primary)"
    >
      {section.title}
    </h2>

    <GuideExplanation {section} records={sectionRecords} />

    {#if section.files.length > 0}
      <ul class="mt-1 flex flex-col gap-1.5">
        {#each section.files as file (file.path)}
          <li>
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-(--solus-art-border) bg-(--solus-art-surface) px-3 py-2 text-left transition-[border-color,background-color,scale] duration-150 ease-out hover:border-(--solus-accent) hover:bg-(--solus-accent-soft) active:scale-[0.98]"
              onclick={() => jumpToCard(file.path)}
            >
              {@render typeBadge(file.path)}
              <span
                class="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-(--solus-text-secondary)"
              >
                <span class="text-(--solus-text-primary)"
                  >{fileName(file.path)}</span
                >
                <span class="text-(--solus-text-tertiary)"
                  >{dirName(file.path)}</span
                >
              </span>
              {#if file.additions}
                <span
                  class="tabular-nums shrink-0 text-[0.75rem] text-(--solus-art-positive)"
                  >+{file.additions}</span
                >
              {/if}
              {#if file.deletions}
                <span
                  class="tabular-nums shrink-0 text-[0.75rem] text-(--solus-art-negative)"
                  >−{file.deletions}</span
                >
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Right: the diffs this section spans, in cards of similar width. -->
  <div class="flex min-w-0 flex-col gap-4">
    {#each section.files as file (file.path)}
      {@const patch = patchByPath.get(file.path)}
      {@const open = !collapsed.has(file.path)}
      <div
        bind:this={cards[file.path]}
        class="scroll-mt-6 overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
      >
        <div
          class="flex items-center gap-2 border-(--solus-art-border) px-3 py-2.5"
          class:border-b={open}
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            aria-expanded={open}
            aria-label={open
              ? `Collapse diff for ${fileName(file.path)}`
              : `Expand diff for ${fileName(file.path)}`}
            onclick={() => toggleCard(file.path)}
          >
            <span
              class="inline-block size-1.5 shrink-0 border-r-[1.5px] border-b-[1.5px] border-current text-(--solus-text-tertiary) transition-transform duration-150 {open
                ? 'rotate-[225deg]'
                : 'rotate-45'}"
            ></span>
            {@render typeBadge(file.path)}
            <span class="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
              <span class="text-(--solus-text-tertiary)"
                >{dirName(file.path)}</span
              >
              <span class="text-(--solus-text-primary)"
                >{fileName(file.path)}</span
              >
            </span>
          </button>
          {#if onFileJump}
            <button
              type="button"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[color,background-color,scale] duration-150 ease-out hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) active:scale-[0.92]"
              aria-label="Open in Diff tab"
              use:tooltip={"Open in Diff tab"}
              onclick={() => onFileJump?.(file.path)}
            >
              <ArrowSquareOutIcon size={14} weight="bold" />
            </button>
          {/if}
        </div>
        {#if open}
          <div class="overflow-x-auto">
            {#if visible && patch}
              <div class="guide-diff-in">
                <GuideFileDiff
                  {patch}
                  filePath={file.path}
                  comments={commentsByPath.get(file.path) ?? []}
                  onSaveComment={onCommentSave}
                  onDeleteComment={onCommentDelete}
                />
              </div>
            {:else if visible}
              <p
                class="guide-diff-in px-3 py-3 text-[0.75rem] text-(--solus-text-tertiary)"
              >
                Diff unavailable for this file (binary, or not in the current
                change).
              </p>
            {:else}
              <div class="h-24"></div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  /* Stagger the "why" column in on mount: number → title → explanation → files.
     opacity+translateY only (no blur/transform-fill) so no compositing layer
     lingers to blur text — matches the app's msg-in-up convention. */
  .guide-why > :global(*) {
    animation: guide-why-in 0.4s ease-out backwards;
  }
  .guide-why > :global(*:nth-child(2)) {
    animation-delay: 0.06s;
  }
  .guide-why > :global(*:nth-child(3)) {
    animation-delay: 0.12s;
  }
  .guide-why > :global(*:nth-child(4)) {
    animation-delay: 0.18s;
  }

  /* Diffs lazy-mount as they scroll near the viewport (and on expand); fade them
     in so they resolve rather than pop. Opacity-only keeps highlighted code crisp. */
  .guide-diff-in {
    animation: guide-diff-in 0.35s ease-out backwards;
  }

  @keyframes guide-why-in {
    from {
      opacity: 0;
      transform: translateY(0.375rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes guide-diff-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .guide-why > :global(*),
    .guide-diff-in {
      animation: none;
    }
  }
</style>
