<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import {
    AppWindow as AppWindowIcon,
    Check as CheckIcon,
    FileText as FileTextIcon,
    List as ListIcon,
    Presentation as PresentationIcon,
    Workflow as WorkflowIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import WorkGeneratingSkeleton from "../work/WorkGeneratingSkeleton.svelte";
  import { summarizeDiagram, parseDiagram } from "@solus/contracts/diagram-types";
  import type { PlanMessageRef } from "@solus/contracts/types";
  import type { TaskLinkTarget } from "@solus/contracts/task-types";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import WorkPublishMenu from "../work/WorkPublishMenu.svelte";

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
  const comments = $derived(ref.comments || []);
  const planStatus = $derived(ref.status ?? "pending");
  const isPending = $derived(planStatus === "pending");

  // The type word carries the state; the glyph repeats it.
  const planType = $derived(
    planStatus === "accepted"
      ? "plan accepted"
      : planStatus === "rejected"
        ? "plan rejected"
        : "plan",
  );

  const isDiagram = $derived(ref.workType === "diagram");
  const isStreaming = $derived(ref.streaming ?? false);
  const workType = $derived(
    ref.workType === "slides"
      ? "slides"
      : ref.workType === "artifact"
        ? "artifact"
        : "doc",
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
    compactMeta(ref.updatedAt ? `edited ${formatDate(ref.updatedAt)}` : ""),
  );
  const planMeta = $derived(
    comments.length > 0
      ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
      : undefined,
  );

  const isWorkOpen = $derived(!!ref.id && session.router.params("work")?.workId === ref.id);
  const isPlanOpen = $derived(!!ref.id && session.router.params("plan")?.planId === ref.id);

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
  <WorkGeneratingSkeleton title={ref.title} workType={ref.workType} content={ref.content} />
{:else if ref.kind === "document" && isDiagram}
  <TranscriptCard
    title={ref.title ?? "Untitled diagram"}
    type="diagram"
    actionLabel="Open"
    ariaLabel={`Open diagram: ${ref.title ?? "Untitled diagram"}`}
    onOpen={openWork}
    onOpenSecondary={openWorkSecondary}
    secondaryActionLabel="Open diagram in side pane"
    open={isWorkOpen}
    bodyLayout="media"
    data-testid="diagram-card"
    {skipMotion}
  >
    {#snippet glyph()}<WorkflowIcon />{/snippet}
    {#snippet rail()}{diagramSummary}{/snippet}
    {#snippet menu()}{@render taskLink()}{/snippet}
    {#snippet body()}
      {#if ref.content}
        <div class="h-[9.375rem] overflow-hidden">
          {#await import("../diagram/DiagramThumbnail.svelte")}
            <ContentSkeleton label="Loading diagram preview" preview />
          {:then diagramThumbnailModule}
            {@const DiagramThumbnail = diagramThumbnailModule.default}
            <DiagramThumbnail content={ref.content} />
          {/await}
        </div>
      {/if}
    {/snippet}
  </TranscriptCard>
{:else if ref.kind === "document"}
  <TranscriptCard
    title={ref.title ?? "Untitled document"}
    type={workType}
    actionLabel="Open"
    ariaLabel={`Open document: ${ref.title ?? "Untitled document"}`}
    onOpen={openWork}
    onOpenSecondary={openWorkSecondary}
    secondaryActionLabel="Open document in side pane"
    open={isWorkOpen}
    glyphClass={ref.workType === "artifact" ? "is-artifact" : ""}
    data-testid="document-card"
    {skipMotion}
  >
    {#snippet glyph()}
      {#if ref.workType === "slides"}<PresentationIcon />{:else if ref.workType === "artifact"}<AppWindowIcon />{:else}<FileTextIcon />{/if}
    {/snippet}
    {#snippet rail()}{documentMeta}{/snippet}
    {#snippet menu()}
      {#if ref.id}
        <WorkPublishMenu workId={ref.id} triggerVariant="conversation-card" />
      {/if}
      {@render taskLink()}
    {/snippet}
  </TranscriptCard>
{:else}
  <TranscriptCard
    title={ref.title ?? "Plan"}
    type={planType}
    actionLabel={isPending ? "Review" : "Open"}
    actionFilled={isPending}
    ariaLabel={ref.id ? `Open plan: ${ref.title ?? "Plan"}` : "Plan"}
    onOpen={openPlan}
    onOpenSecondary={openPlanSecondary}
    secondaryActionLabel="Open plan in side pane"
    open={isPlanOpen}
    glyphClass={planStatus === "accepted" ? "is-done" : ""}
    data-testid="plan-card"
    {skipMotion}
  >
    {#snippet glyph()}
      {#if planStatus === "accepted"}<CheckIcon />{:else if planStatus === "rejected"}<XIcon />{:else}<ListIcon />{/if}
    {/snippet}
    {#snippet rail()}{planMeta}{/snippet}
    {#snippet menu()}
      {@render taskLink()}
      {#if ref.id}
        <TranscriptCardAction kind="item" onclick={() => void navigator.clipboard.writeText(ref.id ?? "")}>
          Copy id <span class="ml-auto font-mono opacity-60">{ref.id.slice(0, 8)}</span>
        </TranscriptCardAction>
      {/if}
    {/snippet}
  </TranscriptCard>
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
