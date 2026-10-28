<script lang="ts">
  import { Copy as CopyIcon, Plus as PlusIcon } from "@lucide/svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";

  /** The menu of one project folder in the sidebar's project view. */
  interface Props {
    x: number;
    y: number;
    /** Absent when this person cannot start a session in the project now. */
    onNewSession?: () => void;
    /** The path of the project's checkout on its host. Absent for chats. */
    path?: string;
    onClose: () => void;
  }
  let { x, y, onNewSession, path, onClose }: Props = $props();

  async function copyPath(text: string) {
    onClose();
    try {
      await navigator.clipboard.writeText(text);
      toasts.success("Path copied");
    } catch {
      toasts.error("Couldn't copy the path");
    }
    requestInputFocus();
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-48">
    {#if onNewSession}
      <ContextMenu.Item
        onSelect={() => {
          onClose();
          onNewSession();
        }}
      >
        <PlusIcon />
        New session
      </ContextMenu.Item>
    {/if}
    {#if path}
      <ContextMenu.Item onSelect={() => void copyPath(path)}>
        <CopyIcon />
        Copy path
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
