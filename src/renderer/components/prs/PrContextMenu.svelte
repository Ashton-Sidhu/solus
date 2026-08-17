<script lang="ts">
  import {
    ArrowSquareOutIcon,
    CopyIcon,
    GitPullRequestIcon,
    ListChecksIcon,
  } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";
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
    pr: PullRequestSummary;
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

  const prUrl = $derived(
    pr.baseRepo
      ? `https://${pr.baseRepo.host}/${pr.baseRepo.owner}/${pr.baseRepo.repo}/pull/${pr.number}`
      : null,
  );
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

    {#if pr.headRef || prUrl}
      <ContextMenu.Separator />
      {#if pr.headRef}
        <ContextMenu.Item onSelect={() => void copy(pr.headRef ?? "", "Branch name")}>
          <CopyIcon />
          Copy branch name
        </ContextMenu.Item>
      {/if}
      {#if prUrl}
        <ContextMenu.Item onSelect={() => void copy(prUrl ?? "", "Pull request link")}>
          <CopyIcon />
          Copy pull request link
        </ContextMenu.Item>
      {/if}
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
