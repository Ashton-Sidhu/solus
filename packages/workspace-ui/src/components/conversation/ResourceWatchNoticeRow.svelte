<script lang="ts">
  import { Eye as ResourceWatchIcon } from "@lucide/svelte";
  import { resourceWatchWake } from "@solus/contracts/integrations/resource-watch";
  import type { Message } from "@solus/contracts/types";
  import HostNoticeRow from "./HostNoticeRow.svelte";

  /** A change of a watched MCP resource as a host notice
   *  (docs/plans/mcp-first-class.md §11.5): "Docs · Release notes", and the
   *  contents open from the row. They are the server's data, so they show as
   *  plain text, never as markdown (§3, rule 3). */
  let { message, skipMotion = false }: { message: Message; skipMotion?: boolean } = $props();

  const wake = $derived(resourceWatchWake(message.content));
</script>

<HostNoticeRow
  {message}
  label="Resource watch"
  summary={wake ? `${wake.label} · changed` : ""}
  {skipMotion}
  testid="resource-watch-notice-row"
>
  {#snippet glyph()}
    <ResourceWatchIcon size={11} aria-hidden="true" />
  {/snippet}
  {#snippet detail()}
    {#if wake}
      <p class="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words text-transcript-card leading-relaxed text-foreground">{wake.body}</p>
    {/if}
  {/snippet}
</HostNoticeRow>
