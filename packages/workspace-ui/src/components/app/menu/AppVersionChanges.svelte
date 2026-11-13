<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import DiffFileCardHeader from "../../diff/DiffFileCardHeader.svelte";
  import { versionDiffFiles } from "../lib/app-version-diff";

  /** The source change of one version against the version before it, one card for each file. */
  let { serverId, appId, version }: { serverId: string; appId: string; version: number } = $props();

  // Read when the person opens it; a version is immutable, so it is not read again.
  const diff = $derived(appsStore.versionDiff(serverId, appId, version));
  const closedPaths = new SvelteSet<string>();
</script>

{#await diff}
  <p class="m-0 text-xs text-muted-foreground" role="status" aria-busy="true">Loading the changes…</p>
{:then answer}
  {@const files = versionDiffFiles(answer.patch)}
  <div class="flex flex-col gap-2" data-testid="app-version-changes">
    <p class="m-0 text-xs text-muted-foreground">
      {answer.base === null ? "The first version: every file is new." : `Against v${answer.base}.`}
      {#if answer.truncated}The patch is cut at the size limit.{/if}
    </p>
    {#if files.length === 0}
      {#if answer.patch}
        <pre class="m-0 max-h-96 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre">{answer.patch}</pre>
      {:else}
        <p class="m-0 text-xs text-muted-foreground">The source did not change.</p>
      {/if}
    {/if}
    {#each files as file (file.path)}
      {@const isOpen = !closedPaths.has(file.path)}
      <div class="overflow-hidden rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)">
        <DiffFileCardHeader
          path={file.path}
          open={isOpen}
          onToggle={() => (isOpen ? closedPaths.add(file.path) : closedPaths.delete(file.path))}
        >
          {#snippet trailing()}
            <span class="shrink-0 text-chrome-shelf tabular-nums">
              <span class="text-(--solus-diff-added-text-vivid)">+{file.additions}</span>
              <span class="text-(--solus-diff-removed-text-vivid)">−{file.deletions}</span>
            </span>
          {/snippet}
        </DiffFileCardHeader>
        {#if isOpen}
          <div class="overflow-x-auto bg-(--solus-diff-surface)">
            {#if file.patch}
              {#await import("../../diff/Diff.svelte")}
                <p class="m-0 px-3 py-3 text-xs text-muted-foreground">Loading the diff</p>
              {:then diffModule}
                {@const Diff = diffModule.default}
                <Diff patch={file.patch} />
              {/await}
            {:else}
              <p class="m-0 px-3 py-3 text-xs text-muted-foreground">No text diff for this file (binary, or a rename with no change).</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:catch error}
  <p class="m-0 text-xs text-destructive" role="alert">{error instanceof Error ? error.message : "Could not load the changes."}</p>
{/await}
