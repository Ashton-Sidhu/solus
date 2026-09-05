<script lang="ts">
  import {
    LayoutTemplate as ArtifactIcon,
    ChevronDown as CaretDownIcon,
    PanelRight as PanelRightIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import ArtifactView from "./ArtifactView.svelte";

  /**
   * An artifact on an activity feed, at the moment it was linked: a task's
   * feed and a pull request's timeline both show one. Collapsed to its title
   * by default, so a feed with many renders stays a feed; opening it mounts
   * the live frame in place. The parent decides which card is open, so one
   * frame runs at a time.
   *
   * The card is the handle, not the render: it is the one raised object on a
   * feed of one-line events, with the accent disc and kicker that say "this
   * is a render" from across the page. When opened, the frame lands below it
   * flush on the feed, the way it sits in a conversation.
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

  const session = getWorkspaceContext();
  const html = $derived(session.worksStore.get(workId)?.content || null);

  // The work body is fetched the first time the card is opened on a visible
  // surface, not when the feed mounts: a feed lists every render ever linked.
  $effect(() => {
    if (!open || !enabled) return;
    void session.worksStore.ensureContent(workId, "activity-artifact");
  });
</script>

<div
  class="group/artifact w-full overflow-hidden rounded-xl border border-(--solus-tool-border) bg-(--solus-container-bg) shadow-[shadow:var(--solus-tx-card-shadow)] transition-[border-color,box-shadow] duration-(--duration-base) ease-(--ease-premium) hover:border-(--solus-accent-border) hover:shadow-[shadow:var(--solus-tx-card-shadow-hover)]"
  class:border-(--solus-accent-border)={open}
  data-testid="artifact-activity-card"
>
  <div class="flex items-center gap-2.5 px-3 py-2.5">
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 overflow-hidden text-left"
      onclick={onToggle}
      aria-expanded={open}
    >
      <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-(--solus-accent-soft) text-(--solus-accent)">
        <ArtifactIcon size={14} />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-(--solus-text-tertiary)">Artifact</span>
        <span class="flex min-w-0 items-baseline gap-2">
          <span class="min-w-0 truncate text-sm font-medium tracking-[-0.005em] text-(--solus-text-primary)">{title}</span>
          {#if via}
            <span class="min-w-0 shrink truncate text-xs text-(--solus-text-tertiary)">via {via}</span>
          {/if}
        </span>
      </span>
      <span class="flex shrink-0 items-center gap-1 text-xs font-medium text-(--solus-text-secondary)">
        {open ? "Hide" : "Show"}
        <CaretDownIcon
          size={12}
          class="transition-transform duration-(--duration-quick) {open ? 'rotate-180' : ''}"
        />
      </span>
    </button>
    <button
      type="button"
      class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-(--solus-text-tertiary) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      onclick={() => session.openWork(workId, "aside")}
      title="Open in split"
      aria-label={`Open ${title} in split`}
    >
      <PanelRightIcon size={13} />
    </button>
  </div>
</div>

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
      <div class="py-2 text-sm text-(--solus-text-tertiary)" role="status">Loading artifact…</div>
    {/if}
  </div>
{/if}
