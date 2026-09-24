<script lang="ts">
  import { ChevronLeft, ChevronRight, LayoutTemplate as ArtifactIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import { Button } from "../ui/button";
  import HtmlBlock from "./HtmlBlock.svelte";
  import TranscriptCard from "./TranscriptCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import type { ArtifactRevision } from "./lib/artifact-revisions";

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
  const origin = getHtmlBlockOrigin();
  const disclosures = getTranscriptDisclosure();
  const latest = $derived(revisions[revisions.length - 1]);
  const isEarlier = $derived(!!revision && revision !== latest);
  // Include the successor in the key: each completed revision collapses older
  // cards once, while the reader can still reopen them after that update.
  const disclosure = $derived(disclosures.forKey(`artifact:${latest.identity}:${revision?.messageId ?? "update"}:${latest.messageId}`));
  const expanded = $derived(!isEarlier || disclosure.expanded);
  const selected = $derived(revisions.find((entry) => entry.messageId === disclosure.pickedId) ?? revision);
  const selectedIndex = $derived(selected ? revisions.indexOf(selected) : revisions.length);
  const title = $derived((selected ?? latest).title || "Artifact");
</script>

<div class="my-2 min-w-0" data-testid="conversation-artifact" data-artifact-version={selectedIndex + 1}>
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
      {#snippet rail()}v{selectedIndex + 1}{/snippet}
      {#snippet actions()}
        {#if expanded && selected}
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
  {:else if update || revisions.length > 1}
    <!-- A slim version line, no shell: the render below is the object. -->
    <div class="flex h-8 min-w-0 items-center gap-2 text-workspace-chrome text-(--solus-text-secondary) pointer-coarse:h-12">
      <span class="inline-flex w-5.5 shrink-0 justify-center text-primary"><ArtifactIcon size={13} /></span>
      <span class="min-w-0 truncate font-medium text-(--solus-text-primary)">{title}</span>
      <span class="shrink-0 text-transcript-meta tabular-nums text-(--muted-foreground)">
        {#if update}
          v{revisions.length + 1} · updating…
        {:else}
          v{selectedIndex + 1} of {revisions.length}{selected === latest ? " · latest" : ""}
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
          class="size-6.5 pointer-coarse:size-12"
          aria-label="Previous version"
          title="Previous version"
          disabled={selectedIndex === 0}
          onclick={() => (disclosure.pickedId = revisions[selectedIndex - 1].messageId)}
        ><ChevronLeft size={14} /></Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-6.5 pointer-coarse:size-12"
          aria-label="Next version"
          title="Next version"
          disabled={selected === latest}
          onclick={() => (disclosure.pickedId = revisions[selectedIndex + 1].messageId)}
        ><ChevronRight size={14} /></Button>
      {/if}
    </div>
  {/if}
  {#if update || (expanded && selected)}
    <div class={update || revisions.length > 1 ? "rounded-xl ring-[0.5px] ring-(--solus-tx-divider)" : ""}>
      {#if update}
        <ArtifactView artifact={update} skipMotion />
      {:else if selected}
        {#key selected.messageId}
        {#if selected.workRef}
          <ArtifactView artifact={{ kind: "html", html: selected.html }} workRef={selected.workRef} tabId={origin?.().tabId} linkContext={origin?.().linkContext} skipMotion />
        {:else}
          <HtmlBlock html={selected.html} />
        {/if}
        {/key}
      {/if}
    </div>
  {/if}
</div>
