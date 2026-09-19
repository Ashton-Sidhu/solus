<script lang="ts">
  import { ChevronDown, ChevronRight } from "@lucide/svelte";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import type { ArtifactRevision } from "./lib/artifact-revisions";

  let { revisions, revision }: { revisions: ArtifactRevision[]; revision: ArtifactRevision } = $props();
  const origin = getHtmlBlockOrigin();
  const disclosures = getTranscriptDisclosure();
  const latest = $derived(revisions[revisions.length - 1]);
  const isEarlier = $derived(revision !== latest);
  // Include the successor in the key: each completed revision collapses older
  // cards once, while the reader can still reopen them after that update.
  const disclosure = $derived(disclosures.forKey(`artifact:${revision.messageId}:${revision.workRef?.workId ?? revision.title}:${latest.messageId}`));
  const expanded = $derived(!isEarlier || disclosure.expanded);
  const selected = $derived(revisions.find((entry) => entry.messageId === disclosure.pickedId) ?? revision);
  const version = $derived(revisions.indexOf(selected) + 1);
</script>

<div class="my-2 min-w-0" data-testid="conversation-artifact" data-artifact-version={version}>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-workspace-chrome text-(--solus-text-secondary)">
    <button
      type="button"
      class="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pr-2 pl-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-(--solus-accent) pointer-coarse:min-h-12"
      aria-expanded={expanded}
      disabled={!isEarlier}
      onclick={() => (disclosure.expanded = !expanded)}
    >
      {#if isEarlier}
        {#if expanded}<ChevronDown size={16} class="shrink-0" />{:else}<ChevronRight size={16} class="shrink-0" />{/if}
      {/if}
      <span class="min-w-0 truncate font-medium">{revision.title || "Artifact"}</span>
      <span class="shrink-0">v{revisions.indexOf(revision) + 1} · {isEarlier ? "Earlier version" : "Latest in conversation"}</span>
    </button>
    {#if isEarlier}
      <button
        type="button"
        class="min-h-8 shrink-0 rounded-md px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-(--solus-accent) pointer-coarse:min-h-12"
        onclick={() => { disclosure.pickedId = latest.messageId; disclosure.expanded = true; }}
      >View latest</button>
    {/if}
    {#if expanded && revisions.length > 1}
      <label class="flex items-center gap-1.5">
        <span>Showing</span>
        <select
          class="min-h-8 rounded-md bg-background px-1 text-workspace-chrome pointer-coarse:min-h-12"
          aria-label="Artifact version"
          value={selected.messageId}
          onchange={(event) => (disclosure.pickedId = event.currentTarget.value)}
        >
          {#each revisions as entry, index}
            <option value={entry.messageId}>v{index + 1}{entry === latest ? " · Latest" : ""}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  {#if expanded}
    {#key selected.messageId}
    {#if selected.workRef}
      <ArtifactView artifact={{ kind: "html", html: selected.html }} workRef={selected.workRef} tabId={origin?.().tabId} linkContext={origin?.().linkContext} skipMotion />
    {:else}
      <HtmlBlock html={selected.html} />
    {/if}
    {/key}
  {/if}
</div>
