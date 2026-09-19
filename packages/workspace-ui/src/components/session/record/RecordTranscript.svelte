<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { Message } from "@solus/contracts/types";
  import { markdownSanitizeUrl } from "../../../lib/markdownSanitize";
  import { groupMessages, itemKey } from "../../conversation/lib/turns";
  import { assistantMarkdownOptions, assistantMarkdownExtensions } from "../../conversation/lib/assistant-markdown";
  import UserMessageBubble from "../../conversation/UserMessageBubble.svelte";
  import ToolGroupItem from "../../conversation/ToolGroupItem.svelte";
  import AnsweredQuestion from "../../conversation/AnsweredQuestion.svelte";
  import FencedBlock from "../../conversation/FencedBlock.svelte";
  import MarkdownLink from "../../conversation/MarkdownLink.svelte";
  import CodeSpan from "../../ui/CodeSpan.svelte";

  /**
   * A transcript with no tab behind it: the cloud's mirror of a session whose
   * runner is away. Prompts, prose, answered questions, and tool activity
   * render as they do in a conversation; the cards that need a live session
   * (plans, documents, artifacts, agent conversations) keep their tool rows
   * and nothing more.
   */
  let { messages }: { messages: Message[] } = $props();

  const items = $derived(groupMessages(messages));
  const markdownRenderers = { code: FencedBlock, codespan: CodeSpan, link: MarkdownLink };
</script>

<div class="flex flex-col" data-testid="session-record-transcript">
  {#each items as item (itemKey(item))}
    {#if item.kind === "user"}
      <UserMessageBubble message={item.message} skipMotion />
    {:else if item.kind === "assistant"}
      {#if item.message.content}
        <div class="prose-cloud prose-reading prose-transcript prose-transcript-main response-markdown min-w-0 py-2" data-testid="assistant-message">
          <SvelteMarkdown
            source={item.message.content}
            options={assistantMarkdownOptions}
            renderers={markdownRenderers}
            extensions={assistantMarkdownExtensions(item.message.content)}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>
      {/if}
    {:else if item.kind === "question"}
      <AnsweredQuestion message={item.message} />
    {:else if item.kind === "tool-group" || item.kind === "subagent-group"}
      <ToolGroupItem tools={item.messages} skipMotion />
    {:else if item.kind === "system"}
      {#if item.message.content}
        <p class="py-1 text-(--solus-text-tertiary)">{item.message.content}</p>
      {/if}
    {/if}
  {/each}
</div>
