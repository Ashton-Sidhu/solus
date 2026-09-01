<script lang="ts">
  import {
    Copy as CopyIcon,
    ExternalLink as OpenIcon,
    Unlink as UnlinkIcon,
  } from "@lucide/svelte";
  import * as ContextMenu from "../ui/context-menu";

  interface Props {
    x: number;
    y: number;
    onOpen: () => void;
    onCopyReference: () => void;
    onUnlink: () => void;
    onClose: () => void;
  }

  let { x, y, onOpen, onCopyReference, onUnlink, onClose }: Props = $props();
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-40">
    <ContextMenu.Item
      onSelect={() => {
        onClose();
        onOpen();
      }}
    >
      <OpenIcon />
      Open
    </ContextMenu.Item>
    <ContextMenu.Item
      onSelect={() => {
        onClose();
        onCopyReference();
      }}
    >
      <CopyIcon />
      Copy Reference
    </ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item
      variant="destructive"
      onSelect={() => {
        onClose();
        onUnlink();
      }}
    >
      <UnlinkIcon />
      Unlink
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
