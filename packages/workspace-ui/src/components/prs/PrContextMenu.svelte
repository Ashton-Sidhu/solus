<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Copy as CopyIcon,
    GitMerge as GitMergeIcon,
    GitPullRequest as GitPullRequestIcon,
    GitPullRequestArrow as GitPullRequestArrowIcon,
    GitPullRequestClosed as GitPullRequestClosedIcon,
    ListChecks as ListChecksIcon,
  } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import type { PrRowAction, PrRowActionKind } from "./lib/pr-row-actions";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";

  const ACTION_ICON = {
    merge: GitMergeIcon,
    close: GitPullRequestClosedIcon,
    reopen: GitPullRequestIcon,
    ready: GitPullRequestArrowIcon,
  } satisfies Record<PrRowActionKind, typeof GitMergeIcon>;

  let {
    x,
    y,
    pr,
    onOpen,
    onReview,
    onOpenWeb,
    actions,
    onAction,
    onClose,
  }: {
    x: number;
    y: number;
    pr: PullRequest;
    onOpen: () => void;
    onReview: () => void;
    onOpenWeb?: () => void;
    /** The row's lifecycle actions — the same list Shift shows on the row. */
    actions: PrRowAction[];
    onAction: (kind: PrRowActionKind) => void;
    onClose: () => void;
  } = $props();

  function select(action: () => void) {
    action();
    onClose();
  }

  async function copy(text: string, label: string) {
    onClose();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success(`${label} copied`);
    } catch {
      toasts.error(`Couldn't copy ${label.toLowerCase()}`);
    }
    requestInputFocus();
  }

</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-48">
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <GitPullRequestIcon />
      Open pull request
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => select(onReview)}>
      <ListChecksIcon />
      Review changes
    </ContextMenu.Item>
    {#if onOpenWeb}
      <ContextMenu.Item onSelect={() => select(onOpenWeb)}>
        <ArrowSquareOutIcon />
        Open in web
      </ContextMenu.Item>
    {/if}

    {#if actions.length > 0}
      <ContextMenu.Separator />
      {#each actions as action (action.kind)}
        {@const Icon = ACTION_ICON[action.kind]}
        <ContextMenu.Item onSelect={() => select(() => onAction(action.kind))}>
          <Icon />
          {action.menuLabel}
          <ContextMenu.Shortcut>⇧{action.key}</ContextMenu.Shortcut>
        </ContextMenu.Item>
      {/each}
    {/if}

    <ContextMenu.Separator />
    {#if pr.headRef}
      <ContextMenu.Item onSelect={() => void copy(pr.headRef, "Branch name")}>
        <CopyIcon />
        Copy branch name
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={() => void copy(pr.url, "Pull request link")}>
      <CopyIcon />
      Copy pull request link
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
