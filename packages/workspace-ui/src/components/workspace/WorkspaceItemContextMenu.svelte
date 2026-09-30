<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Columns3 as ColumnsIcon,
    Copy as CopyIcon,
    FolderOpen as FolderOpenIcon,
    Pin as PushPinIcon,
    Share as ShareIcon,
    Trash2 as TrashIcon,
    UserCheck as UserCheckIcon,
    Link as LinkIcon,
  } from "@lucide/svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";
  import type { WorkspaceItem } from "./lib/workspace-items";

  let {
    x,
    y,
    item,
    onOpen,
    onOpenSplit,
    onTogglePin,
    onOpenSession,
    onOpenSessionSplit,
    onShare,
    onRequestReview,
    onCopyReviewLink,
    onDelete,
    onClose,
  }: {
    x: number;
    y: number;
    item: WorkspaceItem;
    onOpen: () => void;
    onOpenSplit?: () => void;
    onTogglePin: () => void;
    onOpenSession?: () => void;
    onOpenSessionSplit?: () => void;
    /** Works only: open the Share dialog, which uploads a Local work first (organization-scope §7). */
    onShare?: () => void;
    /** Works only: open the work with its Review popover. */
    onRequestReview?: () => void;
    /** Works only: copy the link people outside the organization review through. */
    onCopyReviewLink?: () => void;
    onDelete?: () => void;
    onClose: () => void;
  } = $props();

  function select(action: () => void) {
    action();
    onClose();
  }

  async function copyId() {
    const itemId = item.id;
    onClose();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(itemId);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = itemId;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Workspace item ID copied");
    } catch {
      toasts.error("Couldn't copy workspace item ID");
    }
    requestInputFocus();
  }
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-48">
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <FolderOpenIcon />
      Open {item.type === "plan" ? "plan" : item.type === "diagram" ? "diagram" : "document"}
    </ContextMenu.Item>
    {#if onOpenSplit}
      <ContextMenu.Item onSelect={() => select(onOpenSplit)}>
        <ColumnsIcon />
        Open in split
      </ContextMenu.Item>
    {/if}
    {#if onOpenSession}
      <ContextMenu.Item onSelect={() => select(onOpenSession)}>
        <ArrowSquareOutIcon />
        Open source session
      </ContextMenu.Item>
    {/if}
    {#if onOpenSessionSplit}
      <ContextMenu.Item onSelect={() => select(onOpenSessionSplit)}>
        <ColumnsIcon />
        Open source session in split
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={() => select(onTogglePin)}>
      <PushPinIcon />
      {item.pinned ? "Unpin" : "Pin"}
    </ContextMenu.Item>

    {#if onShare}
      <ContextMenu.Item onSelect={() => select(onShare)} data-testid="share-item">
        <ShareIcon />
        Share…
      </ContextMenu.Item>
    {/if}

    {#if onRequestReview}
      <ContextMenu.Item onSelect={() => select(onRequestReview)} data-testid="request-review-item">
        <UserCheckIcon />
        Request review…
      </ContextMenu.Item>
    {/if}
    {#if onCopyReviewLink}
      <ContextMenu.Item onSelect={() => select(onCopyReviewLink)}>
        <LinkIcon />
        Copy review link
      </ContextMenu.Item>
    {/if}

    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => void copyId()}>
      <CopyIcon />
      Copy item ID
    </ContextMenu.Item>
    {#if onDelete}
      <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
        <TrashIcon />
        Delete {item.type === "diagram" ? "diagram" : "document"}
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
