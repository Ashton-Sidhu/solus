<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { ChevronRight as CaretRightIcon, Lock as LockIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import FencedBlock from "./FencedBlock.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import { RAW_HTML_TOKEN, rawHtmlMarkedExtension } from "./lib/raw-html";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import { parseSubagentInput, subagentInputText } from "./lib/subagent";
  import {
    briefMeta,
    briefSummary,
    reportSections,
    reportText,
    writesClause,
  } from "./lib/subagent-view";

  /**
   * §2a — two blocks, each named for the question it answers. **Ask** is what
   * the main agent sent this one to do: its opening line and its numbered asks
   * stay in view, the prompt itself is one click away. **Findings** is what came
   * back: the verdict first, then one numbered section per heading the agent
   * wrote, each stating its finding before its evidence.
   *
   * Nothing here is written by the pane — both blocks are the agents' own
   * markdown, re-laid out so a reader can match ask 2 to finding 2 by eye.
   */
  interface Props {
    message: Message;
    running: boolean;
  }
  let { message, running }: Props = $props();

  // The transcript's rule, so a subagent's reply reads the same as the main
  // conversation's: an html fence carrying its own styles renders live.
  const markdownRenderers = {
    code: FencedBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
    rawtext: MarkdownText,
    [RAW_HTML_TOKEN]: HtmlBlock,
  };

  const markdownExtensions = [rawHtmlMarkedExtension];

  const brief = $derived(subagentInputText(parseSubagentInput(message.toolInput)));
  const summary = $derived(briefSummary(brief));

  const report = $derived(reportText(message));
  // Null when the agent didn't write one ordered heading per ask: the rail turns
  // off and the report renders as the plain markdown it is.
  const outline = $derived(reportSections(report));
  const sectionCount = $derived(outline?.sections.length ?? 0);
  const meta = $derived(briefMeta(summary.asks, sectionCount));

  let briefOpen = $state(false);
</script>

<!-- One block heading, used twice so the two blocks read as one system. -->
{#snippet blockHeading(label: string, detail: string)}
  <div class="mb-2.5 flex items-baseline gap-2.5">
    <h3
      class="m-0 text-[calc(0.9375rem*var(--solus-font-scale,1))] leading-tight font-semibold text-(--solus-text-primary)"
    >
      {label}
    </h3>
    {#if detail}
      <span class="text-transcript-meta text-(--muted-foreground) tabular-nums"
        >{detail}</span
      >
    {/if}
  </div>
{/snippet}

<div class="px-[1.125rem] pt-4 pb-8">
  {#if brief}
    <section class="mb-7" aria-label="Ask">
      {@render blockHeading("Ask", meta.join(" · "))}
      <!-- The brief keeps a chassis because it is the one thing on this tab the
           agent didn't write. Collapsed it is the shape of the work — the
           opening line and the asks; opened it is the prompt, verbatim. -->
      <div
        class="w-full rounded-xl bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] px-4 pt-3.5 pb-2.5 shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
      >
        {#if briefOpen}
          <!-- The prompt is markdown — the main agent wrote it that way, and its
               asks are a numbered list, not lines that happen to start with
               digits. `.prose-transcript` is unlayered, so its measure is
               released through the report step rather than a utility. -->
          <div class="prose-cloud prose-transcript prose-report min-w-0">
            <SvelteMarkdown
              source={brief}
              renderers={markdownRenderers}
              extensions={markdownExtensions}
              sanitizeUrl={markdownSanitizeUrl}
            />
          </div>
        {:else}
          {#if summary.title}
            <p
              class="m-0 text-[calc(0.875rem*var(--solus-font-scale,1))] leading-[1.6] text-pretty text-(--solus-text-primary) {summary.asks.length > 0
                ? 'line-clamp-3'
                : 'line-clamp-6'}"
            >
              {summary.title}
            </p>
          {/if}
          {#if summary.asks.length > 0}
            <!-- The asks are numbered the way the findings are, so ask 2 and
                 finding 2 can be matched by eye — the pane still never claims
                 that they do. -->
            <ol
              class="m-0 flex list-none flex-col gap-1.5 p-0 {summary.title
                ? 'mt-3'
                : ''}"
            >
              {#each summary.asks as ask, i (i)}
                <li
                  class="flex items-baseline gap-3 text-[calc(0.875rem*var(--solus-font-scale,1))] leading-[1.55] text-(--solus-text-primary)"
                >
                  <span
                    class="w-5 shrink-0 text-right text-transcript-meta font-medium text-(--muted-foreground) tabular-nums"
                    >{i + 1}</span
                  >
                  <span class="min-w-0 text-pretty">{ask}</span>
                </li>
              {/each}
            </ol>
          {/if}
        {/if}

        <div class="mt-3 flex items-center gap-3">
          <button
            type="button"
            class="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-transcript-meta font-medium text-(--muted-foreground) transition-colors hover:text-(--foreground) focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-(--solus-accent-border) focus-visible:outline-none"
            aria-expanded={briefOpen}
            onclick={() => (briefOpen = !briefOpen)}
          >
            <CaretRightIcon
              size={10}
              aria-hidden="true"
              class="transition-transform duration-150 {briefOpen ? 'rotate-90' : ''}"
            />
            {briefOpen ? "Hide full brief" : "Show full brief"}
          </button>
          <span class="flex-1"></span>
          <!-- The one fact about the run worth restating beside the brief:
               whether it touched the checkout at all. -->
          <span
            class="flex shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] py-0.5 pr-2 pl-1.5 text-transcript-meta font-medium text-(--muted-foreground)"
          >
            <LockIcon size={9} aria-hidden="true" />
            {writesClause(message)}
          </span>
        </div>
      </div>
    </section>
  {/if}

  <section aria-label="Findings">
    {@render blockHeading(
      "Findings",
      sectionCount > 0 ? `${sectionCount} section${sectionCount === 1 ? "" : "s"}` : "",
    )}

    {#if !report}
      <div
        class="text-[calc(0.875rem*var(--solus-font-scale,1))] text-(--muted-foreground)"
      >
        {running ? "Still working — the answer lands here." : "This agent returned no answer."}
      </div>
    {:else if !outline}
      <!-- No ordered headings, so no numbering — the same type, but nothing
           the agent didn't write. -->
      <div class="prose-cloud prose-transcript prose-report-lead min-w-0">
        <SvelteMarkdown
          source={report}
          renderers={markdownRenderers}
          extensions={markdownExtensions}
          sanitizeUrl={markdownSanitizeUrl}
        />
      </div>
    {:else}
      {#if outline.lead}
        <!-- The verdict leads, ahead of the evidence, on its own wash so it
             reads as the summary of everything under it. -->
        <div
          class="mb-2 rounded-xl bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] px-4 py-3"
        >
          <div class="prose-cloud prose-transcript prose-report-lead min-w-0">
            <SvelteMarkdown
              source={outline.lead}
              renderers={markdownRenderers}
              extensions={markdownExtensions}
              sanitizeUrl={markdownSanitizeUrl}
            />
          </div>
        </div>
      {/if}

      {#each outline.sections as section (section.n)}
        <article
          class="border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] pt-4 pb-5"
        >
          <!-- The heading is the agent's own, at reading size and sentence case:
               a label the reader scans for can't be the faintest thing on the
               tab. The numeral sits in a fixed slot so the headings share one
               left edge with the ask list above. -->
          <h4
            class="m-0 mb-2.5 flex items-baseline gap-3 text-[calc(0.9375rem*var(--solus-font-scale,1))] leading-[1.4] font-semibold text-(--solus-text-primary)"
          >
            <span
              class="w-5 shrink-0 text-right text-transcript-meta font-medium text-(--muted-foreground) tabular-nums"
              >{section.n}</span
            >
            <span class="min-w-0 text-pretty">{section.heading}</span>
          </h4>
          <div class="pl-8">
            {#if section.verdict}
              <!-- The section's own opening paragraph, at full weight: the
                   finding, before the evidence for it. -->
              <div
                class="mb-3 border-l-2 border-[color-mix(in_oklch,var(--primary)_55%,transparent)] pl-3"
              >
                <div
                  class="prose-cloud prose-transcript prose-report prose-report-verdict min-w-0"
                >
                  <SvelteMarkdown
                    source={section.verdict}
                    renderers={markdownRenderers}
                    extensions={markdownExtensions}
                    sanitizeUrl={markdownSanitizeUrl}
                  />
                </div>
              </div>
            {/if}
            {#if section.body}
              <div class="prose-cloud prose-transcript prose-report min-w-0">
                <SvelteMarkdown
                  source={section.body}
                  renderers={markdownRenderers}
                  extensions={markdownExtensions}
                  sanitizeUrl={markdownSanitizeUrl}
                />
              </div>
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  </section>
</div>
