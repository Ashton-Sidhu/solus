<script lang="ts">
  import { ChevronLeft, ChevronRight, LayoutTemplate as ArtifactIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import type { ArtifactVersions } from "../artifact/ArtifactRail.svelte";
  import { Button } from "../ui/button";
  import ArtifactRevisionRender from "./ArtifactRevisionRender.svelte";
  import TranscriptCard from "./TranscriptCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import type { ArtifactRevision } from "./lib/artifact-revisions";
  import { latestVersion, revisionVersion } from "./lib/artifact-group";

  /**
   * One card in an artifact's revision chain: a completed `revision`, or an
   * `update` that is still being written. A chain of one is a plain render;
   * the version header appears only once there is a second version to tell
   * apart from the first.
   */
  let { revisions, revision, update }: {
    revisions: ArtifactRevision[];
    revision?: ArtifactRevision;
    update?: NonNullable<Message["artifact"]>;
  } = $props();
  const disclosures = getTranscriptDisclosure();
  const latest = $derived(revisions[revisions.length - 1]);
  const isEarlier = $derived(!!revision && revision !== latest);
  // Include the successor in the key: each completed revision collapses older
  // cards once, while the reader can still reopen them after that update.
  const disclosure = $derived(disclosures.forKey(`artifact:${latest.identity}:${revision?.messageId ?? "update"}:${latest.messageId}`));
  const expanded = $derived(!isEarlier || disclosure.expanded);
  const selected = $derived(revisions.find((entry) => entry.messageId === disclosure.pickedId) ?? revision);
  const selectedIndex = $derived(selected ? revisions.indexOf(selected) : revisions.length);
  // One number for a version everywhere: the one the host saved, as the frame shows.
  const selectedVersion = $derived(revisionVersion(revisions, selectedIndex));
  const title = $derived((selected ?? latest).title || "Artifact");
  // A saved version that renders has the rail: the version line and its
  // controls go in that row. Otherwise the card or the line keeps them.
  const hasRail = $derived(expanded && !update && !!selected?.workRef && !selected.pendingHtml?.artifact?.historyHtml);
  const versions = $derived.by((): ArtifactVersions | undefined => {
    if (!selected || revisions.length < 2) return undefined;
    return {
      number: selectedVersion,
      count: latestVersion(revisions),
      isFirst: selectedIndex === 0,
      isLatest: selected === latest,
      showPrevious: () => (disclosure.pickedId = revisions[selectedIndex - 1].messageId),
      showNext: () => (disclosure.pickedId = revisions[selectedIndex + 1].messageId),
      showLatest: () => { disclosure.pickedId = latest.messageId; disclosure.expanded = true; },
    };
  });
</script>

<div class="my-2 min-w-0" data-testid="conversation-artifact" data-artifact-version={selected ? selectedVersion : latestVersion(revisions) + 1}>
  {#if isEarlier}
    <!-- An earlier version stays a quiet, superseded card; opening it shows
         that version under the card. -->
    <TranscriptCard
      {title}
      type="earlier version"
      superseded
      {expanded}
      glyphClass="is-artifact"
      skipMotion
      onOpen={() => (disclosure.expanded = !expanded)}
    >
      {#snippet glyph()}<ArtifactIcon />{/snippet}
      {#snippet rail()}v{selectedVersion}{/snippet}
      {#snippet actions()}
        {#if expanded && selected && !hasRail}
          <TranscriptCardAction
            kind="icon"
            label="Previous version"
            disabled={selectedIndex === 0}
            onclick={() => (disclosure.pickedId = revisions[selectedIndex - 1].messageId)}
          ><ChevronLeft size={13} /></TranscriptCardAction>
          <TranscriptCardAction
            kind="icon"
            label="Next version"
            disabled={selected === latest}
            onclick={() => (disclosure.pickedId = revisions[selectedIndex + 1].messageId)}
          ><ChevronRight size={13} /></TranscriptCardAction>
          {#if selected !== latest}
            <TranscriptCardAction
              kind="ghost"
              onclick={() => { disclosure.pickedId = latest.messageId; disclosure.expanded = true; }}
            >View latest</TranscriptCardAction>
          {/if}
        {/if}
      {/snippet}
    </TranscriptCard>
  {:else if (update || revisions.length > 1) && !hasRail}
    <!-- A slim version line, no shell: the render below is the object. -->
    <div class="flex h-8 min-w-0 items-center gap-2 text-workspace-chrome text-(--solus-text-secondary) pointer-coarse:h-12">
      <span class="inline-flex w-5.5 shrink-0 justify-center text-primary"><ArtifactIcon size={13} /></span>
      <span class="min-w-0 truncate font-medium text-(--solus-text-primary)">{title}</span>
      <span class="shrink-0 text-transcript-meta tabular-nums text-(--muted-foreground)">
        {#if update}
          v{latestVersion(revisions) + 1} · updating…
        {:else}
          v{selectedVersion} of {latestVersion(revisions)}{selected === latest ? " · latest" : ""}
        {/if}
      </span>
      <span class="flex-1"></span>
      {#if selected}
        {#if selected !== latest}
          <Button
            variant="ghost"
            size="sm"
            class="text-workspace-chrome pointer-coarse:min-h-12"
            onclick={() => { disclosure.pickedId = latest.messageId; disclosure.expanded = true; }}
          >View latest</Button>
        {/if}
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-6.5 pointer-coarse:tap-area"
          aria-label="Previous version"
          title="Previous version"
          disabled={selectedIndex === 0}
          onclick={() => (disclosure.pickedId = revisions[selectedIndex - 1].messageId)}
        ><ChevronLeft size={14} /></Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-6.5 pointer-coarse:tap-area"
          aria-label="Next version"
          title="Next version"
          disabled={selected === latest}
          onclick={() => (disclosure.pickedId = revisions[selectedIndex + 1].messageId)}
        ><ChevronRight size={14} /></Button>
      {/if}
    </div>
  {/if}
  {#if update}
    <ArtifactView artifact={update} skipMotion />
  {:else if expanded && selected}
    <ArtifactRevisionRender revision={selected} {versions} />
  {/if}
</div>
