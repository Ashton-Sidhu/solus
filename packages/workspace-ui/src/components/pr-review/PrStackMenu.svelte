<script lang="ts">
  import { untrack } from "svelte";
  import {
    Check as CheckIcon,
    CornerDownRight as BaseIcon,
    ExternalLink as OpenExternalIcon,
    Layers as StackIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import type { PullRequest } from "../../contexts/prs/pull-request.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { prStatusGlyph } from "../prs/lib/prs-list-view";
  import { stackLayerStatus, stackPosition } from "./lib/pr-stack";

  /**
   * The GitHub stack this pull request is in: its place as `2/3`, and a menu of
   * every layer, top first as GitHub draws it, to step to another one.
   * Absent while the pull request is in no stack.
   */
  let {
    pullRequest,
    serverId,
    projectCtx,
    onOpen,
  }: {
    pullRequest: PullRequest | null;
    serverId: string;
    /** The project the review was opened from; the other layers live there. */
    projectCtx: () => IpcContext;
    /** Show another layer in place of this one. Defaults to its review route. */
    onOpen?: (number: number) => void;
  } = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();

  function open(number: number) {
    if (onOpen) return onOpen(number);
    const project = pullRequests.projects.at(serverId, projectScopeOf(projectCtx().session));
    void session.prReview.openPullRequest(project?.prFor(number) ?? { number }, { ctx: projectCtx(), serverId });
  }

  // A row the list already placed in no stack costs no request. A pull request
  // opened some other way has not been asked, so it is read once.
  $effect(() => {
    const target = pullRequest;
    if (!target || target.stack === null) return;
    untrack(() => void target.loadStack().catch(() => {}));
  });

  // A newer read that says it left its stack wins over the stack read before it.
  const stack = $derived(pullRequest?.stack === null ? null : (pullRequest?.fullStack ?? null));
  const position = $derived(stack && pullRequest ? stackPosition(stack, pullRequest.number) : 0);
</script>

{#if stack && pullRequest && position > 0}
  {@const current = pullRequest.number}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          type="button"
          variant="ghost"
          size="xs"
          class="h-6.5 shrink-0 gap-1.5 rounded-full bg-background px-2.5 text-workspace-chrome font-normal text-foreground tabular-nums shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:bg-[var(--wash-1)] pointer-coarse:h-10 pointer-coarse:px-3.5"
          aria-label="Stack, layer {position} of {stack.layers.length}"
          title="Layer {position} of {stack.layers.length} in a stack on {stack.base}"
        >
          <StackIcon class="size-[15px]" strokeWidth={1.5} aria-hidden="true" />
          {position}/{stack.layers.length}
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={6}
      class="w-[min(22rem,calc(100vw-2rem))] [&_.menu-row]:text-workspace-chrome"
    >
      <DropdownMenu.Label>Stack on {stack.base}</DropdownMenu.Label>
      <div class="max-h-80 overflow-y-auto">
        {#each stack.layers.toReversed() as layer (layer.number)}
          {@const glyph = prStatusGlyph(stackLayerStatus(layer))}
          <DropdownMenu.Item
            aria-current={layer.number === current ? "true" : undefined}
            onSelect={() => {
              if (layer.number !== current) open(layer.number);
            }}
          >
            <glyph.icon size={14} class="shrink-0 {glyph.toneClass}" aria-label={glyph.label} />
            <span class="min-w-0 flex-1 truncate {layer.number === current ? 'font-medium' : ''}">
              {layer.title || layer.headRef}
            </span>
            <span class="shrink-0 text-muted-foreground tabular-nums">#{layer.number}</span>
            {#if layer.number === current}
              <CheckIcon size={12} class="shrink-0 text-primary" aria-hidden="true" />
            {/if}
          </DropdownMenu.Item>
        {/each}
      </div>
      <div class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
        <BaseIcon size={12} class="shrink-0" aria-hidden="true" />
        <span class="truncate font-mono">{stack.base}</span>
      </div>
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={() => void localApi.openExternal(stack.url)}>
        <OpenExternalIcon size={14} />
        Open stack in browser
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
