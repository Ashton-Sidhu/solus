<script lang="ts">
  import { Hourglass as McpTaskIcon, CircleAlert as AlertIcon } from "@lucide/svelte";
  import { mcpTaskWake } from "@solus/contracts/integrations/mcp-task";
  import type { Message } from "@solus/contracts/types";
  import HostNoticeRow from "./HostNoticeRow.svelte";

  /** The end of an MCP task as a host notice (docs/plans/mcp-first-class.md
   *  §12.1): "Reports · create_report · completed", and the result opens from
   *  the row. The result is the server's data, so it shows as plain text,
   *  never as markdown (§3, rule 3). */
  let { message, skipMotion = false }: { message: Message; skipMotion?: boolean } = $props();

  const wake = $derived(mcpTaskWake(message.content));
  const failed = $derived(wake?.outcome === "failed");
</script>

<HostNoticeRow
  {message}
  label="MCP task"
  summary={wake ? `${wake.label} · ${wake.outcome}` : ""}
  attention={failed}
  {skipMotion}
  testid="mcp-task-notice-row"
>
  {#snippet glyph()}
    {#if failed}
      <AlertIcon size={11} aria-hidden="true" />
    {:else}
      <McpTaskIcon size={11} aria-hidden="true" />
    {/if}
  {/snippet}
  {#snippet detail()}
    {#if wake}
      <p class="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words text-transcript-card leading-relaxed text-foreground">{wake.body}</p>
    {/if}
  {/snippet}
</HostNoticeRow>
