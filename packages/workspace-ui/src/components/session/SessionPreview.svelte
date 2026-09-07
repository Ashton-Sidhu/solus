<script lang="ts">
  import SvelteMarkdown, { type TextSnippetProps } from "@humanspeak/svelte-markdown";
  import { MessageCircle as ChatCircleIcon, ArrowRight as ArrowRightIcon } from "@lucide/svelte";
  import {
    composePreviewParts,
    type BoundedPreviewMessage,
    type HitWindow,
    type HitWindowMessage,
    type PreviewExtraction,
  } from "../../lib/sessionPreviewMessages";
  import type { AttentionState } from "../../lib/sessionUtils";
  import { highlightWordRuns } from "../../lib/searchHighlight";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import { Skeleton } from "../ui/skeleton";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import { assistantMarkdownOptions } from "../conversation/lib/assistant-markdown";
  import SessionStatusGlyph from "./SessionStatusGlyph.svelte";

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
  };

  interface Props {
    preview: PreviewExtraction | null;
    /** A search hit and its neighbours. The hit is shown between the
     *  transcript's ends when the row was found by its words: the reader
     *  searched for a passage, so the pane reads the opening prompt, the
     *  passage, and the last reply. */
    hitWindow?: HitWindow | null;
    loading: boolean;
    title?: string;
    byline?: string;
    timeAgo?: string | null;
    /** The picker's live search term. The row only shows a truncated title, so
     *  a query can match deep in the first message with nothing marked in the
     *  list — the preview is where that match becomes visible. Every word is
     *  marked on its own, the rule the list matched by. */
    query?: string;
    onContinue?: () => void;
    attention?: AttentionState;
  }
  let {
    preview,
    hitWindow = null,
    loading,
    title = "",
    byline = "",
    timeAgo = null,
    query = "",
    onContinue,
    attention,
  }: Props = $props();

  const hasSession = $derived(!!preview || !!hitWindow || loading);

  const titleRuns = $derived(highlightWordRuns(title, query));
  const bylineRuns = $derived(highlightWordRuns(byline, query));
  const parts = $derived(composePreviewParts(preview, hitWindow));
  const isEmpty = $derived(!parts.opening && !parts.hit && !parts.closing);
</script>

