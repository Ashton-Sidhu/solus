<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CornerLeftUp as BackIcon } from "@lucide/svelte";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import { jumpWithinReply, type Footnote } from "./lib/markdown-extensions";

  /** The notes of a reply, set small and muted under a rule. */
  let { footnotes }: { footnotes: Footnote[] } = $props();

  const markdownRenderers = { codespan: CodeSpan, link: MarkdownLink };
</script>

<section
  class="mt-5 border-t border-(--solus-tx-rule-strong) pt-3 text-xs text-(--solus-text-tertiary) [&_ol]:!my-0 [&_li+li]:!mt-1.5"
  role="doc-endnotes"
>
  <ol>
    {#each footnotes as footnote (footnote.id)}
      <li data-footnote={footnote.id} tabindex="-1" class="outline-none">
        <SvelteMarkdown source={footnote.text} isInline renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
        <button
          type="button"
          class="ml-1 inline-flex cursor-pointer items-center rounded-sm align-[-0.125rem] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Back to reference {footnote.id}"
          onclick={(event) => jumpWithinReply(event.currentTarget, `[data-footnote-ref="${CSS.escape(footnote.id)}"]`)}
        >
          <BackIcon class="size-3" aria-hidden="true" />
        </button>
      </li>
    {/each}
  </ol>
</section>
