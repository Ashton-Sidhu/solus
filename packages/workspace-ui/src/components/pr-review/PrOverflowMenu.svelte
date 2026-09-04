<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    RefreshCw as ArrowsClockwiseIcon,
    MessageCircleQuestion as ChatCircleQuestionIcon,
    Ellipsis as DotsThreeIcon,
    GitPullRequest as GitPullRequestIcon,
    Hammer as HammerIcon,
    Link as LinkIcon,
    Pen as PencilSimpleIcon,
  } from "@lucide/svelte";
  import type { PrLifecycleAction, PullRequest } from "@solus/contracts/providers";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // Pull request actions that do not need a permanent button. The menu rides
  // in the status card beside the merge state, so the PR-aware agent handoffs
  // and host commands stay available even when the rail moves under the title.
  let {
    pr,
    detail,
    showRemoteLink,
    prUrl,
    onOpenRemote,
    onAskQuestion,
    onFixComments,
    askQuestionBusy = false,
    fixCommentsBusy = false,
    onRefresh,
    onLifecycleAction,
  }: {
    pr: { host?: string };
    detail: PullRequest | null;
    showRemoteLink: boolean;
    prUrl: string | null;
    onOpenRemote: () => void;
    onAskQuestion?: () => void;
    onFixComments?: () => void;
    askQuestionBusy?: boolean;
    fixCommentsBusy?: boolean;
    onRefresh?: () => void;
    onLifecycleAction?: (
      action: Exclude<PrLifecycleAction, "merge">,
    ) => Promise<void>;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let lifecycleAction = $state<Exclude<PrLifecycleAction, "merge"> | null>(null);

  const allowedActions = $derived(new Set(detail?.viewerPermissions.actions ?? []));
  const hasLifecycleAction = $derived(
    !!onLifecycleAction &&
      ((detail?.state === "open" && detail.draft && allowedActions.has("ready")) ||
        (detail?.state === "open" && !detail.draft && allowedActions.has("draft")) ||
        (detail?.state === "open" && allowedActions.has("close")) ||
        (detail?.state === "closed" && allowedActions.has("reopen"))),
  );
  const hasItems = $derived(
    !!onAskQuestion ||
      !!onFixComments ||
      (showRemoteLink && !!prUrl) ||
      !!prUrl ||
      !!onRefresh ||
      hasLifecycleAction,
  );

  function runAction(action: () => void) {
    open = false;
    action();
    requestInputFocus();
  }

  async function copyPullRequestLink() {
    if (!prUrl) return;
    open = false;
    await copyText(prUrl);
    requestInputFocus();
  }

  async function updateLifecycle(action: Exclude<PrLifecycleAction, "merge">) {
    if (!onLifecycleAction || lifecycleAction) return;
    open = false;
    lifecycleAction = action;
    try {
      await onLifecycleAction(action);
    } catch (error) {
      toasts.error("Couldn't update the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lifecycleAction = null;
      requestInputFocus();
    }
  }
</script>

{#if hasItems}
  <Button
    bind:ref={triggerEl}
    variant="ghost"
    size="icon-sm"
    class="size-6 shrink-0 cursor-pointer rounded-full bg-transparent p-0 text-muted-foreground transition-colors hover:bg-[var(--wash-3)] hover:text-foreground"
    aria-label="More pull request actions"
    aria-haspopup="menu"
    aria-expanded={open}
    title="More actions"
    onclick={() => (open = !open)}
  >
    <DotsThreeIcon size={14} weight="bold" />
  </Button>

  <DropdownMenu.Root bind:open>
    <DropdownMenu.Content
      customAnchor={triggerEl}
      side="bottom"
      align="end"
      sideOffset={6}
      class="w-[min(23rem,calc(100vw-2rem))]"
      onInteractOutside={(event) => {
        if (triggerEl?.contains(event.target as Node)) event.preventDefault();
      }}
    >
      {#if onRefresh}
        <DropdownMenu.Item onSelect={() => runAction(onRefresh)}>
          <ArrowsClockwiseIcon size={14} />
          Refresh
        </DropdownMenu.Item>
      {/if}
      {#if onAskQuestion}
        <DropdownMenu.Item
          disabled={askQuestionBusy}
          class="h-auto min-h-11 items-start gap-2.5 py-2"
          onSelect={() => runAction(onAskQuestion)}
        >
          <ChatCircleQuestionIcon size={14} class="mt-0.5 shrink-0" />
          <span class="flex min-w-0 flex-1 flex-col gap-px">
            <span>{askQuestionBusy ? "Preparing…" : "Ask a question"}</span>
            <span class="text-xs leading-[1.35] text-muted-foreground">
              Opens a PR-aware session composer with an editable question.
            </span>
          </span>
        </DropdownMenu.Item>
      {/if}
      {#if onFixComments}
        <DropdownMenu.Item
          disabled={fixCommentsBusy}
          onSelect={() => runAction(onFixComments)}
        >
          <HammerIcon size={14} />
          {fixCommentsBusy ? "Preparing…" : "Draft fixes for comments"}
        </DropdownMenu.Item>
      {/if}

      {#if prUrl}
        <DropdownMenu.Separator />
      {/if}
      {#if showRemoteLink && prUrl}
        <DropdownMenu.Item onSelect={() => runAction(onOpenRemote)}>
          <ArrowSquareOutIcon size={14} weight="bold" />
          Open on {pr.host?.includes("github") ? "GitHub" : (pr.host ?? "remote")}
        </DropdownMenu.Item>
      {/if}
      {#if prUrl}
        <DropdownMenu.Item onSelect={() => void copyPullRequestLink()}>
          <LinkIcon size={14} />
          Copy link
        </DropdownMenu.Item>
      {/if}

      {#if hasLifecycleAction}
        <DropdownMenu.Separator />
      {/if}
      {#if onLifecycleAction && detail?.state === "open" && detail.draft && allowedActions.has("ready")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => void updateLifecycle("ready")}
        >
          <GitPullRequestIcon size={14} />
          Mark ready for review
        </DropdownMenu.Item>
      {:else if onLifecycleAction && detail?.state === "open" && !detail.draft && allowedActions.has("draft")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => void updateLifecycle("draft")}
        >
          <PencilSimpleIcon size={14} />
          Convert to draft
        </DropdownMenu.Item>
      {/if}
      {#if onLifecycleAction && detail?.state === "open" && allowedActions.has("close")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => void updateLifecycle("close")}
        >
          <GitPullRequestIcon size={14} />
          Close pull request
        </DropdownMenu.Item>
      {:else if onLifecycleAction && detail?.state === "closed" && allowedActions.has("reopen")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => void updateLifecycle("reopen")}
        >
          <GitPullRequestIcon size={14} />
          Reopen pull request
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
