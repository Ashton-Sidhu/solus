<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import { FileText as FileTextIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
  import WorkGeneratingSkeleton from "../work/WorkGeneratingSkeleton.svelte";
  import { summarizeDiagram, parseDiagram } from "@solus/contracts/diagram-types";
  import type { PlanMessageRef } from "@solus/contracts/types";
  import type { TaskLinkTarget } from "@solus/contracts/task-types";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";

  interface Props {
    ref: PlanMessageRef;
    /** The task-link identity of what the card shows, once it has a stable
     *  id: a work id, or a plan's session and tool-use ids. */
    linkTarget?: TaskLinkTarget;
    linkContext?: TaskLinkContext;
    skipMotion?: boolean;
  }
  let { ref, linkTarget, linkContext, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const content = $derived(ref.content || "");
  const comments = $derived(ref.comments || []);
  const planStatus = $derived(ref.status ?? "pending");
  const isPending = $derived(planStatus === "pending");
  const previewLines = $derived(content.split("\n").slice(0, 6).join("\n"));
  const hasMore = $derived(content.split("\n").length > 6);

  // The kicker already says "Plan", so the chip carries state and nothing else.
  const statusChip = $derived(
    planStatus === "accepted"
      ? { label: "Accepted", state: "positive" as const }
      : planStatus === "rejected"
        ? { label: "Rejected", state: "destructive" as const }
        : { label: "Proposed", state: "neutral" as const },
  );

  // Render enough lines to fill the page frame; the preview is clipped by height
  // (overflow + fade), not by line count, so this just needs to overflow it.
  const workPreviewLines = $derived(
    ref.content ? ref.content.split("\n").slice(0, 14).join("\n") : null,
  );

  const isDiagram = $derived(ref.workType === "diagram");
  const isStreaming = $derived(ref.streaming ?? false);
  // One word, never two, never abbreviated — it states the type so the chip is
  // free to carry state and the header needs no colour at all.
  const workKicker = $derived(
    ref.workType === "slides"
      ? "Slides"
      : ref.workType === "artifact"
        ? "Artifact"
        : isDiagram
          ? "Diagram"
          : "Document",
  );
  const diagramSummary = $derived(
    isDiagram && ref.content
      ? (() => {
          try {
            return summarizeDiagram(parseDiagram(ref.content!));
          } catch {
            return "";
          }
        })()
      : "",
  );
  const documentMeta = $derived(
    compactMeta(ref.updatedAt ? `Edited ${formatDate(ref.updatedAt)}` : ""),
  );
  const planMeta = $derived(
    compactMeta(
      ref.timestamp ? formatDate(ref.timestamp) : "",
      comments.length > 0
        ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
        : "",
    ),
  );

  function openWork() {
    void session.openWorkModal(ref.id!, ref.title);
  }

  function openWorkSecondary() {
    if (ref.id) session.openWork(ref.id, "aside");
  }

  function openPlan() {
    if (ref.id) void session.openPlanModal(ref.id);
  }

  function openPlanSecondary() {
    if (ref.id)
      void session.openPlanModal(ref.id, undefined, { secondary: true });
  }

  function formatDate(value: string | number): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function compactMeta(
    ...parts: Array<string | undefined>
  ): string | undefined {
    const text = parts.filter((part) => part && part.trim()).join(" · ");
    return text || undefined;
  }
</script>

{#if ref.kind === "document" && isStreaming}
  <WorkGeneratingSkeleton workType={ref.workType} />
{:else if ref.kind === "document" && isDiagram}
  <ConversationRefCard
    kicker="Diagram"
    title={ref.title ?? "Untitled diagram"}
    subtitle={compactMeta(
      ref.updatedAt ? `Updated ${formatDate(ref.updatedAt)}` : "",
      diagramSummary,
    )}
    actionLabel="Open"
    ariaLabel={`Open diagram: ${ref.title ?? "Untitled diagram"}`}
    onOpen={openWork}
    onOpenSecondary={openWorkSecondary}
    secondaryActionLabel="Open diagram in side pane"
    data-testid="diagram-card"
    bleedBody
    {skipMotion}
  >
    {#if ref.content}
      <div class="diagram-ref-preview">
        {#await import("../diagram/DiagramThumbnail.svelte")}
          <ContentSkeleton label="Loading diagram preview" preview />
        {:then diagramThumbnailModule}
          {@const DiagramThumbnail = diagramThumbnailModule.default}
          <DiagramThumbnail content={ref.content} />
        {/await}
      </div>
    {/if}

    {#snippet footer()}
      <button
        type="button"
        class="ref-card-rail-action"
        onclick={(e) => {
          e.stopPropagation();
          openWorkSecondary();
        }}
      >
        Open in split
      </button>
      <span class="flex-1"></span>
      {@render taskLink()}
    {/snippet}
  </ConversationRefCard>
{:else if ref.kind === "document"}
  <ConversationRefCard
    kicker={workKicker}
    title={ref.title ?? "Untitled document"}
    subtitle={documentMeta}
    actionLabel="Open"
    ariaLabel={`Open document: ${ref.title ?? "Untitled document"}`}
    onOpen={openWork}
    onOpenSecondary={openWorkSecondary}
    secondaryActionLabel="Open document in side pane"
    data-testid="document-card"
    {skipMotion}
  >
    {#snippet footer()}
      <button
        type="button"
        class="ref-card-rail-action"
        onclick={(e) => {
          e.stopPropagation();
          openWorkSecondary();
        }}
      >
        Open in split
      </button>
      <span class="flex-1"></span>
      {@render taskLink()}
    {/snippet}
  </ConversationRefCard>
{:else}
  <ConversationRefCard
    kicker="Plan"
    title={ref.title ?? "Plan"}
    subtitle={planMeta}
    actionLabel={isPending ? "Review" : "Open"}
    ariaLabel={ref.id ? `Open plan: ${ref.title ?? "Plan"}` : "Plan"}
    onOpen={openPlan}
    onOpenSecondary={openPlanSecondary}
    secondaryActionLabel="Open plan in side pane"
    data-testid="plan-card"
    {skipMotion}
  >
    {#snippet chip()}
      <TranscriptChip state={statusChip.state}
        >{statusChip.label}</TranscriptChip
      >
    {/snippet}

    {#snippet footer()}
      <button
        type="button"
        class="ref-card-rail-action"
        onclick={(e) => {
          e.stopPropagation();
          openPlanSecondary();
        }}
      >
        Open in split
      </button>
      <span class="flex-1"></span>
      {@render taskLink()}
      {#if ref.id}
        <span class="ref-card-rail-id">{ref.id.slice(0, 8)}</span>
      {/if}
    {/snippet}
  </ConversationRefCard>
{/if}

<!-- The rail's Link control: present once the card has a stable identity to
     link, absent while a write is still streaming in. -->
{#snippet taskLink()}
  {#if linkTarget && !isStreaming}
    <TaskLinkControl
      target={linkTarget}
      title={ref.title ?? ""}
      serverId={linkContext?.serverId}
      projectKey={linkContext?.projectKey}
      conversationTaskId={linkContext?.conversationTaskId}
    />
  {/if}
{/snippet}

<style>
  /* Ghost buttons on the card's meta rung, mono id at 60% pushed right. The
     rail annotates the card, so it follows the display exactly as the meta
     line above it does rather than pinning a size the laptop cannot step. */
  .ref-card-rail-action {
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    padding: 0.3125rem 0.5rem;
    color: var(--muted-foreground);
    font-size: var(--text-transcript-meta);
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .ref-card-rail-action:hover {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
  }

  .ref-card-rail-id {
    padding-right: 0.25rem;
    color: var(--muted-foreground);
    font-family: var(--solus-code-font-family);
    font-size: var(--text-transcript-meta);
    opacity: 0.6;
  }

  .diagram-ref-preview {
    height: 12rem;
    overflow: hidden;
  }

</style>
