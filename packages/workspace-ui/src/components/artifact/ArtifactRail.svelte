<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";

  /**
   * The persisted work behind a render: named, linkable to a task, and one
   * click from a pane where it has the full works chrome (rename, history,
   * export). Shown under an artifact card, and under an HTML block once the
   * reader has saved it as an artifact.
   */
  interface Props {
    workId: string;
    title: string;
    /** Where the conversation lives, for the Link control. */
    linkContext?: TaskLinkContext;
  }

  let { workId, title, linkContext }: Props = $props();

  const session = getWorkspaceContext();
</script>

<div class="artifact-rail" data-testid="artifact-rail">
  <span class="artifact-rail__kicker shrink-0">Artifact</span>
  <span class="artifact-rail__title min-w-0 truncate">{title}</span>
  <span class="flex-1"></span>
  <TaskLinkControl
    target={{ kind: "work", targetScope: "", targetKey: workId }}
    {title}
    serverId={linkContext?.serverId}
    projectKey={linkContext?.projectKey}
    conversationTaskId={linkContext?.conversationTaskId}
  />
  <button
    type="button"
    class="artifact-rail__action shrink-0 cursor-pointer rounded-md px-2 py-1"
    data-testid="artifact-open-split"
    onclick={() => {
      session.openWork(workId, "aside");
      requestInputFocus();
    }}
  >
    Open in split
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
