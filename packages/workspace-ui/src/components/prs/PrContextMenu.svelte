<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Copy as CopyIcon,
    GitPullRequest as GitPullRequestIcon,
    ListChecks as ListChecksIcon,
  } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";

  let {
    x,
    y,
    pr,
    onOpen,
    onReview,
    onOpenWeb,
    onClose,
  }: {
    x: number;
    y: number;
    pr: PullRequest;
    onOpen: () => void;
    onReview: () => void;
    onOpenWeb?: () => void;
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
