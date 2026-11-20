<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { sessionTurnDiffText } from "@solus/client-core/session-cloud-read-text";
  import { getWorkspaceContext } from "../../contexts";
  import { diffViewPreferences } from "../../lib/diff-view-preferences.svelte";
  import DiffFileCardHeader from "../diff/DiffFileCardHeader.svelte";
  import { Button } from "../ui/button";
  import { cloudTurnDiffFiles } from "./lib/cloud-turn-diff";

  /**
   * The changes of one turn of a session's cloud copy, read from Solus Cloud
   * when the reader opens them (`sessionTurnDiff`). A turn's code stays on the
   * machines, so a diff too large to send and a turn with no saved diff each
   * say so in plain words.
   */
  let { sessionId, turnIndex }: { sessionId: string; turnIndex: number } = $props();

  const workspace = getWorkspaceContext();
  let isOpen = $state(false);
  const diff = $derived(workspace.cloudTranscripts.diffFor(sessionId, turnIndex));
  const files = $derived(diff?.status === "available" ? cloudTurnDiffFiles(diff.patch) : []);
  const note = $derived(diff ? sessionTurnDiffText(diff) : null);
  const openPaths = new SvelteSet<string>();

  function toggle(): void {
    isOpen = !isOpen;
    if (isOpen) void workspace.cloudTranscripts.loadDiff(sessionId, turnIndex);
  }

  function toggleFile(path: string): void {
    if (openPaths.has(path)) openPaths.delete(path);
    else openPaths.add(path);
  }
</script>

<div class="flex w-full min-w-0 flex-col items-center gap-2">
  <Button variant="outline" size="xs" aria-expanded={isOpen} onclick={toggle}>
    {isOpen ? "Hide the changes of this turn" : "Show the changes of this turn"}
  </Button>
  {#if isOpen && diff}
    {#if note}
      <p class="m-0 max-w-120 text-center text-chrome-dense text-(--solus-text-tertiary)" role={diff.status === "error" ? "alert" : "status"}>
        {note}
        {#if diff.status === "error"}
          <Button variant="link" size="xs" onclick={() => void workspace.cloudTranscripts.loadDiff(sessionId, turnIndex)}>Try again</Button>
        {/if}
      </p>
    {:else}
      <div class="flex w-full min-w-0 flex-col gap-2">
        {#each files as file (file.path)}
          {@const isFileOpen = openPaths.has(file.path)}
          <div class="overflow-hidden rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)">
            <DiffFileCardHeader path={file.path} open={isFileOpen} onToggle={() => toggleFile(file.path)}>
              {#snippet trailing()}
                <span class="shrink-0 text-chrome-shelf tabular-nums">
                  <span class="text-(--solus-diff-added-text-vivid)">+{file.additions}</span>
                  <span class="text-(--solus-diff-removed-text-vivid)">−{file.deletions}</span>
                </span>
              {/snippet}
            </DiffFileCardHeader>
            {#if isFileOpen}
              <div class="overflow-x-auto bg-(--solus-diff-surface)">
                {#if file.patch}
                  {#await import("../diff/Diff.svelte")}
                    <p class="m-0 px-3 py-3 text-chrome-dense text-(--solus-text-tertiary)">Loading the diff</p>
                  {:then diffModule}
                    {@const Diff = diffModule.default}
                    <Diff patch={file.patch} diffStyle="unified" tokenHighlight={diffViewPreferences.tokenHighlight} />
                  {/await}
                {:else}
                  <p class="m-0 px-3 py-3 text-chrome-dense text-(--solus-text-tertiary)">
                    No text diff for this file (binary, or a rename with no change).
                  </p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
