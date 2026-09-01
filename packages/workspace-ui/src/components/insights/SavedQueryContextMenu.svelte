<script lang="ts">
  import { Copy as CopyIcon, Play as PlayIcon, Trash2 as TrashIcon } from "@lucide/svelte";
  import type { SavedMetricsQuery } from "@solus/contracts/observability-types";
  import { copyText, toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";

  /**
   * Everything a saved question can have done to it, in one menu. The chip
   * itself keeps a single job — asking the question again — so the destructive
   * action is no longer a stray glyph beside every name.
   */
  let {
    x,
    y,
    query,
    canDelete,
    onOpen,
    onDelete,
    onClose,
  }: {
    x: number;
    y: number;
    query: SavedMetricsQuery;
    /** Mobile composes nothing, so it does not remove anything either. */
    canDelete: boolean;
    onOpen: () => void;
    onDelete: () => void;
    onClose: () => void;
  } = $props();

  function select(action: () => void): void {
    action();
    onClose();
  }

  async function copySql(sql: string): Promise<void> {
    onClose();
    await copyText(sql);
    toasts.success("Query copied");
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-44">
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <PlayIcon />
      Run query
    </ContextMenu.Item>
    {#if query.sql}
      <ContextMenu.Item onSelect={() => void copySql(query.sql ?? "")}>
        <CopyIcon />
        Copy SQL
      </ContextMenu.Item>
    {/if}
    {#if canDelete}
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
        <TrashIcon />
        Delete saved query
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
