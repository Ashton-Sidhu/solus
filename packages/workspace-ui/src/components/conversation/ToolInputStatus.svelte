<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import type { Message } from "@solus/contracts/types";
  import type { ToolHistoryStore } from "../../contexts/workspace/tool-history.store";

  let { tools, history }: { tools: Message[]; history: ToolHistoryStore } = $props();
  const loading = $derived(tools.some((tool) => tool.historyToolInput?.loading));
  const error = $derived(tools.find((tool) => tool.historyToolInput?.error)?.historyToolInput?.error);
</script>

{#if loading}
  <ContentSkeleton label="Loading tool details" />
{:else if error}
  <div role="status" class="flex items-center gap-2 py-1 text-xs text-(--muted-foreground)">
    <span>{error}</span>
    <button type="button" class="cursor-pointer underline" onclick={() => void history.load(tools)}>Retry</button>
  </div>
{/if}
