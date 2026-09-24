<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { LayoutTemplate as ArtifactIcon } from "@lucide/svelte";
  import { getSurfaceContext } from "../../contexts";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import ArtifactView from "./ArtifactView.svelte";

  /**
   * An artifact on an activity feed, at the moment it was linked: a task's
   * feed and a pull request's timeline both show one. Collapsed to its title
   * by default, so a feed with many renders stays a feed; opening it mounts
   * the live frame in place. The parent decides which card is open, so one
   * frame runs at a time.
   *
   * The card is the handle, not the render: it is the one raised object on a
   * feed of one-line events, a `TranscriptCard` with the artifact glyph that
   * says "this is a render" from across the page. When opened, the frame lands
   * below it flush on the feed, the way it sits in a conversation.
   */
  interface Props {
    workId: string;
    title: string;
    /** The task the artifact reached this surface through, when that is not
     *  the surface itself. */
    via?: string;
    open: boolean;
    /** False while the surface is mounted but hidden. The card stays where it
     *  is; the frame does not run for a reader who cannot see it. */
    enabled: boolean;
    onToggle: () => void;
  }

  let { workId, title, via, open, enabled, onToggle }: Props = $props();

  const session = getSurfaceContext();
  const html = $derived(session.worksStore.get(workId)?.content || null);

  // The work body is fetched the first time the card is opened on a visible
  // surface, not when the feed mounts: a feed lists every render ever linked.
  $effect(() => {
    if (!open || !enabled) return;
    void session.worksStore.ensureContent(workId, "activity-artifact");
  });
</script>

{#snippet viaRail()}via {via}{/snippet}

<TranscriptCard
  {title}
  type="artifact"
  expanded={open}
  glyphClass="is-artifact"
  ariaLabel={open ? `Hide ${title}` : `Show ${title}`}
  secondaryActionLabel={`Open ${title} in split`}
  data-testid="artifact-activity-card"
  rail={via ? viaRail : undefined}
  skipMotion
  onOpen={onToggle}
  onOpenSecondary={() => session.openWork(workId, "aside")}
>
  {#snippet glyph()}<ArtifactIcon />{/snippet}
</TranscriptCard>

<!-- The render sits under the card, not inside it: the frame is chrome-less
     everywhere else in Solus, and boxing it here made it read as a thumbnail
     of the artifact rather than the artifact. The card above is its handle. -->
{#if open}
  <div class="mt-2" data-testid="artifact-activity-render">
    {#if !enabled}
      <div class="py-2 text-sm text-(--solus-text-tertiary)" role="status">Render paused while this page is hidden.</div>
    {:else if html}
      <ArtifactView artifact={{ kind: "html", html }} skipMotion />
    {:else}
      <ContentSkeleton label="Loading artifact" preview />
    {/if}
  </div>
{/if}
