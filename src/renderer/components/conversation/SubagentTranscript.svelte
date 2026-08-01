<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CheckIcon, WarningCircleIcon } from "phosphor-svelte";
  import type { Message } from "../../../shared/types";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import {
    formatOffset,
    reportSections,
    subagentTail,
    subagentTimeline,
  } from "./lib/subagent-view";

  /**
   * §3a — the turn as it happened, and the artifact the Report tab filters. One
   * ordered stream: the dispatch that started it, the calls it made, the prose it
   * said along the way, and the block it finished on. Time hangs in the margin so
   * every step keeps one left edge, and tool calls fold into the same grouped
   * activity row the main thread uses rather than a step list of their own — a
   * run is read by its shape first and its calls second.
   */
  interface Props {
    message: Message;
    /** Hands the reader to the Report view: the final block lives in both, and
     *  the transcript prints its shape rather than reprinting its markdown. */
    onOpenReport: () => void;
  }
  let { message, onOpenReport }: Props = $props();

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    link: MarkdownLink,
    rawtext: MarkdownText,
  };

  const entries = $derived(subagentTimeline(message));
  const tail = $derived(subagentTail(message));
  const state = $derived(
    message.toolStatus === "running"
      ? "running"
      : message.toolResultIsError || message.toolStatus === "error"
        ? "failed"
        : "done",
  );

  // The rail the Report view will draw, so the closing block can say what shape
  // the answer came back in. Null when the agent wrote no ordered headings.
  const outline = $derived.by(() => {
    const report = entries.findLast((entry) => entry.kind === "text" && entry.isReport);
    return report?.kind === "text" ? reportSections(report.content) : null;
  });
</script>

<div class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-3 px-4 pt-[1.125rem] pb-8">
  {#each entries as entry, i (entry.kind === "dispatch" ? "dispatch" : entry.id)}
    <!-- Time hangs in the margin. Each entry type opens at a different vertical
         offset — a card's own padding, prose's cap height, a row's wash — so the
         numeral is nudged to sit on the first line of text rather than above it. -->
    <div
      class="font-mono text-[0.625rem] tabular-nums text-(--muted-foreground) opacity-45 {i === 0
        ? 'pt-3'
        : entry.kind === 'tools'
          ? 'pt-[1.0625rem]'
          : 'pt-[1.1875rem]'}"
    >
      {formatOffset(entry.offsetMs)}
    </div>

    <div class={i === 0 ? "" : entry.kind === "tools" ? "pt-2.5" : "pt-3"}>
      {#if entry.kind === "dispatch"}
        <!-- The brief is the one thing in the stream the agent didn't write, so
             it keeps a chassis: everything below it is the agent talking. -->
        <div
          class="rounded-xl bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] px-[0.8125rem] pt-[0.6875rem] pb-3 shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
        >
          <div class="mb-1.5 flex items-center gap-2">
            <span
              class="text-[0.59375rem] font-medium tracking-[0.12em] text-(--muted-foreground) uppercase opacity-70"
              >Dispatched by the main agent</span
            >
            <span class="flex-1"></span>
            <span class="font-mono text-[0.625rem] text-(--muted-foreground) opacity-50"
              >{entry.call}</span
            >
          </div>
          {#if entry.prompt}
            <p class="m-0 text-[0.84375rem] leading-normal whitespace-pre-wrap">
              {entry.prompt}
            </p>
          {/if}
          {#if entry.asks.length > 1}
            <!-- The prompt's own ordered list, which is what the Report rail
                 numbers against — so it is listed, never renumbered. -->
            <div class="mt-2 flex flex-col gap-0.5 pl-0.5">
              {#each entry.asks as ask, n (n)}
                <div class="flex items-baseline gap-2.5 text-[0.78125rem]">
                  <span
                    class="w-3.5 shrink-0 font-mono text-[0.65625rem] tabular-nums text-(--muted-foreground) opacity-50"
                    >{String(n + 1).padStart(2, "0")}</span
                  >
                  <span class="truncate text-(--muted-foreground)">{ask}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if entry.kind === "tools"}
        <ToolGroupItem tools={entry.tools} skipMotion />
      {:else if entry.isReport}
        <!-- The last block is the Report view. Printing its markdown here would
             make the tabs two copies of one thing, so the stream states its shape
             and hands over. -->
        <div
          class="mt-2.5 border-t border-[color-mix(in_oklch,var(--foreground)_12%,transparent)] pt-[1.125rem]"
        >
          <div class="mb-2 flex items-center gap-2">
            <span
              class="text-[0.59375rem] font-medium tracking-[0.12em] text-(--muted-foreground) uppercase opacity-70"
              >Final text block · shown as Report</span
            >
            <span class="flex-1"></span>
            {#if outline}
              <span class="font-mono text-[0.625rem] text-(--muted-foreground) opacity-50"
                >{outline.sections.length} heading{outline.sections.length === 1
                  ? ""
                  : "s"}</span
              >
            {/if}
          </div>
          {#if outline?.lead}
            <div class="prose-cloud prose-transcript min-w-0 max-w-[41rem]">
              <SvelteMarkdown
                source={outline.lead}
                renderers={markdownRenderers}
                sanitizeUrl={markdownSanitizeUrl}
              />
            </div>
          {/if}
          {#if outline}
            <div class="mt-2.5 flex flex-col gap-[0.4375rem]">
              {#each outline.sections as section (section.n)}
                <div class="flex items-baseline gap-2.5 text-[0.78125rem]">
                  <span
                    class="w-3.5 shrink-0 font-mono text-[0.65625rem] tabular-nums text-(--muted-foreground) opacity-50"
                    >{String(section.n).padStart(2, "0")}</span
                  >
                  <span class="truncate font-medium">{section.heading}</span>
                </div>
              {/each}
            </div>
          {/if}
          <button
            type="button"
            class="mt-3 cursor-pointer border-none bg-transparent p-0 text-left text-[0.78125rem] text-(--muted-foreground) underline decoration-dotted underline-offset-[3px] transition-colors hover:text-(--foreground)"
            onclick={onOpenReport}>Read the full answer in Report</button
          >
        </div>
      {:else}
        <!-- Mid-turn prose sits in the stream at full weight: it is the agent
             talking, not a tool. -->
        <div class="prose-cloud prose-transcript min-w-0 max-w-[41rem]">
          <SvelteMarkdown
            source={entry.content}
            renderers={markdownRenderers}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>
      {/if}
    </div>
  {/each}

  <div class="pt-5"></div>
  <div class="pt-[1.125rem]">
    <div
      class="-mx-2 flex items-center gap-2.5 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2 py-1.5"
    >
      <span
        class="inline-flex w-[1.125rem] shrink-0 items-center justify-center {state === 'failed'
          ? 'text-[color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]'
          : state === 'done'
            ? 'text-[color-mix(in_oklch,var(--solus-art-3)_62%,var(--foreground))]'
            : 'text-(--muted-foreground)'}"
        aria-hidden="true"
      >
        {#if state === "running"}
          <span class="activity-spinner"></span>
        {:else if state === "failed"}
          <WarningCircleIcon size={12} weight="regular" />
        {:else}
          <CheckIcon size={12} weight="bold" />
        {/if}
      </span>
      <span class="text-[0.78125rem]">{tail.label}</span>
      <span class="flex-1"></span>
      {#if tail.facts}
        <span
          class="shrink-0 font-mono text-[0.65625rem] tabular-nums text-(--muted-foreground) opacity-55"
          >{tail.facts}</span
        >
      {/if}
    </div>
  </div>
</div>
