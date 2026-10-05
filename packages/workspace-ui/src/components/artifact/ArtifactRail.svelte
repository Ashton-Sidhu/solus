<script lang="ts">
  import { PanelRightClose as OpenInSplitIcon } from "@lucide/svelte";
  import { getSurfaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ShareButton from "../sharing/ShareButton.svelte";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";

  /**
   * The persisted work behind a render: named, shareable, linkable to a task
   * when there is one to name, and one click from a pane where it has the full
   * works chrome (rename, history, export). Shown under an artifact card, and under an HTML block once the
   * reader has saved it as an artifact.
   */
  interface Props {
    workId: string;
    title: string;
    contentVersion?: number;
    /** Where the conversation lives, for the Link control. */
    linkContext?: TaskLinkContext;
  }

  let { workId, title, contentVersion, linkContext }: Props = $props();

  const session = getSurfaceContext();
  const shareServerId = $derived(session.worksStore.hostFor(workId));
</script>

<div class="artifact-rail" data-testid="artifact-rail">
  <span class="artifact-rail__kicker shrink-0">Artifact</span>
  <span class="artifact-rail__title min-w-0 truncate">{title}</span>
  {#if contentVersion}<span class="shrink-0 tabular-nums">v{contentVersion}</span>{/if}
  <span class="flex-1"></span>
  <TaskLinkControl
    target={{ kind: "work", targetScope: "", targetKey: workId }}
    {title}
    serverId={linkContext?.serverId}
    projectKey={linkContext?.projectKey}
    conversationTaskId={linkContext?.conversationTaskId}
    onlyWithTask
  />
  <!-- A scoped class would not reach the child, so the action's look is
       restated as utilities. -->
  <ShareButton
    serverId={shareServerId}
    resource={{ kind: "work", id: workId }}
    {title}
    class="inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--muted-foreground) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:size-12"
  />
  <button
    type="button"
    class="artifact-rail__action inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md pointer-coarse:size-12"
    data-testid="artifact-open-split"
    title="Open in split"
    aria-label="Open in split"
    onclick={() => {
      session.openWork(workId, "aside");
      requestInputFocus();
    }}
  >
    <OpenInSplitIcon size={14} />
  </button>
</div>

<style>
  .artifact-rail {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.375rem;
    padding: 0 0.25rem;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
  }

  .artifact-rail__kicker {
    font-weight: 500;
    text-transform: uppercase;
    opacity: 0.7;
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

  .artifact-rail__action:hover {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    color: var(--solus-text-primary);
  }

  .artifact-rail__action:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
</style>
