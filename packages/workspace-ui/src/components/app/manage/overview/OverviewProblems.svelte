<script lang="ts">
  import type { AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../../contexts/workspace/routing/route-registry";
  import { requestInputFocus } from "../../../../lib/inputFocus";
  import { toasts } from "../../../../lib/toasts";
  import { Button } from "../../../ui/button";
  import MarkdownAlert from "../../../ui/MarkdownAlert.svelte";
  import { versionLabel, type AppProblem } from "../../lib/app-view";

  /**
   * What needs the owner, one callout band for each problem (an error or a
   * warning), with the link to the section where the owner acts. A workflow run that failed on an older
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

<div class="flex flex-col gap-3" role="list" aria-label="Needs attention">
  {#each problems as problem (problem.kind + problem.detail)}
    <div role="listitem" data-testid="app-problem">
      <MarkdownAlert alertType={problem.tone === "error" ? "caution" : "warning"}>
        {#snippet content()}
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <p class="m-0 min-w-48 flex-1 text-pretty text-foreground">{problem.detail}</p>
            {#if problem.kind === "workflow-stale" && problem.runId}
              {@const runId = problem.runId}
              <Button size="xs" variant="link" class="h-auto px-0 text-sm text-(--solus-text-secondary)" disabled={actingRunId !== null} onclick={() => void actOnRun(runId, () => appsStore.dismissRun(serverId, app.id, runId), "The run was not dismissed")} data-testid="app-problem-dismiss">Dismiss</Button>
              <Button size="xs" variant="link" class="h-auto px-0 text-sm" disabled={actingRunId !== null} onclick={() => void actOnRun(runId, () => appsStore.retryRun(serverId, app.id, runId), "The run did not start again")} data-testid="app-problem-retry">
                Retry on {versionLabel(app.activeVersion)}
              </Button>
            {:else}
              <Button size="xs" variant="link" class="h-auto px-0 text-sm" onclick={() => onSelectSection(problem.section)}>{problem.action}</Button>
            {/if}
          </div>
        {/snippet}
      </MarkdownAlert>
    </div>
  {/each}
</div>
