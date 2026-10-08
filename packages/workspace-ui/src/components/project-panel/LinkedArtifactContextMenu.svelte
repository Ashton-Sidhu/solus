<script lang="ts">
  import {
    Copy as CopyIcon,
    ExternalLink as OpenIcon,
    Eye as WatchIcon,
    EyeOff as StopWatchingIcon,
    Unlink as UnlinkIcon,
  } from "@lucide/svelte";
  import * as ContextMenu from "../ui/context-menu";

  interface Props {
    x: number;
    y: number;
    onOpen: () => void;
    onCopyReference: () => void;
    onUnlink: () => void;
    /** Present when the row can be watched or is watched (docs/plans/pr-watch.md). */
    watch?: { isWatched: boolean; onToggle: () => void };
    onClose: () => void;
  }

  let { x, y, onOpen, onCopyReference, onUnlink, watch, onClose }: Props = $props();

  // Act first, close second. The caller holds the row this menu was opened for
  // in the same state `onClose` clears, and a `{@const}` capture of it is a
  // derived: closing first re-reads it as null and every action throws on the
  // link it was given. Closing after the action leaves that state intact.
  function select(action: () => void) {
    action();
    onClose();
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-40">
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <OpenIcon />
      Open
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => select(onCopyReference)}>
      <CopyIcon />
      Copy Reference
    </ContextMenu.Item>
    {#if watch}
      {@const toggle = watch.onToggle}
      <ContextMenu.Item onSelect={() => select(toggle)}>
        {#if watch.isWatched}
          <StopWatchingIcon />
          Stop Watching
        {:else}
          <WatchIcon />
          Watch Checks and Reviews
        {/if}
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Separator />
    <ContextMenu.Item
      variant="destructive"
      onSelect={() => select(onUnlink)}
    >
      <UnlinkIcon />
      Unlink
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
