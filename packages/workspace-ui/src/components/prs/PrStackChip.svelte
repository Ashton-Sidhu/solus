<script lang="ts">
  import { ExternalLink as OpenExternalIcon, Layers as StackIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import type { PrStackMembership } from "@solus/contracts/providers";
  import type { PullRequest } from "../../contexts/prs/pull-request.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PrStackLayerItems from "../pr-review/PrStackLayerItems.svelte";
  import { stackPosition } from "../pr-review/lib/pr-stack";

  /**
   * A list row's place in its GitHub stack, as `2/3`, and the menu that steps
   * to another layer without opening this one first. The whole stack is read
   * only when the menu opens, so a page of rows costs no stack reads.
   */
  let {
    membership,
    pullRequest,
    onOpen,
  }: {
    membership: PrStackMembership;
    /** The row's pull request in the store, which reads its stack. */
    pullRequest: PullRequest | null;
    /** Show another layer in the page's detail panel. */
    onOpen: (number: number) => void;
  } = $props();

  let open = $state(false);
  let isLoading = $state(false);
  let hasFailed = $state(false);

  const stack = $derived(pullRequest?.fullStack ?? null);
  const isLayer = $derived(!!stack && !!pullRequest && stackPosition(stack, pullRequest.number) > 0);

  function read(force = false) {
    const target = pullRequest;
    if (!target) return;
    isLoading = true;
    hasFailed = false;
    target
      .loadStack({ force })
      .catch(() => (hasFailed = true))
      .finally(() => (isLoading = false));
  }
</script>

<DropdownMenu.Root
  bind:open
  onOpenChange={(next) => {
    if (next) read();
  }}
>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="ml-2 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-10 {open
          ? 'bg-[var(--wash-2)] text-foreground'
          : ''}"
        aria-label="Stack, layer {membership.position} of {membership.size}"
        title="Layer {membership.position} of {membership.size} in a stack on {membership.base}"
      >
        <StackIcon size={12} aria-hidden="true" />
        {membership.position}/{membership.size}
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(22rem,calc(100vw-2rem))] [&_.menu-row]:text-workspace-chrome"
  >
    {#if stack && pullRequest && isLayer}
      <PrStackLayerItems {stack} current={pullRequest.number} {onOpen} />
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={() => void localApi.openExternal(stack.url)}>
        <OpenExternalIcon size={14} />
        Open stack in browser
      </DropdownMenu.Item>
    {:else if isLoading}
      <DropdownMenu.Label>Loading stack…</DropdownMenu.Label>
    {:else if hasFailed}
      <DropdownMenu.Label>Couldn't read the stack</DropdownMenu.Label>
      <DropdownMenu.Item
        onSelect={(event) => {
          event.preventDefault();
          read(true);
        }}
      >
        Try again
      </DropdownMenu.Item>
    {:else}
      <DropdownMenu.Label>This pull request is no longer in a stack</DropdownMenu.Label>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
