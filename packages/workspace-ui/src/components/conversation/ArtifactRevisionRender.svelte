<script lang="ts">
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import type { ArtifactVersions } from "../artifact/ArtifactRail.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";
  import type { ArtifactRevision } from "./lib/artifact-revisions";
  import { lastReportedHeight } from "../artifact/lib/artifact-view";
  import { getSurfaceContext } from "../../contexts";
  import { loadArtifactHtml, worksArtifactHtmlSources } from "../../contexts/workspace/artifact-history";

  /**
   * The render of one completed revision. A revision whose HTML the history
   * page left on its host reads it when this mounts. `showRail` is false in an
   * artifact group, whose own line names the work and opens it in the pane.
   */
  let { revision, showRail = true, versions }: {
    revision: ArtifactRevision;
    showRail?: boolean;
    /** The chain this revision is one version of, for the rail's controls. */
    versions?: ArtifactVersions;
  } = $props();
  const origin = getHtmlBlockOrigin();
  const surface = getSurfaceContext();
  // A saved render remembers its height under its work and version: that is
  // all a revision whose HTML is still on its host knows about itself.
  const heightKey = $derived(revision.workRef?.contentVersion ? `work:${revision.workRef.workId}:${revision.workRef.contentVersion}` : undefined);
  const pendingHtml = $derived(revision.pendingHtml?.artifact?.historyHtml);

  $effect(() => {
    const message = revision.pendingHtml;
    if (message) void loadArtifactHtml(message, worksArtifactHtmlSources(surface.worksStore));
  });
</script>

{#key revision.messageId}
  {#if pendingHtml?.error}
    <div class="py-2 text-sm text-(--muted-foreground)" role="alert">{pendingHtml.error}</div>
  {:else if pendingHtml}
    <div role="status" aria-busy="true" aria-label="Loading artifact" style="height:{(heightKey && lastReportedHeight(heightKey)) || 120}px"></div>
  {:else if revision.workRef}
    <ArtifactView artifact={{ kind: "html", html: revision.html }} workRef={revision.workRef} {showRail} {versions} {heightKey} tabId={origin?.().tabId} linkContext={origin?.().linkContext} skipMotion />
  {:else}
    <HtmlBlock html={revision.html} />
  {/if}
{/key}
