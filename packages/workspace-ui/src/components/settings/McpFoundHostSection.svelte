<script lang="ts">
  /**
   * The servers found on one host (docs/plans/mcp-first-class.md §8.6, §8.9),
   * drawn as the catalog: a small label "Found on <host>" with the count, then
   * plain rows in two columns. Each row's logos say whose config file has the
   * server. Add, Test, and a change in a file go to this host; the page opens
   * the add dialog. The list comes from the page's discovery, which reads every host.
   */
  import { TriangleAlert } from "@lucide/svelte";
  import type { FoundPlace, FoundServer } from "@solus/contracts/integration-types";
  import { ALL_FOUND_ADDED_TEXT, NO_FOUND_SERVERS_TEXT, configFileLabel, portScanUnavailableText } from "@solus/contracts/integrations/found-server-labels";
  import type { McpFound } from "../../contexts/mcp";
  import McpFoundRow from "./McpFoundRow.svelte";

  interface Props {
    found: McpFound;
    hostLabel: string;
    /** The page's host is away: nothing can be read or changed until it returns. */
    isOffline: boolean;
    /** A discovery of every host runs; the rows stay. */
    isRefreshing: boolean;
    /** The configured editor opens a file of this host; another host's files open on that host only. */
    canOpenFiles: boolean;
    onReview: (server: FoundServer) => void;
    onOpen: (place: FoundPlace) => void;
  }
  let { found, hostLabel, isOffline, isRefreshing, canOpenFiles, onReview, onOpen }: Props = $props();

  const labelId = $props.id();
</script>

{#snippet placeholderRows(count: number)}
  {#each { length: count } as _, index (index)}
    <!-- The shape of a row, so the list does not move when the entries arrive. -->
    <li class="flex items-center gap-3.5 py-3" aria-hidden="true">
      <span class="size-8 shrink-0 rounded-lg bg-muted"></span>
      <div class="flex flex-1 flex-col gap-1.5">
        <span class="h-3.5 w-2/5 rounded bg-muted"></span>
        <span class="h-3 w-3/4 rounded bg-muted"></span>
      </div>
      <span class="h-8 w-20 shrink-0 rounded-lg bg-muted"></span>
    </li>
  {/each}
{/snippet}

<section class="flex flex-col gap-1" aria-labelledby={labelId} data-testid="mcp-found-host">
  <div class="flex min-h-7 items-center justify-between gap-4">
    <h2 id={labelId} class="truncate text-chrome-dense font-medium text-muted-foreground">Found on {hostLabel}</h2>
    {#if !found.loading && !found.error && !found.isUnsupported}
      <span class="shrink-0 text-chrome-dense tabular-nums text-muted-foreground">{found.notAdded.length}</span>
    {/if}
  </div>
  {#if isOffline && (found.loading || found.error)}
    <p class="rounded-xl border border-dashed border-border p-6 text-center text-workspace-chrome text-muted-foreground">Its servers show when the connection returns.</p>
  {:else if found.loading}
    <ul class="grid grid-cols-1 gap-x-14 @min-[56rem]/mcp:grid-cols-2" aria-busy="true" aria-label="Servers found on {hostLabel}">{@render placeholderRows(2)}</ul>
  {:else if found.isUnsupported}
    <p class="rounded-xl border border-dashed border-border p-6 text-center text-workspace-chrome text-muted-foreground">{hostLabel} is older than this view. Update Solus on it to find its MCP servers.</p>
  {:else if found.error}
    <p role="alert" class="rounded-xl border border-border p-4 text-workspace-chrome text-(--solus-status-error)">{found.error}</p>
  {:else}
    {#if found.notAdded.length === 0}
      <p class="rounded-xl border border-dashed border-border p-6 text-center text-workspace-chrome text-muted-foreground">{found.servers.length ? ALL_FOUND_ADDED_TEXT : NO_FOUND_SERVERS_TEXT}</p>
    {:else}
      <ul class="grid grid-cols-1 gap-x-14 transition-opacity motion-reduce:transition-none @min-[56rem]/mcp:grid-cols-2 {isRefreshing ? 'opacity-60' : ''}" aria-label="Servers found on {hostLabel}">
        {#each found.notAdded as server (server.foundId)}
          <McpFoundRow {server} {hostLabel} {isOffline} isAdding={found.adding === server.foundId} isChanging={found.changing === server.foundId}
            mayChange={found.mayChange} {canOpenFiles} test={found.tests.get(server.foundId)}
            {onReview} onTest={(next) => found.test(next)} onCloseTest={(next) => found.closeTest(next.foundId)}
            {onOpen} onChange={(next, place, change) => found.change(next, place, change)} />
        {/each}
      </ul>
    {/if}
    {#if found.portScan?.state === "unavailable"}
      <p class="flex items-start gap-2 pt-2 text-chrome-dense text-muted-foreground">
        <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{portScanUnavailableText(found.portScan.reason)}
      </p>
    {/if}
    {#each found.problems as file (file.path)}
      <p class="flex items-start gap-2 pt-2 text-chrome-dense text-muted-foreground">
        <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{configFileLabel(file.file)} ({file.path}) was not read. {file.problem}
      </p>
    {/each}
  {/if}
</section>
