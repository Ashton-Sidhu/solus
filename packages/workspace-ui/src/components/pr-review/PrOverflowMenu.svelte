<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ArrowsClockwiseIcon,
    ChatCircleIcon,
    DotsThreeIcon,
    GitPullRequestIcon,
    PencilSimpleIcon,
  } from "phosphor-svelte";
  import type { PrLifecycleAction, PullRequestDetail } from "@solus/contracts/providers";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  // The rarely-used pull request actions. It rides in the Merge section's own
  // header rather than under the action cluster: a draft has no merge button and
  // no guide, so a footer row left the ⋯ floating on its own in empty space.
  let {
    pr,
    detail,
    showRemoteLink,
    prUrl,
    onOpenRemote,
    onChat,
    onRefresh,
    onLifecycleAction,
  }: {
    pr: { host?: string };
    detail: PullRequestDetail | null;
    showRemoteLink: boolean;
    prUrl: string | null;
    onOpenRemote: () => void;
    onChat?: () => void;
    onRefresh: () => void;
    onLifecycleAction?: (
      action: Exclude<PrLifecycleAction, "merge">,
    ) => Promise<void>;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let lifecycleAction = $state<Exclude<PrLifecycleAction, "merge"> | null>(null);

  const allowedActions = $derived(new Set(detail?.viewerPermissions.actions ?? []));

  function runAction(action: () => void) {
    open = false;
    action();
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

<Button
  bind:ref={triggerEl}
  variant="ghost"
  size="icon-sm"
  class="size-auto shrink-0 cursor-pointer rounded-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
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
    class="w-52"
  >
    {#if onChat}
      <DropdownMenu.Item onSelect={() => runAction(onChat)}>
        <ChatCircleIcon size={14} weight="bold" />
        Open agent chat
      </DropdownMenu.Item>
    {/if}
    {#if showRemoteLink && prUrl}
      <DropdownMenu.Item onSelect={() => runAction(onOpenRemote)}>
        <ArrowSquareOutIcon size={14} weight="bold" />
        Open on {pr.host ?? "remote"}
      </DropdownMenu.Item>
    {/if}
    <DropdownMenu.Item onSelect={() => runAction(onRefresh)}>
      <ArrowsClockwiseIcon size={14} />
      Refresh activity
    </DropdownMenu.Item>
    {#if detail?.state === "open" && detail.draft && allowedActions.has("ready")}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => void updateLifecycle("ready")}
      >
        <GitPullRequestIcon size={14} />
        Mark ready for review
      </DropdownMenu.Item>
    {:else if detail?.state === "open" && !detail.draft && allowedActions.has("draft")}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => void updateLifecycle("draft")}
      >
        <PencilSimpleIcon size={14} />
        Convert to draft
      </DropdownMenu.Item>
    {/if}
    {#if detail?.state === "open" && allowedActions.has("close")}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => void updateLifecycle("close")}
      >
        <GitPullRequestIcon size={14} />
        Close pull request
      </DropdownMenu.Item>
    {:else if detail?.state === "closed" && allowedActions.has("reopen")}
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
