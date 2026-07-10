<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { Message } from "../../../shared/types";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { groupSubMessages, subStats } from "./lib/subagent";
  import ToolGroupItem from "./ToolGroupItem.svelte";
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
  const stats = $derived(subStats(subs));
  const grouped = $derived(groupSubMessages(subs));

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
  {#if grouped.length === 0}
    {#if message.toolResult}
      <div class="prose-cloud prose-reading min-w-0 text-sm">
        <SvelteMarkdown
          source={message.toolResult.trim()}
          renderers={markdownRenderers}
          sanitizeUrl={markdownSanitizeUrl}
        />
      </div>
    {:else}
      <span class="text-xs text-(--solus-text-tertiary)">Starting up…</span>
    {/if}
  {/if}
</div>
