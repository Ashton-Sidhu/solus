<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Copy as CopyIcon,
    ListChecks as ListChecksIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";
  import type { TaskPrChoice } from "./lib/task-list";

  /**
   * The menu of one pull request chip. A pull request is its own object in a
   * row, so its actions are here and not in the row's session or task menu.
   */
  interface Props {
    x: number;
    y: number;
    choice: TaskPrChoice;
    onOpen: () => void;
    onOpenWeb: () => void;
    /** Removes the link from the row that shows it. Absent for a pull request
     *  the row only reads from its checkout. */
    onUnlink?: () => void;
    onClose: () => void;
  }

  let { x, y, choice, onOpen, onOpenWeb, onUnlink, onClose }: Props = $props();

  const url = $derived(choice.url ?? choice.pullRequest?.url ?? null);

  function select(action: () => void) {
    onClose();
    action();
    requestInputFocus();
  }

  async function copyLink() {
    const link = url;
    onClose();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toasts.success("Pull request link copied");
    } catch {
      toasts.error("Couldn't copy the pull request link");
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
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <ListChecksIcon />
      Review pull request #{choice.number}
    </ContextMenu.Item>
    {#if url}
      <ContextMenu.Item onSelect={() => select(onOpenWeb)}>
        <ArrowSquareOutIcon />
        Open on GitHub
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => void copyLink()}>
        <CopyIcon />
        Copy link
      </ContextMenu.Item>
    {/if}
    {#if onUnlink}
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onSelect={() => select(onUnlink)}>
        <XIcon />
        Unlink
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
