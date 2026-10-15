<script lang="ts">
  import SvelteMarkdown, { type MarkedExtension, type Renderers, type SanitizeUrlFn, type SvelteMarkdownOptions } from "@humanspeak/svelte-markdown";
  import { untrack } from "svelte";
  import { settledMarkdownBlocks } from "./lib/settled-markdown";

  /** A finished reply: plain runs as HTML, the rest through the markdown
   *  component with the same renderers. A reply that cannot be split renders
   *  whole, as before. */
  let { source, options, renderers, extensions, sanitizeUrl }: {
    source: string;
    options: SvelteMarkdownOptions;
    renderers: Partial<Renderers>;
    extensions: MarkedExtension[];
    sanitizeUrl: SanitizeUrlFn;
  } = $props();

  // A reply that changes after it mounts is still being written: the markdown
  // component parses growing text incrementally, and splitting again on each
  // token would not.
  const mountedSource = untrack(() => source);
  const blocks = $derived(source === mountedSource ? settledMarkdownBlocks(source, extensions) : null);
</script>

{#if blocks}
  {#each blocks as block, index (index)}
    {#if "html" in block}
      <!-- Marked escaped every text run; plain blocks hold no links, images, or HTML. -->
      {@html block.html}
    {:else}
      <SvelteMarkdown source={block.tokens} {options} {renderers} {extensions} {sanitizeUrl} />
    {/if}
  {/each}
{:else}
  <SvelteMarkdown {source} {options} {renderers} {extensions} {sanitizeUrl} />
{/if}
