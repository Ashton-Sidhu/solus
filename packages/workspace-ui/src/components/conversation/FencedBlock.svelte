<script lang="ts">
  import { Play as PlayIcon } from "@lucide/svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import { fenceIsSettled, fenceLanguage, fenceRenderMode, isHtmlFence } from "./lib/html-block";

  /**
   * The `code` renderer for a reply: a fenced block, rendered as the thing it
   * is. Almost every fence is code. An html fence carrying its own styles,
   * behaviour, or document is a page, and renders live.
   *
   * Order matters and the easy implementation gets it wrong. While the message
   * streams, a fence is source no matter what it holds — swapping to a frame
   * per token would rebuild an iframe at the rate the model writes. Only once
   * the closing delimiter arrives does the content decide.
   *
   * `raw` and `lang` come from the markdown token: `lang` is the whole info
   * string, so `html render` reaches us intact and the highlighter never sees
   * the directive.
   */
  interface Props {
    text: string;
    lang?: string;
    raw?: string;
  }

  let { text, lang, raw }: Props = $props();

  const language = $derived(fenceLanguage(lang));
  const mode = $derived(
    isHtmlFence(lang) && fenceIsSettled(raw) ? fenceRenderMode(lang, text) : "code",
  );

  // A snippet the reader chose to render. Not remembered: the reverse is the
  // block's own Source toggle, and neither outlives the message on screen.
  let rendered = $state(false);
</script>

{#if mode === "block" || rendered}
  <HtmlBlock html={text} />
{:else if mode === "snippet"}
  <CodeBlock {text} lang={language}>
    {#snippet actions()}
      <button
        type="button"
        class="solus-code-action"
        data-testid="html-snippet-render"
        onclick={() => (rendered = true)}
      >
        <PlayIcon size={11} />
        Render
      </button>
    {/snippet}
  </CodeBlock>
{:else}
  <CodeBlock {text} lang={language} />
{/if}
