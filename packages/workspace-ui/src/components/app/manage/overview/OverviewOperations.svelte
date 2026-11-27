<script lang="ts">
  import type { AppMetrics, AppSummary, AppVersionView } from "@solus/contracts/apps";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../../contexts/workspace/routing/route-registry";
  import { formatDuration } from "../../../insights/lib/format";
  import { appTime, versionLabel, versionStateLabel } from "../../lib/app-view";
  import { versionDetail } from "../lib/overview";
  import { versionState } from "../lib/states";
  import StateIcon from "../StateIcon.svelte";

  /**
   * The left column under the last 24 hours, plain on the page: a table of the
   * operations that were called (calls, median time, failed calls), then the
   * newest deploys. A row opens the section that holds the rest.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    metrics: AppMetrics | undefined;
    /** Undefined until the host answers. */
    versions: AppVersionView[] | undefined;
    onSelectSection: (section: AppManageSection) => void;
  }
  let { serverId, app, metrics, versions, onSelectSection }: Props = $props();
</script>

{#snippet heading(title: string, caption: string, section: AppManageSection, captionLabel: string)}
  <div class="flex items-baseline justify-between gap-3 px-2.5 pb-2.5">
    <h3 class="m-0 text-[15px] font-semibold text-foreground">{title}</h3>
    <button
      type="button"
      class="cursor-pointer rounded border-0 bg-transparent p-0 text-[13px] text-(--solus-text-tertiary) hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      aria-label={captionLabel}
      onclick={() => onSelectSection(section)}>{caption}</button
    >
  </div>
{/snippet}

<div class="flex min-w-0 flex-1 flex-col gap-8 @max-[56rem]/pane:w-full">
  <section class="flex flex-col" aria-label="Operations">
    {@render heading("Operations", "Calls · p50 · failed", "operations", "Open Operations")}
    {#if metrics && metrics.operations.length > 0}
      {#each metrics.operations as operation (operation.operation)}
        <button
          type="button"
          class="flex h-10.5 w-full min-w-0 shrink-0 cursor-pointer items-center gap-3 overflow-hidden border-0 border-t border-[var(--hairline)] bg-transparent px-2.5 text-left text-sm tabular-nums transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-12"
          title={operation.lastAt === null ? undefined : `Last call ${appTime(operation.lastAt)}`}
          onclick={() => onSelectSection("operations")}
          data-testid="app-overview-operation"
        >
          <span class="min-w-0 flex-1 truncate text-foreground">{operation.operation}</span>
          <span class="w-13 shrink-0 text-right text-foreground">{operation.calls.toLocaleString()}</span>
          <span class="w-15 shrink-0 text-right text-(--solus-text-tertiary)">{formatDuration(operation.p50Ms)}</span>
          <span class="w-9 shrink-0 text-right {operation.failed > 0 ? 'font-medium text-foreground' : 'text-(--solus-text-tertiary)/60'}">{operation.failed > 0 ? operation.failed.toLocaleString() : "–"}</span>
        </button>
      {/each}
    {:else}
      <p class="m-0 border-t border-[var(--hairline)] px-2.5 py-3 text-sm text-(--solus-text-tertiary)">
        {metrics ? `No operation was called in the last 24 hours. The app has ${app.operationCount === 1 ? "1 operation" : `${app.operationCount} operations`}.` : "Reading…"}
      </p>
    {/if}
  </section>

  <section class="flex flex-col" aria-label="Recent deploys">
    {@render heading("Recent deploys", "All versions", "versions", "Open Versions")}
    {#if versions === undefined}
      <p class="m-0 border-t border-[var(--hairline)] px-2.5 py-3 text-sm text-(--solus-text-tertiary)">{appsStore.versions.errorFor(serverId, app.id) ?? "Reading…"}</p>
    {:else}
      {#each versions.slice(0, 3) as version (version.number)}
        <div class="flex min-h-10.5 min-w-0 items-center gap-3 border-t border-[var(--hairline)] px-2.5 py-2 text-sm" data-testid="app-overview-deploy">
          <StateIcon state={versionState(version.state)} label={versionStateLabel(version.state)} />
          <span class="w-10 shrink-0 font-medium tabular-nums text-foreground">{versionLabel(version.number)}</span>
          <span class="min-w-0 flex-1 truncate text-(--solus-text-secondary)" title={versionDetail(version)}>{versionDetail(version)}</span>
          <span class="shrink-0 text-[13px] tabular-nums text-(--solus-text-tertiary)" title={versionStateLabel(version.state)}>{appTime(version.createdAt)}</span>
        </div>
      {:else}
        <p class="m-0 border-t border-[var(--hairline)] px-2.5 py-3 text-sm text-(--solus-text-tertiary)">No deploys yet. An agent deploys the app when you ask for a change.</p>
      {/each}
    {/if}
  </section>
</div>
