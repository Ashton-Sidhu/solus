<script lang="ts">
  import { CircleAlert as ErrorIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../../contexts/workspace/routing/route-registry";
  import { requestInputFocus } from "../../../../lib/inputFocus";
  import { toasts } from "../../../../lib/toasts";
  import { Button } from "../../../ui/button";
  import { versionLabel, type AppProblem } from "../../lib/app-view";

  /**
   * What needs the owner, one tinted callout for each problem, with the button
   * to the section where the owner acts. A workflow run that failed on an older
   * version is retried on the active version or dismissed in place.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    problems: AppProblem[];
    onSelectSection: (section: AppManageSection) => void;
  }
  let { serverId, app, problems, onSelectSection }: Props = $props();

  /** The run whose Retry or Dismiss waits for the host. */
  let actingRunId = $state<string | null>(null);

  /** Retry or Dismiss of a run that failed on an older version. The summary the host says next takes the callout away. */
  async function actOnRun(runId: string, action: () => Promise<void>, failure: string) {
    if (actingRunId) return;
    actingRunId = runId;
    try {
      await action();
    } catch (cause) {
      toasts.error(failure, { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      actingRunId = null;
      requestInputFocus();
    }
  }
</script>

<div class="flex flex-col gap-2" role="list" aria-label="Needs attention">
  {#each problems as problem (problem.kind + problem.detail)}
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border py-2.5 pr-3 pl-4.5 {problem.tone === 'error'
        ? 'border-[color-mix(in_oklch,var(--failure)_28%,transparent)] bg-[color-mix(in_oklch,var(--failure)_8%,var(--background))]'
        : 'border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[color-mix(in_oklch,var(--warning)_10%,var(--background))]'}"
      role="listitem"
      data-testid="app-problem"
    >
      {#if problem.tone === "error"}
        <ErrorIcon size={16} class="shrink-0 text-(--failure)" aria-label="Error" />
      {:else}
        <WarningIcon size={16} class="shrink-0 text-(--warning)" aria-label="Warning" />
      {/if}
      <p class="m-0 min-w-48 flex-1 text-sm text-pretty text-foreground">{problem.detail}</p>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if problem.kind === "workflow-stale" && problem.runId}
          {@const runId = problem.runId}
          <Button size="sm" variant="ghost" class="text-workspace-chrome" disabled={actingRunId !== null} onclick={() => void actOnRun(runId, () => appsStore.dismissRun(serverId, app.id, runId), "The run was not dismissed")} data-testid="app-problem-dismiss">Dismiss</Button>
          <Button size="sm" variant="outline" class="rounded-full px-3.5 text-workspace-chrome" disabled={actingRunId !== null} onclick={() => void actOnRun(runId, () => appsStore.retryRun(serverId, app.id, runId), "The run did not start again")} data-testid="app-problem-retry">
            Retry on {versionLabel(app.activeVersion)}
          </Button>
        {:else}
          <Button size="sm" variant="outline" class="rounded-full px-3.5 text-workspace-chrome" onclick={() => onSelectSection(problem.section)}>{problem.action}</Button>
        {/if}
      </div>
    </div>
  {/each}
</div>
