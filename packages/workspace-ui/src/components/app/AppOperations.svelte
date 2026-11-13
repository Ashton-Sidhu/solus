<script lang="ts">
  import type { AppState } from "@solus/contracts/apps";

  /**
   * An app with no UI (docs/plans/apps.md §9): its operations are what it is,
   * so the surface lists them. An agent, a schedule, or a webhook calls them.
   */
  let { state: appState }: { state: AppState } = $props();

  const operations = $derived(appState.descriptor?.operations ?? []);
</script>

<div class="h-full overflow-y-auto overscroll-y-contain px-4 py-3" data-testid="app-operations">
  <p class="m-0 pb-3 text-xs text-muted-foreground text-pretty">
    {appState.app.description || "This app has no UI."} An agent, a schedule, or a webhook calls its operations.
  </p>
  {#if operations.length === 0}
    <p class="m-0 text-sm text-muted-foreground">This app declares no operation.</p>
  {:else}
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      {#each operations as operation (operation.name)}
        <li class="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/50 px-3 py-2">
          <span class="flex min-w-0 items-baseline gap-2">
            <code class="min-w-0 truncate font-mono text-xs text-(--solus-text-primary)">{operation.name}</code>
            <span class="shrink-0 text-xs text-muted-foreground">{operation.kind === "query" ? "Query" : "Mutation"}</span>
          </span>
          {#if operation.description}
            <span class="text-xs text-muted-foreground text-pretty">{operation.description}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
