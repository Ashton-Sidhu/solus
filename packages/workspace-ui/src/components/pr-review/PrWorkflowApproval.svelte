<script lang="ts">
  import { untrack } from "svelte";
  import {
    ExternalLink as OpenExternalIcon,
    LoaderCircle as CircleNotchIcon,
    ShieldAlert as ShieldIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import type { PullRequest } from "../../contexts/prs/pull-request.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import {
    mayApproveWorkflowRuns,
    pendingWorkflowsHeadline,
    readsPendingWorkflowRuns,
  } from "./lib/workflow-approval";

  // The Actions runs of a fork pull request that GitHub holds until a
  // maintainer lets them start. It sits over the checks, as GitHub shows it in
  // its merge box. Absent when no run waits.
  let { pullRequest, class: className = "" }: {
    pullRequest: PullRequest | null;
    class?: string;
  } = $props();

  const reads = $derived(!!pullRequest && readsPendingWorkflowRuns(pullRequest));

  // Read again for each head: a push brings new runs that wait again.
  $effect(() => {
    const target = pullRequest;
    if (!target || !reads) return;
    void target.headSha;
    untrack(() => void target.loadPendingWorkflowRuns().catch(() => {}));
  });

  // Runs read for an older head are not the ones an approval would start.
  const pending = $derived.by(() => {
    const runs = pullRequest?.pendingWorkflowRuns;
    if (!reads || !runs || runs.runs.length === 0 || runs.headSha !== pullRequest?.headSha) return null;
    return runs;
  });
  const mayApprove = $derived(!!pullRequest && mayApproveWorkflowRuns(pullRequest));
  let approving = $state(false);

  async function approve() {
    const target = pullRequest;
    const runs = pending;
    if (!target || !runs || approving) return;
    approving = true;
    try {
      const approved = await target.approveWorkflowRuns(runs.headSha);
      toasts.success(
        approved === 1 ? "1 workflow run approved" : `${approved} workflow runs approved`,
      );
    } catch (error) {
      toasts.error("Couldn't approve the workflow runs", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      approving = false;
      requestInputFocus();
    }
  }

  function openRun(url: string) {
    void localApi.openExternal(url);
    requestInputFocus();
  }
</script>

{#if pending}
  <section
    class="flex flex-col gap-2 rounded-lg bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2.5 {className}"
    aria-label="Workflows waiting for approval"
  >
    <div class="flex items-start gap-2">
      <ShieldIcon size={15} class="mt-0.5 shrink-0 text-(--warning)" aria-hidden="true" />
      <div class="flex min-w-0 flex-1 flex-col">
        <h3 class="font-medium text-foreground">{pendingWorkflowsHeadline(pending.runs.length)}</h3>
        <span class="text-xs text-muted-foreground">
          This branch is from a fork. Its workflows run only after a maintainer approves them.
        </span>
      </div>
    </div>
    <ul class="-mx-1 flex flex-col" role="list">
      {#each pending.runs as run (run.id)}
        <li>
          <button
            type="button"
            disabled={!run.url}
            class="flex h-7 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1 text-left enabled:cursor-pointer enabled:hover:bg-[var(--wash-2)] disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10"
            title={run.url ? `Open ${run.name} on GitHub` : run.name}
            onclick={() => run.url && openRun(run.url)}
          >
            <span class="min-w-0 flex-1 truncate">{run.name}</span>
            {#if run.url}
              <OpenExternalIcon size={12} class="shrink-0 text-muted-foreground" aria-hidden="true" />
            {/if}
          </button>
        </li>
      {/each}
    </ul>
    {#if mayApprove}
      <Button
        type="button"
        size="sm"
        class="w-full gap-1.5"
        disabled={approving}
        onclick={() => void approve()}
      >
        {#if approving}
          <CircleNotchIcon size={13} class="animate-spin [animation-duration:0.9s] motion-reduce:animate-none" aria-hidden="true" />
          Approving…
        {:else}
          Approve and run
        {/if}
      </Button>
    {/if}
  </section>
{/if}
