<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { assistantMarkdownOptions } from "./lib/assistant-markdown";
  import FencedBlock from "./FencedBlock.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";

  /**
   * The full text of the agent's thoughts. Callers mount it only while the
   * thought is open, so a closed thought costs no markdown parse. A long trace
   * scrolls inside its own box instead of pushing the answer away.
   */
  /** `step`: opened inside a tool group, so it matches the tool steps around it. */
  let { thoughts, step = false }: { thoughts: string[]; step?: boolean } = $props();

  const markdownRenderers = { code: FencedBlock, codespan: CodeSpan, link: MarkdownLink };
  // A reasoning summary can put one title per line; a single newline must stay
  // a line break rather than run the titles together.
  const thoughtMarkdownOptions = { ...assistantMarkdownOptions, breaks: true };
</script>

<div
  class="flex max-h-96 flex-col gap-3 overflow-y-auto overscroll-contain py-1 select-text"
  data-testid="thought-text"
>
  {#each thoughts as thought, i (i)}
    <div class="prose-cloud prose-transcript prose-thought response-markdown min-w-0" class:is-step={step}>
      <SvelteMarkdown
        source={thought}
        options={thoughtMarkdownOptions}
        renderers={markdownRenderers}
        sanitizeUrl={markdownSanitizeUrl}
      />
    </div>
  {/each}
</div>
