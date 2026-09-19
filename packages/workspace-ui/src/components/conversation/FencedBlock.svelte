<script lang="ts">
  import { Play as PlayIcon } from "@lucide/svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import ConversationArtifact from "./ConversationArtifact.svelte";
  import { fenceArtifactIdentity } from "./lib/artifact-revisions";
  import { getArtifactRevisions, getArtifactMessage } from "./lib/artifact-revisions-context";
  import MermaidBlock from "./MermaidBlock.svelte";
  import { fenceIsSettled, fenceLanguage, fenceRenderMode, isHtmlFence } from "./lib/html-block";
  import { isMermaidFence, mermaidRenderMode, preloadMermaid } from "./lib/mermaid-block";

  /**
   * The `code` renderer for a reply: a fenced block, rendered as the thing it
   * is. Almost every fence is code. An html fence carrying its own styles,
   * behaviour, or document is a page, and renders live. A mermaid fence is a
   * diagram, and draws.
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
  const artifactRevisions = getArtifactRevisions();
  const artifactMessage = getArtifactMessage();
  const revisions = $derived(artifactRevisions?.().get(`fence:${fenceArtifactIdentity(lang)}`));
  const revision = $derived(revisions?.find((entry) => entry.messageId === artifactMessage?.() && entry.html === text));
  const mode = $derived.by(() => {
    if (!fenceIsSettled(raw)) return "code";
    if (isHtmlFence(lang)) return fenceRenderMode(lang, text);
    if (isMermaidFence(lang) && mermaidRenderMode(lang) === "diagram") return "diagram";
    return "code";
  });

  // A streaming mermaid fence will close in a moment; have the chunk warm by then.
  $effect(() => {
    if (mode === "code" && isMermaidFence(lang)) preloadMermaid();
  });

  // A snippet the reader chose to render. Not remembered: the reverse is the
  // Source action we hand the block, and neither outlives the message on screen.
  let rendered = $state(false);
</script>

{#if mode === "block"}
  {#if revisions && revision}
    <ConversationArtifact {revisions} {revision} />
  {:else}
    <HtmlBlock html={text} />
  {/if}
{:else if mode === "diagram"}
  <MermaidBlock {text} />
{:else if rendered}
  <HtmlBlock html={text} onShowSource={() => (rendered = false)} />
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
