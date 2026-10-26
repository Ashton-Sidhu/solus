<script lang="ts">
  import type { Snippet } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { Message } from "@solus/contracts/types";
  import ActivityRow from "./ActivityRow.svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";

  /**
   * A host-sent caption on the row every activity takes: a glyph, a fixed
   * label, and the news in a few words, with the full text folded behind the
   * row. The host's work is context for the agent's next turn, not a person's
   * words, so it is a caption, not a bubble of prose. The glyph alone takes a
   * colour, and only when the news needs the agent.
   */
  interface Props {
    message: Message;
    /** What sent it: "Pull request watch", "Background command". */
    label: string;
    /** The news in a few words, shown while the row is folded. */
    summary: string;
    /** The news needs the agent: the glyph takes the failure tone. */
    attention?: boolean;
    glyph: Snippet;
    /** The folded body. Absent, the message's text as markdown — right for a
     *  wake written as prose. A caller whose text carries a command's output
     *  supplies its own, so the output is not read as markdown. */
    detail?: Snippet;
    skipMotion?: boolean;
    testid?: string;
  }
  let { message, label, summary, attention = false, glyph, detail, skipMotion = false, testid }: Props = $props();

  const markdownRenderers = { link: MarkdownLink, codespan: CodeSpan, rawtext: MarkdownText };

  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`notice:${message.id}`));

  // No refocus: opening the notice means the reader wants to read it.
  function toggle(): void {
    view.expanded = !view.expanded;
  }
</script>

{#snippet summaryText()}{summary}{/snippet}

<!-- `activity-host` opts this row out of the transcript's paint containment,
     which would otherwise clip the row's rounded chassis flat. -->
<div
  class="activity-host {skipMotion ? '' : 'animate-msg-in-side'}"
  data-testid={testid}
  data-nav-msg-id={message.id}
>
  <ActivityRow
    expanded={view.expanded}
    onToggle={toggle}
    target={view.expanded || !summary ? undefined : summaryText}
    proseTarget
    glyphClass={attention ? "is-destructive" : ""}
    {glyph}
    detail={body}
  >
    {#snippet label()}{label}{/snippet}
    {#snippet body()}
      <div class="py-1 select-text" data-conversation-message-content data-conversation-message-id={message.id}>
        {#if detail}
          {@render detail()}
        {:else}
          <div class="prose prose-user">
            <SvelteMarkdown source={message.content} renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
          </div>
        {/if}
      </div>
    {/snippet}
  </ActivityRow>
</div>
