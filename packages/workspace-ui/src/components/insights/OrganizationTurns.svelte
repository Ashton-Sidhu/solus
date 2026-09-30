<script lang="ts">
  /** The Organization scope of Insights (docs/plans/organization-scope.md §6.1):
   *  the selected organization's turns as the Solus API holds them, attributed
   *  to the account that ran each, over the range the console holds. Read from
   *  the organization's workspace service; a machine's own metrics stay on the
   *  host scope beside it. */
  import type { TimeRange } from "./lib/time-range";
  import { resolveRange } from "./lib/time-range";
  import { organizationInsightsStore as store } from "./organization-insights.store.svelte";
  import { organizationTurnsSummary, organizationTurnsTable } from "./lib/organization-turns";
  import InsightsResultSkeleton from "./InsightsResultSkeleton.svelte";
  import ResultTable from "./ResultTable.svelte";

  interface Props {
    /** The organization's workspace service. */
    serverId: string;
    organizationId: string;
    organizationName: string;
    range: TimeRange;
  }

  let { serverId, organizationId, organizationName, range }: Props = $props();

  // One read per organization and range; the store drops an answer to a
  // question the page no longer asks.
  $effect(() => {
    const { from, to } = resolveRange(range, Date.now());
    void organizationId;
    void store.load(serverId, { since: new Date(from).toISOString(), until: new Date(to).toISOString(), limit: 200 });
    return () => store.reset();
  });

  const table = $derived(store.result ? organizationTurnsTable(store.result) : null);
  const summary = $derived(store.result ? organizationTurnsSummary(store.result, organizationName) : null);
</script>

<section class="flex min-h-0 flex-1 flex-col gap-2" aria-label="Organization turns" data-testid="organization-turns">
  {#if store.error}
    <p
      class="shrink-0 rounded-lg px-3 py-2 text-insights-chrome leading-relaxed"
      style="background:color-mix(in oklch, var(--failure) 8%, transparent);color:var(--failure)"
      role="alert"
    >
      {store.error}
    </p>
  {/if}
  {#if store.loading && !store.result}
    <InsightsResultSkeleton />
  {:else if table && summary}
    <p class="shrink-0 text-insights-summary text-muted-foreground" data-testid="organization-turns-summary">{summary}</p>
    {#if table.rows.length === 0}
      <p class="text-insights-chrome text-muted-foreground">No turns in this range reached {organizationName}.</p>
    {:else}
      <ResultTable result={table} />
      <nav class="flex shrink-0 items-center gap-3 text-workspace-chrome" aria-label="Insight pages">
        <button disabled={store.loading || !store.hasPrevious} onclick={() => void store.previous()} class="rounded px-2 py-1 disabled:opacity-40">Previous</button>
        <button disabled={store.loading || !store.result?.nextCursor} onclick={() => void store.next()} class="rounded px-2 py-1 disabled:opacity-40">Next</button>
      </nav>
    {/if}
  {/if}
</section>
