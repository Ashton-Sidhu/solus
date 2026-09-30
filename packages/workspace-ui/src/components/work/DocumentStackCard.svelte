<script lang="ts">
  import {
    AppWindow as AppWindowIcon,
    FileText as FileTextIcon,
    Presentation as PresentationIcon,
    Workflow as WorkflowIcon,
  } from "@lucide/svelte";
  import { getClientShellContext, getSurfaceContext } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import {
    stackLastEditedAt,
    stackTitle,
    type DocumentStackEntry,
  } from "./lib/document-stack";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardRow from "../conversation/TranscriptCardRow.svelte";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import WorkPublishMenu from "./WorkPublishMenu.svelte";

  interface Props {
    entries: DocumentStackEntry[];
    linkContext?: TaskLinkContext;
    skipMotion?: boolean;
  }
  let { entries, linkContext, skipMotion = false }: Props = $props();

  const session = getSurfaceContext();
  const shell = getClientShellContext();

  const title = $derived(stackTitle(entries));
  const writing = $derived(entries.some((entry) => entry.streaming));
  const lastEditedAt = $derived(stackLastEditedAt(entries));
  // Publish and link need a stable work, so a work still being written has none.
  const settled = $derived(entries.filter((entry) => !entry.streaming));
  // A client without a workspace has no panes, so nothing is open in one.
  const openWorkId = $derived(session.workspace?.router.params("work")?.workId ?? null);

  function open(entry: DocumentStackEntry) {
    shell.openResource({ kind: "work", workId: entry.workId, title: entry.title });
  }

  function openInSplit(entry: DocumentStackEntry) {
    session.openWork(entry.workId, "aside");
  }
</script>

<TranscriptCard
  {title}
  type={writing ? "writing" : undefined}
  bodyLayout="rows"
  data-testid="document-stack-card"
  menu={settled.length > 0 ? stackMenu : undefined}
  {skipMotion}
>
  {#snippet rail()}
    {#if !writing && lastEditedAt}edited {relativeTime(lastEditedAt)}{/if}
  {/snippet}
  {#snippet body()}
    {#each entries as entry (entry.workId)}
      <TranscriptCardRow
        name={entry.title}
        ariaLabel={`Open ${entry.title}`}
        secondaryActionLabel={`Open ${entry.title} in side pane`}
        glyphClass={entry.workType === "artifact" && !entry.streaming ? "is-artifact" : ""}
        open={entry.workId === openWorkId}
        onOpen={() => open(entry)}
        onOpenSecondary={() => openInSplit(entry)}
      >
        {#snippet glyph()}
          {#if entry.streaming}
            <span class="activity-spinner"></span>
          {:else if entry.workType === "slides"}
            <PresentationIcon />
          {:else if entry.workType === "diagram"}
            <WorkflowIcon />
          {:else if entry.workType === "artifact"}
            <AppWindowIcon />
          {:else}
            <FileTextIcon />
          {/if}
        {/snippet}
      </TranscriptCardRow>
    {/each}
  {/snippet}
</TranscriptCard>

{#snippet stackMenu()}
  <!-- One publish and one link control per work: the card acts on each
       work, not on the stack. -->
  {#each settled as entry (entry.workId)}
    {#if settled.length > 1}
      <span
        class="text-transcript-meta truncate px-2 pt-1.5 pb-0.5 text-(--muted-foreground)"
      >
        {entry.title}
      </span>
    {/if}
    <WorkPublishMenu workId={entry.workId} triggerVariant="conversation-card" />
    <TaskLinkControl
      target={{ kind: "work", targetScope: "", targetKey: entry.workId }}
      title={entry.title}
      serverId={linkContext?.serverId}
      projectKey={linkContext?.projectKey}
      conversationTaskId={linkContext?.conversationTaskId}
    />
  {/each}
{/snippet}
