<script lang="ts">
  import { untrack } from "svelte";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { formatDuration } from "../../insights/lib/format";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";

  /** The text of one version's build (docs/plans/apps.md §1). A build that still runs has more text later: the owner reads it again. */
  interface Props {
    serverId: string;
    appId: string;
    version: number;
    isBuilding: boolean;
  }
  let { serverId, appId, version, isBuilding }: Props = $props();

  let attempt = $state(0);
  // Read when the person opens it, again when they ask, and once more when the build ends:
  // not when the app's row changes.
  const readKey = $derived([serverId, appId, version, isBuilding, attempt].join("\n"));
  const log = $derived.by(() => {
    void readKey;
    return untrack(() => appsStore.buildLog(serverId, appId, version));
  });
</script>

{#await log}
  <p class="m-0 text-xs text-muted-foreground" role="status" aria-busy="true">Loading the build log…</p>
{:then answer}
  <div class="flex min-w-0 flex-col gap-1.5" data-testid="app-build-log">
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{isBuilding ? "The build runs now." : answer.buildMs === null ? "The host kept no build time." : `The build took ${formatDuration(answer.buildMs)}.`}</span>
      {#if isBuilding}
        <Button size="xs" variant="outline" onclick={() => (attempt += 1)}>Read again</Button>
      {/if}
    </div>
    {#if answer.log}
      <pre class="m-0 max-h-96 overflow-auto rounded-[10px] bg-[var(--wash-2)] px-3 py-2.5 font-mono text-xs whitespace-pre">{answer.log}</pre>
    {:else}
      <p class="m-0 text-xs text-muted-foreground">{isBuilding ? "The build wrote no text yet." : "The build wrote no text."}</p>
    {/if}
  </div>
{:catch error}
  <MarkdownAlert alertType="error">
    {#snippet content()}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <p class="m-0 min-w-0 flex-1 text-pretty text-foreground" role="alert">{error instanceof Error ? error.message : "Could not load the build log."}</p>
        <Button size="xs" variant="link" class="h-auto px-0" onclick={() => (attempt += 1)}>Try again</Button>
      </div>
    {/snippet}
  </MarkdownAlert>
{/await}
