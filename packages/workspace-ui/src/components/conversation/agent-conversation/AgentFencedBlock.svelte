<script lang="ts">
  import HtmlBlock from "../HtmlBlock.svelte";
  import {
    fenceIsSettled,
    fenceRenderMode,
    isHtmlFence,
  } from "../lib/html-block";
  import AgentCodeBlock from "./AgentCodeBlock.svelte";

  /**
   * The transcript's fence rule inside an exchange card. Same routing as
   * `FencedBlock`, over the card's own quieter code block: without this, an
   * agent's reply to another agent would render html differently from the
   * same reply in the main conversation.
   *
   * A card has no Render action on a snippet — the card is a quotation of a
   * conversation, not a surface the reader works in. The Report view is where
   * a subagent's output is read properly, and that uses `FencedBlock`.
   */
  interface Props {
    text: string;
    lang?: string;
    raw?: string;
  }

  let { text, lang, raw }: Props = $props();

  const isBlock = $derived(
    isHtmlFence(lang) &&
      fenceIsSettled(raw) &&
      fenceRenderMode(lang, text) === "block",
  );
</script>

{#if isBlock}
  <HtmlBlock html={text} />
{:else}
  <AgentCodeBlock {text} {lang} />
{/if}
