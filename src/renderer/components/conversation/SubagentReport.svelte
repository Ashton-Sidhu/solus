<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CaretRightIcon, LockIcon } from "phosphor-svelte";
  import type { Message } from "../../../shared/types";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import { parseSubagentInput, subagentInputText } from "./lib/subagent";
  import {
    briefAsks,
    briefMeta,
    reportSections,
    reportText,
    writesClause,
  } from "./lib/subagent-view";

  /**
   * §2a — the agent's answer, which is what the reader opened the pane for. The
   * verdict leads as a sentence at reading size, the evidence follows as numbered
   * sections, and the brief it was dispatched with folds away above — there for
   * checking, not for reading twice.
   *
   * Each section states its finding before its evidence: the heading becomes a
   * kicker and the paragraph the agent opened with takes a wash, so a reader can
   * take the five answers off the rail without reading a word of the support.
   * Neither is written here — both are the agent's own markdown, re-laid out.
   */
  interface Props {
    message: Message;
    running: boolean;
  }
  let { message, running }: Props = $props();

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    link: MarkdownLink,
    rawtext: MarkdownText,
  };

  const brief = $derived(subagentInputText(parseSubagentInput(message.toolInput)));
  const asks = $derived(briefAsks(brief));
  // The dispatch's first line is what it was sent to do; the rest is how.
  const briefTitle = $derived(brief.split("\n").find((line) => line.trim())?.trim() ?? "");

  const report = $derived(reportText(message));
  // Null when the agent didn't write one ordered heading per ask: the rail turns
  // off and the report renders as the plain markdown it is.
  const outline = $derived(reportSections(report));
  const meta = $derived(briefMeta(asks, outline?.sections.length ?? 0));

  let briefOpen = $state(false);
</script>

<div class="px-[1.125rem] pt-4 pb-8">
  {#if brief}
    <!-- The brief keeps a chassis because it is the one thing on this tab the
         agent didn't write. Collapsed it states what it asked for and what the
         run cost the checkout; opened it is the prompt, verbatim. -->
    <div
      class="mb-5 w-full rounded-xl bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
    >
      <button
        type="button"
        class="flex w-full cursor-pointer items-start gap-3 border-none bg-transparent px-[0.8125rem] pt-[0.6875rem] pb-2.5 text-left"
        aria-expanded={briefOpen}
        onclick={() => (briefOpen = !briefOpen)}
      >
        <span class="flex h-[1.0625rem] w-3.5 shrink-0 items-center justify-center opacity-45">
          <CaretRightIcon
            size={10}
            aria-hidden="true"
            class="text-(--muted-foreground) transition-transform duration-150 {briefOpen
              ? 'rotate-90'
              : ''}"
          />
        </span>
        <span class="min-w-0 flex-1">
          <span
            class="mb-1 block text-[0.59375rem] font-medium tracking-[0.12em] text-(--muted-foreground) uppercase opacity-70"
            >Dispatch brief · from you</span
          >
          <span class="block truncate text-[0.8125rem] font-medium">{briefTitle}</span>
          {#if meta.length > 0}
            <span
              class="mt-[0.1875rem] flex items-center gap-[0.4375rem] text-[0.71875rem] text-(--muted-foreground)"
            >
              {#each meta as clause, i (clause)}
                {#if i > 0}<span class="opacity-35" aria-hidden="true">·</span>{/if}
                <span>{clause}</span>
              {/each}
            </span>
          {/if}
        </span>
        <span
          class="mt-[0.875rem] flex shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] py-0.5 pr-2 pl-1.5 text-[0.65625rem] font-medium text-(--muted-foreground)"
        >
          <LockIcon size={9} aria-hidden="true" />
          {writesClause(message)}
        </span>
      </button>
      {#if briefOpen}
        <p
          class="m-0 pt-1 pr-[0.8125rem] pb-3 pl-[2.4375rem] text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-(--muted-foreground)"
        >
          {brief}
        </p>
      {/if}
    </div>
  {/if}

  {#if !report}
    <div class="text-[0.8125rem] text-(--muted-foreground)">
      {running ? "Still working — the answer lands here." : "This agent returned no answer."}
    </div>
  {:else if !outline}
    <!-- No ordered headings, so no rail and no washes — the same type, but
         nothing the agent didn't write. -->
    <div class="w-full">
      <div class="prose-cloud prose-transcript prose-report-lead min-w-0">
        <SvelteMarkdown
          source={report}
          renderers={markdownRenderers}
          sanitizeUrl={markdownSanitizeUrl}
        />
      </div>
    </div>
  {:else}
    {#if outline.lead}
      <!-- The verdict leads at reading size and ahead of the evidence. -->
      <div class="mb-1 w-full">
        <div class="prose-cloud prose-transcript prose-report-lead min-w-0">
          <SvelteMarkdown
            source={outline.lead}
            renderers={markdownRenderers}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>
      </div>
    {/if}

    <!-- Numbers hang in the margin rather than taking a column of their own, so
         the prose keeps one left edge from the verdict to the last section. -->
    <div class="mt-[0.875rem] grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      {#each outline.sections as section (section.n)}
        <!-- The numeral clears the rule by matching the body cell's own offset,
             plus enough to sit on the kicker's baseline rather than above it. -->
        <div
          class="font-mono text-[0.65625rem] tabular-nums text-(--muted-foreground) opacity-50 {section.n ===
          1
            ? 'pt-5'
            : 'pt-7'}"
        >
          {String(section.n).padStart(2, "0")}
        </div>
        <div
          class="min-w-0 border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] {section.n ===
          1
            ? 'pt-4'
            : 'mt-2 pt-6'}"
        >
          <div
            class="mb-1.5 text-[0.59375rem] font-medium tracking-[0.12em] text-(--muted-foreground) uppercase opacity-70"
          >
            {section.heading}
          </div>
          {#if section.verdict}
            <div
              class="mb-3 rounded-lg bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] px-3 py-[0.5625rem]"
            >
              <div class="prose-cloud prose-transcript prose-report min-w-0">
                <SvelteMarkdown
                  source={section.verdict}
                  renderers={markdownRenderers}
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
                sanitizeUrl={markdownSanitizeUrl}
              />
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