{#snippet wordMarked(text: string)}
  {#each highlightWordRuns(text, query) as run, i (i)}{#if run.hit}<mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >{:else}{run.text}{/if}{/each}
{/snippet}

{#snippet divider()}
  <div class="my-2 h-px w-full bg-[var(--solus-tx-rule)]" aria-hidden="true"></div>
{/snippet}

{#snippet highlightedMarkdownText({ text = "" }: TextSnippetProps)}
  {#each highlightWordRuns(text, query) as run, i (i)}
    {#if run.hit}
      <mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >
    {:else}
      {run.text}
    {/if}
  {/each}
{/snippet}

<!-- The opening prompt, as the reader typed it. -->
{#snippet openingPrompt(message: BoundedPreviewMessage)}
  <div class="flex justify-end pb-1.5 pt-3">
    <div
      class="prose-transcript-user max-w-[88%] overflow-hidden break-words rounded-2xl bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)] px-3 py-2.5 text-(--solus-text-primary)"
    >
      <SvelteMarkdown
        source={message.snippet}
        renderers={markdownRenderers}
        sanitizeUrl={markdownSanitizeUrl}
        text={highlightedMarkdownText}
      />
    </div>
  </div>
{/snippet}

<!-- The passage the words were found in, marked, in the voice that said it. -->
{#snippet hitPassage(message: HitWindowMessage)}
  {#if message.role === "user"}
    <div class="flex justify-end pb-1.5 pt-1.5">
      <div
        class="max-w-[88%] overflow-hidden break-words rounded-2xl bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)] px-3 py-2.5 text-(--solus-text-primary) shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_35%,transparent)]"
      >{@render wordMarked(message.passage)}</div>
    </div>
  {:else}
    <div
      class="w-full overflow-hidden break-words border-l-2 border-[color-mix(in_oklch,var(--primary)_45%,transparent)] py-2 pl-3 text-(--solus-text-primary)"
    >{@render wordMarked(message.passage)}</div>
  {/if}
{/snippet}

<!-- The last reply. -->
{#snippet lastReply(message: BoundedPreviewMessage)}
  <div class="w-full overflow-hidden whitespace-pre-wrap break-words py-2">
    <div class="prose-cloud prose-reading prose-transcript min-w-0">
      <SvelteMarkdown
        source={message.snippet}
        options={assistantMarkdownOptions}
        renderers={markdownRenderers}
        sanitizeUrl={markdownSanitizeUrl}
        text={highlightedMarkdownText}
      />
    </div>
  </div>
{/snippet}

<div class="text-workspace-chrome flex h-full min-w-0 flex-col">
  {#if hasSession && title}
    <div class="flex min-w-0 flex-shrink-0 items-center gap-3 px-[1.125rem] pb-2.5 pt-3">
      {#if attention !== undefined}
        <SessionStatusGlyph {attention} class="max-md:hidden" />
      {/if}
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          class="overflow-hidden text-ellipsis whitespace-nowrap font-medium leading-[1.3] text-[var(--solus-text-primary)]"
          title={title}
        >{#each titleRuns as run, i (i)}{#if run.hit}<mark
              class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
              >{run.text}</mark
            >{:else}{run.text}{/if}{/each}</div>
        <div class="flex min-w-0 items-center gap-1.5 text-[var(--solus-text-tertiary)]">
          {#if byline}<span
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              >{#each bylineRuns as run, i (i)}{#if run.hit}<mark
                    class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
                    >{run.text}</mark
                  >{:else}{run.text}{/if}{/each}</span
            >{/if}
          {#if byline && timeAgo}<span class="flex-shrink-0 opacity-50">·</span
            >{/if}
          {#if timeAgo}<span
              class="flex-shrink-0 whitespace-nowrap opacity-80 [font-variant-numeric:tabular-nums]"
              >{timeAgo}</span
            >{/if}
        </div>
      </div>
      {#if onContinue && preview}
        <button
          class="inline-flex min-h-8 flex-shrink-0 cursor-pointer items-center gap-[0.3125rem] rounded-lg bg-card px-[0.5625rem] py-[0.1875rem] font-medium text-(--solus-text-secondary) shadow-[shadow:var(--solus-tx-hairline)] transition-[background-color,color,transform] duration-150 hover:translate-x-[0.0625rem] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium)"
          onclick={onContinue}
        >
          <span>Continue</span>
          <ArrowRightIcon size={10} />
        </button>
      {/if}
    </div>
  {/if}

  {#if !preview && !hitWindow && !loading}
    <div class="flex h-full flex-col items-center justify-center gap-2.5">
      <ChatCircleIcon size={26} class="text-(--solus-text-muted) opacity-35" />
      <span class="text-[var(--solus-text-tertiary)]"
        >Select a session to preview</span
      >
    </div>
  {:else if loading}
    <div class="flex flex-1 flex-col gap-3 overflow-y-auto px-[1.125rem] pb-4 pt-1">
      <Skeleton class="ml-auto h-8 w-[62%] rounded-2xl" />
      <div class="flex flex-col gap-2 py-2">
        <Skeleton class="h-3 w-[82%] rounded-[0.375rem]" />
        <Skeleton class="h-3 w-[68%] rounded-[0.375rem]" />
      </div>
      <Skeleton class="ml-auto h-8 w-[48%] rounded-2xl" />
    </div>
  {:else}
    <!-- The opening prompt, then the passage the words were found in when the
         row was found by them, then the last reply, each part under a rule.
         The words are marked, so the eye lands on the reason this session is
         listed. -->
    <div class="flex flex-1 flex-col overflow-y-auto px-[1.125rem] pb-4 pt-0.5">
      {#if parts.opening}
        {@render openingPrompt(parts.opening)}
      {/if}
      {#if parts.hit}
        {#if parts.opening}
          {@render divider()}
        {/if}
        {@render hitPassage(parts.hit)}
      {/if}
      {#if parts.closing}
        {#if parts.opening || parts.hit}
          {@render divider()}
        {/if}
        {@render lastReply(parts.closing)}
      {/if}
      {#if isEmpty}
        <div class="flex h-full flex-col items-center justify-center gap-2.5 pt-10">
          <span class="text-[var(--solus-text-tertiary)]"
            >No messages</span
          >
        </div>
      {/if}
    </div>
  {/if}
</div>
