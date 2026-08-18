<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { Message } from "../../../shared/types";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import {
    formatOffset,
    reportSections,
    reportText,
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
   *
   * §4 finish: nothing tinted, nothing uppercase, nothing rounded. Sections open
   * on a hairline, labels are sentence case at body weight, numbers are tabular
   * mono at one size so the stream's right edge is a true column, and the only
   * colours are foreground and muted.
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
    image: MarkdownImage,
    link: MarkdownLink,
    rawtext: MarkdownText,
  };

  const entries = $derived(subagentTimeline(message));
  const tail = $derived(subagentTail(message));
  const state = $derived(
    message.toolStatus === "running"
      ? "running"
      : message.toolStatus === "error"
        ? "failed"
        : "done",
  );

  // The answer exists whether or not it is also the last block in this stream —
  // a blocking agent returns it as the tool result — so the hand-off at the end
  // is offered off the report itself, not off the entry that happens to carry it.
  const hasReport = $derived(!!reportText(message));

  // The rail the Report view will draw, so the closing block can say what shape
  // the answer came back in. Null when the agent wrote no ordered headings.
  const outline = $derived.by(() => {
    const report = entries.findLast((entry) => entry.kind === "text" && entry.isReport);
    return report?.kind === "text" ? reportSections(report.content) : null;
  });
</script>

<div class="text-sm text-xs grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-3 px-4 pt-[1.125rem] pb-8">
  {#each entries as entry, i (entry.kind === "dispatch" ? "dispatch" : entry.id)}
    <!-- Time hangs in the margin. Each entry type opens at a different vertical
         offset — a card's own padding, prose's cap height, a row's wash — so the
         numeral is nudged to sit on the first line of text rather than above it. -->
    <div
      class="tabular-nums text-(--muted-foreground) opacity-75 {i === 0
        ? 'pt-px'
        : entry.kind === 'tools'
          ? 'pt-[1.0625rem]'
          : 'pt-[1.1875rem]'}"
    >
      {formatOffset(entry.offsetMs)}
    </div>

    <div class={i === 0 ? "" : entry.kind === "tools" ? "pt-2.5" : "pt-3"}>
      {#if entry.kind === "dispatch"}
        <!-- The brief is the one thing in the stream the agent didn't write, so
             it is bound by a hanging rule rather than a box: a hairline says
             "this side is the instruction" without the tinted chassis turn 4
             took out, and it holds the label, the prompt and the asks as one
             object instead of three stacked blocks. -->
        <div
          class="flex flex-col gap-2 border-l border-[color-mix(in_oklch,var(--foreground)_12%,transparent)] pl-3"
        >
          <div class="flex items-baseline justify-between gap-3 ">
            <span class="min-w-0 truncate font-medium">Dispatched by the main agent</span>
            <span class="shrink-0 text-(--muted-foreground)"
              >{entry.call}</span
            >
          </div>
          {#if entry.prompt}
            <!-- The prompt is markdown, because the main agent wrote it that way:
                 its asks are a numbered list, not lines that happen to start with
                 digits. Rendering it whole also means the stream never prints a
                 second, truncated copy of the same list beneath it. Muted, since
                 the agent's own prose is the stream — but on the secondary step,
                 as the brief is what every entry below is measured against. -->
            <!-- `.prose-transcript` is unlayered, so its own `color` and
                 `max-width` outrank any utility here. Step the variable it reads
                 rather than fighting the cascade, and let its measure stand. -->
            <div
              class="prose-cloud prose-transcript min-w-0 [--solus-text-primary:var(--solus-text-secondary)]"
            >
              <SvelteMarkdown
                source={entry.prompt}
                renderers={markdownRenderers}
                sanitizeUrl={markdownSanitizeUrl}
              />
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
          <div class="mb-2 flex items-baseline gap-2">
            <span class="font-medium">Final answer</span>
            <span class="flex-1"></span>
            {#if outline}
              <span class="shrink-0 text-(--muted-foreground)"
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
            <div class="mt-2.5 flex flex-col gap-[0.1875rem]">
              {#each outline.sections as section (section.n)}
                <div class="flex items-baseline gap-2.5 ">
                  <span
                    class="shrink-0 tabular-nums text-(--muted-foreground)"
                    >{section.n}</span
                  >
                  <span class="truncate">{section.heading}</span>
                </div>
              {/each}
            </div>
          {/if}
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
    <!-- How the run ended, on a hairline rather than in a wash — the state is
         carried by the words and, when it failed, by the one colour that means it. -->
    <div
      class="flex items-baseline gap-2.5 border-t border-[color-mix(in_oklch,var(--foreground)_12%,transparent)] pt-2.5"
    >
      <span
        class="{state === 'failed'
          ? 'text-[color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]'
          : state === 'running'
            ? 'activity-shimmer'
            : 'text-(--muted-foreground)'}">{tail.label}</span
      >
      <span class="flex-1"></span>
      {#if tail.facts}
        <span
          class="shrink-0 tabular-nums text-(--muted-foreground)"
          >{tail.facts}</span
        >
      {/if}
    </div>
    {#if hasReport}
      <!-- The stream prints the answer's shape, never its markdown, so the last
           thing in the transcript is the way through to the full text. -->
      <button
        type="button"
        class="mt-2.5 cursor-pointer border-none bg-transparent p-0 text-left  text-(--muted-foreground) underline decoration-dotted underline-offset-[3px] transition-colors hover:text-(--foreground)"
        onclick={onOpenReport}>Read the full answer in Report</button
      >
    {/if}
  </div>
</div>
