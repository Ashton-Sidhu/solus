<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { Message } from "../../../shared/types";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import {
    groupSubMessages,
    parseSubagentInput,
    subagentInputText,
    subStats,
  } from "./lib/subagent";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import UserMessageBubble from "./UserMessageBubble.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";

  interface Props {
    message: Message;
  }
  let { message }: Props = $props();

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    link: MarkdownLink,
  };

  const subs = $derived(message.subMessages ?? []);
  const input = $derived(
    subagentInputText(parseSubagentInput(message.toolInput)),
  );
  const stats = $derived(subStats(subs));
  const grouped = $derived(groupSubMessages(subs));

  // A backgrounded sub-agent's answer arrives only as the tool result (never as a
  // parented assistant_message), so it never lands in `subMessages`. Surface it as
  // a trailing block — unless the last assistant sub already IS that text (a
  // blocking sub-agent delivers it both ways), which would double it up.
  const lastAssistantSub = $derived(
    subs.findLast((m) => m.role === "assistant" && m.content.trim()),
  );
  const finalOutput = $derived.by(() => {
    const text = message.toolResult?.trim();
    if (!text) return "";
    if (lastAssistantSub?.content.trim() === text) return "";
    return text;
  });

  const countLabel = $derived(
    [
      stats.toolCount > 0
        ? `${stats.toolCount} ${stats.toolCount === 1 ? "tool" : "tools"}`
        : "",
      stats.filesTouched > 0
        ? `${stats.filesTouched} ${stats.filesTouched === 1 ? "file" : "files"}`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<div class="flex flex-col gap-2 px-4 pt-3 pb-3.5">
  {#if input}
    <UserMessageBubble content={input} skipMotion />
  {/if}
  {#if countLabel}
    <div
      class="text-[0.6875rem] leading-snug text-(--solus-text-tertiary) tabular-nums"
    >
      {countLabel}
    </div>
  {/if}
  {#each grouped as item (item.kind === "tool-group" ? `tg-${item.messages[0].id}` : item.message.id)}
    {#if item.kind === "tool-group"}
      <ToolGroupItem tools={item.messages} skipMotion />
    {:else}
      <div class="prose-cloud prose-reading min-w-0 text-sm">
        <SvelteMarkdown
          source={item.message.content.trim()}
          renderers={markdownRenderers}
          sanitizeUrl={markdownSanitizeUrl}
        />
      </div>
    {/if}
  {/each}
  {#if finalOutput}
    <div class="prose-cloud prose-reading min-w-0 text-sm">
      <SvelteMarkdown
        source={finalOutput}
        renderers={markdownRenderers}
        sanitizeUrl={markdownSanitizeUrl}
      />
    </div>
  {:else if grouped.length === 0}
    <span class="text-xs text-(--solus-text-tertiary)">Starting up…</span>
  {/if}
</div>
