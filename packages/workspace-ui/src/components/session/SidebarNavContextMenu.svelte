<script lang="ts">
  import { ArrowSquareOutIcon, ChatsIcon } from "phosphor-svelte";
  import * as ContextMenu from "../ui/context-menu";

  let {
    x,
    y,
    onOpen,
    onOpenInSplit,
    onClose,
  }: {
    x: number;
    y: number;
    onOpen: () => void;
    onOpenInSplit: () => void;
    onClose: () => void;
  } = $props();

  function select(action: () => void) {
    action();
    onClose();
  }
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-44">
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <ArrowSquareOutIcon />
      Open
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => select(onOpenInSplit)}>
      <ChatsIcon />
      Open in split
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
