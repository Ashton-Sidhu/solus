<script lang="ts">
  /**
   * The servers found on one host (docs/plans/mcp-first-class.md §8.6, §8.9),
   * as a card that opens and closes: a header with the host and the count of
   * servers not added, then rows in two columns. Each row's logos say whose config file has the
   * server. Add, Test, and a change in a file go to this host; the page opens
   * the add dialog. The list comes from the page's discovery, which reads every host.
   */
  import { ChevronRight, LoaderCircle, Monitor, TriangleAlert } from "@lucide/svelte";
  import type { FoundPlace, FoundServer } from "@solus/contracts/integration-types";
  import { ALL_FOUND_ADDED_TEXT, NO_FOUND_SERVERS_TEXT, configFileLabel, portScanUnavailableText } from "@solus/contracts/integrations/found-server-labels";
  import type { McpFound } from "../../contexts/mcp";
  import { RowCard } from "../ui/row-card";
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
  const bodyId = `${labelId}-servers`;
  /** Open at first; it stays as the person left it while the page is open. */
  let isOpen = $state(true);
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

<!-- A card for each host: its header opens and closes the list, and the
     count stays in view while it is closed. -->
<section aria-labelledby={labelId} data-testid="mcp-found-host">
  <RowCard>
    <h3 id={labelId}>
      <button type="button" class="flex w-full min-w-0 items-center gap-2.5 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 motion-reduce:transition-none pointer-coarse:min-h-11"
        aria-expanded={isOpen} aria-controls={bodyId} onclick={() => (isOpen = !isOpen)}>
        <Monitor size={16} class="shrink-0 text-(--solus-text-secondary)" aria-hidden="true" />
        <span class="truncate text-workspace-chrome font-medium text-foreground">{hostLabel}</span>
        {#if found.loading && !isOffline}
          <LoaderCircle size={14} class="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" /><span class="sr-only">Reading its config files</span>
        {:else if !found.error && !found.isUnsupported}
          <span class="shrink-0 rounded-full bg-muted px-1.5 text-chrome-dense leading-5 tabular-nums text-muted-foreground">{found.notAdded.length}<span class="sr-only"> not added</span></span>
        {/if}
        <ChevronRight size={16} class="ml-auto shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" aria-hidden="true" />
      </button>
    </h3>
    {#if isOpen}
      <div id={bodyId} class="flex flex-col px-4 py-1">
        {#if isOffline && (found.loading || found.error)}
          <p class="py-5 text-center text-workspace-chrome text-muted-foreground">Its servers show when the connection returns.</p>
        {:else if found.loading}
          <ul class="grid grid-cols-1 gap-x-10 @min-[56rem]/mcp:grid-cols-2" aria-busy="true" aria-label="Servers found on {hostLabel}">{@render placeholderRows(2)}</ul>
        {:else if found.isUnsupported}
          <p class="py-5 text-center text-workspace-chrome text-muted-foreground">{hostLabel} is older than this view. Update Solus on it to find its MCP servers.</p>
        {:else if found.error}
          <p role="alert" class="py-4 text-workspace-chrome text-(--solus-status-error)">{found.error}</p>
        {:else}
          {#if found.notAdded.length === 0}
            <p class="py-5 text-center text-workspace-chrome text-muted-foreground">{found.servers.length ? ALL_FOUND_ADDED_TEXT : NO_FOUND_SERVERS_TEXT}</p>
          {:else}
            <ul class="grid grid-cols-1 gap-x-10 transition-opacity motion-reduce:transition-none @min-[56rem]/mcp:grid-cols-2 {isRefreshing ? 'opacity-60' : ''}" aria-label="Servers found on {hostLabel}">
              {#each found.notAdded as server (server.foundId)}
                <McpFoundRow {server} {hostLabel} {isOffline} isAdding={found.adding === server.foundId} isChanging={found.changing === server.foundId}
                  mayChange={found.mayChange} {canOpenFiles} test={found.tests.get(server.foundId)}
                  {onReview} onTest={(next) => found.test(next)} onCloseTest={(next) => found.closeTest(next.foundId)}
                  {onOpen} onChange={(next, place, change) => found.change(next, place, change)} />
              {/each}
            </ul>
          {/if}
          {#if found.portScan?.state === "unavailable"}
            <p class="flex items-start gap-2 pb-3 text-chrome-dense text-muted-foreground">
              <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{portScanUnavailableText(found.portScan.reason)}
            </p>
          {/if}
          {#each found.problems as file (file.path)}
            <p class="flex items-start gap-2 pb-3 text-chrome-dense text-muted-foreground">
              <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{configFileLabel(file.file)} ({file.path}) was not read. {file.problem}
            </p>
          {/each}
        {/if}
      </div>
    {/if}
  </RowCard>
</section>
