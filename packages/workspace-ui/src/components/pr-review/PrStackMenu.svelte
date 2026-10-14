<script lang="ts">
  import { untrack } from "svelte";
  import {
    ExternalLink as OpenExternalIcon,
    GitMerge as MergeIcon,
    Layers as StackIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import type { PullRequest } from "../../contexts/prs/pull-request.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PrActionConfirm from "./PrActionConfirm.svelte";
  import PrStackLayerItems from "./PrStackLayerItems.svelte";
  import { MERGE_METHOD_OPTIONS } from "./lib/merge-method";
  import { stackMergeOutcome, stackMergePlan, stackPosition } from "./lib/pr-stack";

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

  // "Merge stack" lands every open layer from the bottom up to this one.
  const mergePlan = $derived(pullRequest ? stackMergePlan(pullRequest, stack) : null);
  const mergeMethodLabel = $derived(
    (MERGE_METHOD_OPTIONS.find((option) => option.value === mergePlan?.method)?.label ?? "Merge commit").toLowerCase(),
  );
  let mergeConfirmOpen = $state(false);
  let mergingStack = $state(false);

  async function mergeStack() {
    const target = pullRequest;
    const plan = mergePlan;
    if (!target || !plan?.expectedHeads || mergingStack) return;
    mergingStack = true;
    const count = plan.layers.length;
    const progress = toasts.progress(`Merging ${count} pull request${count === 1 ? "" : "s"}…`);
    try {
      const result = await target.mergeStack({
        stackNumber: plan.stackNumber,
        method: plan.method,
        expectedHeads: plan.expectedHeads,
      });
      progress.success(stackMergeOutcome(result), {
        description: result.pullRequests.map((merged) => `#${merged.number}`).join(", "),
      });
    } catch (error) {
      // The host words each refusal for the reader: the stack moved, a layer
      // is a draft, checks still run. Show it as the host sent it.
      progress.error("Couldn't merge the stack", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      mergingStack = false;
      requestInputFocus();
    }
  }
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
      <PrStackLayerItems {stack} {current} onOpen={open} />
      <DropdownMenu.Separator />
      {#if mergePlan}
        <DropdownMenu.Item
          disabled={mergingStack || !mergePlan.expectedHeads}
          title={mergePlan.expectedHeads ? undefined : "Refresh the pull request to read every layer's head"}
          onSelect={() => (mergeConfirmOpen = true)}
        >
          <MergeIcon size={14} />
          {mergingStack ? "Merging stack…" : `Merge stack (${mergePlan.layers.length})`}
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item onSelect={() => void localApi.openExternal(stack.url)}>
        <OpenExternalIcon size={14} />
        Open stack in browser
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

{#if mergePlan}
  {@const plan = mergePlan}
  <PrActionConfirm
    bind:open={mergeConfirmOpen}
    title="Merge {plan.layers.length} pull request{plan.layers.length === 1 ? '' : 's'}?"
    description="These land on {stack?.base ?? 'the base branch'} from the bottom up, each with {mergeMethodLabel}."
    confirmLabel="Merge stack"
    onConfirm={() => void mergeStack()}
  >
    {#snippet details()}
      <ol class="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {#each plan.layers as layer (layer.number)}
          <li class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-muted-foreground tabular-nums">#{layer.number}</span>
            <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)">{layer.title || layer.headRef}</span>
          </li>
        {/each}
      </ol>
    {/snippet}
  </PrActionConfirm>
{/if}
