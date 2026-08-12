<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import MarkdownListItem from "../ui/MarkdownListItem.svelte";

  // The automation's prompt, read rather than edited: one reading column of
  // author-written prose set a step below the title. Numbered steps get a
  // gutter numeral, sub-points a muted dot, and paths/identifiers the terracotta
  // mono that means "a thing in the repo" — never a filled chip, which fragments
  // the line at this size.
  //
  // `codespan` is deliberately left as the plain `<code>` default: the shared
  // CodeSpan renderer promotes file-path-looking spans to token chips, which is
  // right in dense chrome and wrong in a reading column. Links keep MarkdownLink
  // so embedded plan / work / PR / file refs stay clickable.
  let { markdown }: { markdown: string } = $props();

  const renderers = { link: MarkdownLink, listitem: MarkdownListItem };
</script>

<div class="automation-prose">
  <SvelteMarkdown source={markdown} {renderers} sanitizeUrl={markdownSanitizeUrl} />
</div>

<style>
  /* Markdown is rendered by child components, so every rule below has to reach
     out of this component's scope with :global(). */
  .automation-prose {
    display: flex;
    flex-direction: column;
    gap: 1.625rem;
    font-size: 0.875rem;
    font-weight: 400;
    line-height: 1.75;
    /* One step below the title: full foreground competes with the h1, pure
       muted-foreground reads as a caption. The mix is the body voice. */
    color: color-mix(in oklab, var(--foreground) 78%, var(--muted-foreground));
    text-wrap: pretty;
  }

  .automation-prose :global(p) {
    margin: 0;
  }

  /* Space, not rules, separates steps. */
  .automation-prose :global(ol),
  .automation-prose :global(ul) {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .automation-prose :global(ol) {
    counter-reset: step;
    gap: 1.625rem;
  }

  /* Markers hang in the gutter from a positioned ::before, and the item's own
     content is left to flow as ordinary text.
     A list item's content is raw inline markup — a sentence with `code`, links
     and emphasis spliced through it. Laying the item out as a grid or flex row
     would promote every one of those inline elements to its own item and break
     the sentence into stacked fragments, so only the marker is taken out of
     flow. */

  /* Numbered step: a tabular numeral in a 1.625rem gutter (plus the 1rem gap)
     is the only structure a step needs — no rule, no card. */
  .automation-prose :global(ol > li) {
    counter-increment: step;
    position: relative;
    padding-left: 2.625rem;
    min-width: 0;
  }
  .automation-prose :global(ol > li)::before {
    content: counter(step, decimal-leading-zero);
    position: absolute;
    top: 0.375rem;
    left: 0;
    font-size: 0.75rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: color-mix(in oklab, var(--muted-foreground) 75%, transparent);
  }

  /* A step that qualifies itself keeps its lead sentence at body size and drops
     to a sub-list under it. */
  .automation-prose :global(li > ul),
  .automation-prose :global(li > ol),
  .automation-prose :global(li > p + p) {
    margin-top: 0.75rem;
  }

  /* Sub-points: a 0.1875rem dot sitting on the first line's optical centre —
     half the line box, less half the dot. */
  .automation-prose :global(ul) {
    gap: 0.5625rem;
    padding-left: 0.125rem;
  }
  .automation-prose :global(ul > li) {
    position: relative;
    padding-left: 0.9375rem;
    min-width: 0;
  }
  .automation-prose :global(ul > li)::before {
    content: "";
    position: absolute;
    top: 0.725rem;
    left: 0;
    width: 0.1875rem;
    height: 0.1875rem;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--muted-foreground) 55%, transparent);
  }
  /* One step down in size under a parent step, same colour — and a shorter line
     box, so the dot rides that much higher. */
  .automation-prose :global(li ul) {
    font-size: 0.875rem;
    line-height: 1.65;
  }
  .automation-prose :global(li ul > li)::before {
    top: 0.6rem;
  }

  /* Terracotta means "a thing in the repo": paths, filenames, branches, ids. */
  .automation-prose :global(code) {
    font-family: var(--solus-code-font-family);
    font-size: 0.8125rem;
    font-weight: 400;
    background: none;
    color: color-mix(in oklab, var(--primary) 78%, var(--foreground));
  }
  .automation-prose :global(pre) {
    margin: 0;
    padding: 0.625rem 0.75rem;
    overflow-x: auto;
    font-size: 0.8125rem;
    line-height: 1.6;
    border: 0.0625rem solid color-mix(in oklab, var(--border) 55%, transparent);
    border-radius: 0.5rem;
  }
  .automation-prose :global(pre code) {
    font-size: 1em;
    color: inherit;
  }

  /* An author's emphasis is honoured as colour, not weight — weight is reserved
     for the title and the eyebrows. */
  .automation-prose :global(strong) {
    font-weight: inherit;
    color: var(--foreground);
  }

  .automation-prose :global(h1),
  .automation-prose :global(h2),
  .automation-prose :global(h3),
  .automation-prose :global(h4) {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.5;
    color: var(--foreground);
  }

  .automation-prose :global(blockquote) {
    margin: 0;
    padding-left: 0.8em;
    border-left: 0.1875rem solid color-mix(in oklab, var(--border) 70%, transparent);
  }
</style>
