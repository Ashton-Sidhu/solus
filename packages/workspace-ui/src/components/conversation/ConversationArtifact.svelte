<script lang="ts">
  import { ChevronDown, ChevronLeft, ChevronRight } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import { Button } from "../ui/button";
  import HtmlBlock from "./HtmlBlock.svelte";
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
  {#if update || revisions.length > 1}
    <div class="flex min-w-0 items-center gap-1 text-workspace-chrome text-(--solus-text-secondary)">
      <button
        type="button"
        class="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md py-1 pr-2 pl-1 text-left enabled:hover:bg-muted focus-visible:outline-2 focus-visible:outline-(--solus-accent) pointer-coarse:min-h-12"
        aria-expanded={isEarlier ? expanded : undefined}
        disabled={!isEarlier}
        onclick={() => (disclosure.expanded = !expanded)}
      >
        {#if isEarlier}
          {#if expanded}<ChevronDown size={16} class="shrink-0" />{:else}<ChevronRight size={16} class="shrink-0" />{/if}
        {/if}
        <span class="min-w-0 truncate font-medium text-(--solus-text-primary)">{title}</span>
        <span class="shrink-0 tabular-nums">
          {#if update}
            v{revisions.length + 1} · Updating…
          {:else}
            v{selectedIndex + 1} of {revisions.length}{selected === latest ? " · Latest" : ""}
          {/if}
        </span>
      </button>
      {#if expanded && selected}
        <Button
          variant="ghost"
          size="icon-sm"
          class="pointer-coarse:size-12"
          aria-label="Previous version"
          title="Previous version"
          disabled={selectedIndex === 0}
          onclick={() => (disclosure.pickedId = revisions[selectedIndex - 1].messageId)}
        ><ChevronLeft size={16} /></Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="pointer-coarse:size-12"
          aria-label="Next version"
          title="Next version"
          disabled={selected === latest}
          onclick={() => (disclosure.pickedId = revisions[selectedIndex + 1].messageId)}
        ><ChevronRight size={16} /></Button>
      {/if}
      {#if selected && selected !== latest}
        <Button
          variant="ghost"
          size="sm"
          class="text-workspace-chrome pointer-coarse:min-h-12"
          onclick={() => { disclosure.pickedId = latest.messageId; disclosure.expanded = true; }}
        >View latest</Button>
      {/if}
    </div>
  {/if}
  {#if update}
    <ArtifactView artifact={update} skipMotion />
  {:else if expanded && selected}
    {#key selected.messageId}
    {#if selected.workRef}
      <ArtifactView artifact={{ kind: "html", html: selected.html }} workRef={selected.workRef} tabId={origin?.().tabId} linkContext={origin?.().linkContext} skipMotion />
    {:else}
      <HtmlBlock html={selected.html} />
    {/if}
    {/key}
  {/if}
</div>
