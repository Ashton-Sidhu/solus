<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { Message } from "@solus/contracts/types";
  import ActivityRow from "./ActivityRow.svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import * as TooltipUI from "../ui/tooltip";

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
    /** Drawn in place of the summary while the row is folded: the news as
     *  icons. The caller keeps the summary for a screen reader. */
    marks?: Snippet;
    /** The news in one line, shown on hover or keyboard focus while the row
     *  is folded. A touch has no hover: a tap opens the row's full text. */
    tooltip?: string;
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
  let { message, label, summary, marks, tooltip, attention = false, glyph, detail, skipMotion = false, testid }: Props = $props();

  const markdownRenderers = { link: MarkdownLink, codespan: CodeSpan, rawtext: MarkdownText };

  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`notice:${message.id}`));

  // No refocus: opening the notice means the reader wants to read it.
  function toggle(): void {
    view.expanded = !view.expanded;
  }

  // The row's button sits inside the trigger, and focus does not bubble, so
  // keyboard focus opens the tooltip here. A pointer focus does not.
  let tooltipOpen = $state(false);
  function showOnKeyboardFocus(event: FocusEvent): void {
    if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) tooltipOpen = true;
  }
</script>

{#snippet summaryText()}{#if marks}{@render marks()}{:else}{summary}{/if}{/snippet}

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

<!-- `activity-host` opts this row out of the transcript's paint containment,
     which would otherwise clip the row's rounded chassis flat. -->
{#snippet host(triggerProps: HTMLAttributes<HTMLDivElement>)}
<div
  {...triggerProps}
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
  </ActivityRow>
</div>
{/snippet}

{#if tooltip}
  <TooltipUI.Root bind:open={tooltipOpen}>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <!-- The row's own button is the tab stop; the wrapper is not a second one. -->
        {@render host({
          ...tooltipProps,
          tabindex: undefined,
          onfocusin: showOnKeyboardFocus,
          onfocusout: () => (tooltipOpen = false),
        })}
      {/snippet}
    </TooltipUI.Trigger>
    {#if !view.expanded}
      <TooltipUI.Content side="top" align="start" value={tooltip} />
    {/if}
  </TooltipUI.Root>
{:else}
  {@render host({})}
{/if}
