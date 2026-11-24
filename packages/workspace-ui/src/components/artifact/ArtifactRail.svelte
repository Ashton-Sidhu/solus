<script module lang="ts">
  /** Where a render sits in its revision chain, and how to move along it. */
  export interface ArtifactVersions {
    number: number;
    count: number;
    isFirst: boolean;
    isLatest: boolean;
    showPrevious(): void;
    showNext(): void;
    showLatest(): void;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ChevronLeft,
    ChevronRight,
    LayoutTemplate as ArtifactIcon,
    PanelRightClose as OpenInSplitIcon,
  } from "@lucide/svelte";
  import { getSurfaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ShareButton from "../sharing/ShareButton.svelte";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";

  /**
   * The persisted work behind a render: named, shareable, linkable to a task
   * when there is one to name, and one click from a pane where it has the full
   * works chrome (rename, history, export). It is the one header row of an
   * artifact card, and of an HTML block once the reader has saved it as an
   * artifact: the version controls and the frame's controls sit in it too.
   */
  interface Props {
    workId: string;
    title: string;
    contentVersion?: number;
    /** Where the conversation lives, for the Link control. */
    linkContext?: TaskLinkContext;
    /** The revision chain this render is one version of. */
    versions?: ArtifactVersions;
    /** From `SandboxFrame`'s header: draws content in the frame's pill. */
    pill?: Snippet<[Snippet]>;
    /** From `SandboxFrame`'s header: the frame's own pill, starting with the
     *  rail's actions. Without it, the rail's actions stand alone. */
    controls?: Snippet<[Snippet]>;
  }

  let { workId, title, contentVersion, linkContext, versions, pill, controls }: Props = $props();

  const session = getSurfaceContext();
  const shareServerId = $derived(session.worksStore.hostFor(workId));
</script>

{#snippet versionControls()}
  {#if versions && !versions.isLatest}
    <button
      type="button"
      class="artifact-action is-labelled artifact-rail__action inline-flex h-6.5 shrink-0 cursor-pointer items-center rounded-md px-2 pointer-coarse:tap-area"
      onclick={versions.showLatest}
    >View latest</button>
  {/if}
  <button
    type="button"
    class="artifact-action artifact-rail__action inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md disabled:cursor-default disabled:opacity-45 pointer-coarse:tap-area"
    aria-label="Previous version"
    title="Previous version"
    disabled={versions?.isFirst}
    onclick={versions?.showPrevious}
  ><ChevronLeft size={14} /></button>
  <button
    type="button"
    class="artifact-action artifact-rail__action inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md disabled:cursor-default disabled:opacity-45 pointer-coarse:tap-area"
    aria-label="Next version"
    title="Next version"
    disabled={versions?.isLatest}
    onclick={versions?.showNext}
  ><ChevronRight size={14} /></button>
{/snippet}

{#snippet workActions()}
  <TaskLinkControl
    target={{ kind: "work", targetScope: "", targetKey: workId }}
    {title}
    serverId={linkContext?.serverId}
    conversationTaskId={linkContext?.conversationTaskId}
    onlyWithTask
  />
  <!-- A scoped class would not reach the child, so the action's look is
       restated as utilities. In the frame's pill, its style wins. -->
  <ShareButton
    serverId={shareServerId}
    resource={{ kind: "work", id: workId }}
    {title}
    class="artifact-action inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--muted-foreground) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:size-12"
  />
  <button
    type="button"
    class="artifact-action artifact-rail__action inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md pointer-coarse:tap-area"
    data-testid="artifact-open-split"
    title="Open in split"
    aria-label="Open in split"
    onclick={() => {
      session.openWork(workId);
      requestInputFocus();
    }}
  >
    <OpenInSplitIcon size={14} />
  </button>
{/snippet}

<div class="artifact-rail" data-testid="artifact-rail">
  <span class="inline-flex shrink-0 text-primary"><ArtifactIcon size={13} aria-hidden="true" /></span>
  <span class="sr-only">Artifact</span>
  <span class="artifact-rail__title min-w-0 truncate">{title}</span>
  {#if versions}
    <span class="shrink-0 tabular-nums">v{versions.number} of {versions.count}{versions.isLatest ? " · latest" : ""}</span>
  {:else if contentVersion}
    <span class="shrink-0 tabular-nums">v{contentVersion}</span>
  {/if}
  <span class="flex-1"></span>
  {#if versions}
    {#if pill}{@render pill(versionControls)}{:else}{@render versionControls()}{/if}
  {/if}
  {#if controls}{@render controls(workActions)}{:else}{@render workActions()}{/if}
</div>

<style>
  .artifact-rail {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.375rem;
    padding: 0 0.25rem;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
  }

  .artifact-rail__title {
    color: var(--solus-text-primary);
    font-weight: 500;
  }

  .artifact-rail__action {
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .artifact-rail__action:hover:not(:disabled) {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    color: var(--solus-text-primary);
  }

  .artifact-rail__action:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
</style>
