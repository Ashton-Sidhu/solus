<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import {
    FileTextIcon,
    GraphIcon,
    ClipboardTextIcon,
    CheckCircleIcon,
    XCircleIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
  import WorkGeneratingSkeleton from "../work/WorkGeneratingSkeleton.svelte";
  import { summarizeDiagram, parseDiagram } from "../../../shared/diagram-types";
  import type { PlanMessageRef } from "../../../shared/types";

  interface Props {
    ref: PlanMessageRef;
    skipMotion?: boolean;
  }
  let { ref, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const content = $derived(ref.content || "");
  const comments = $derived(ref.comments || []);
  const planStatus = $derived(ref.status ?? "pending");
  const isPending = $derived(planStatus === "pending");
  const previewLines = $derived(content.split("\n").slice(0, 6).join("\n"));
  const hasMore = $derived(content.split("\n").length > 6);

  const statusMeta = $derived(
    planStatus === "accepted"
      ? { label: "Plan accepted", Icon: CheckCircleIcon }
      : planStatus === "rejected"
        ? { label: "Plan rejected", Icon: XCircleIcon }
        : { label: "Plan", Icon: ClipboardTextIcon },
  );

  // Render enough lines to fill the page frame; the preview is clipped by height
  // (overflow + fade), not by line count, so this just needs to overflow it.
  const workPreviewLines = $derived(
    ref.content ? ref.content.split("\n").slice(0, 14).join("\n") : null,
  );

  const isDiagram = $derived(ref.workType === "diagram");
  const isStreaming = $derived(ref.streaming ?? false);
  const workTypeLabel = $derived(
    ref.workType === "slides" ? "Slide deck" : isDiagram ? "Architecture diagram" : "Document",
  );
  const diagramSummary = $derived(
    isDiagram && ref.content
      ? (() => { try { return summarizeDiagram(parseDiagram(ref.content!)) } catch { return "" } })()
      : "",
  );
  const documentMeta = $derived(compactMeta(workTypeLabel, ref.updatedAt ? `Updated ${formatDate(ref.updatedAt)}` : ""));
  const planMeta = $derived(compactMeta(
    planStatus === "pending" ? "Pending plan" : statusMeta.label,
    ref.timestamp ? formatDate(ref.timestamp) : "",
    comments.length > 0 ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "",
  ));

  function openWork() {
    void session.openWorkModal(ref.id!, ref.title);
  }

  function openWorkSecondary() {
    if (ref.id) session.panes.moveToSecondary({ kind: "work", workId: ref.id });
  }

  function openPlan() {
    if (ref.id) void session.openPlanModal(ref.id);
  }

  function openPlanSecondary() {
    if (ref.id) void session.openPlanModal(ref.id, undefined, { secondary: true });
  }

  function formatDate(value: string | number): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function compactMeta(...parts: Array<string | undefined>): string | undefined {
    const text = parts.filter((part) => part && part.trim()).join(" · ");
    return text || undefined;
  }
</script>

{#if ref.kind === "document" && isStreaming}
  <WorkGeneratingSkeleton workType={ref.workType} />
{:else if ref.kind === "document" && isDiagram}
  <ConversationRefCard
    title={ref.title ?? "Untitled diagram"}
    subtitle={compactMeta("Architecture diagram", ref.updatedAt ? `Updated ${formatDate(ref.updatedAt)}` : "", diagramSummary)}
    actionLabel="Open"
    ariaLabel={`Open diagram: ${ref.title ?? "Untitled diagram"}`}
    onOpen={openWork}
    onOpenSecondary={openWorkSecondary}
    secondaryActionLabel="Open diagram in side pane"
    data-testid="diagram-card"
    {skipMotion}
  >
    {#snippet icon()}
      <GraphIcon size={18} />
    {/snippet}

    {#if ref.content}
      <div class="diagram-ref-preview">
        {#await import("../diagram/DiagramThumbnail.svelte")}
          <div
            class="grid min-h-36 place-items-center text-xs text-(--solus-text-tertiary)"
            role="status"
          >
            Loading diagram preview…
          </div>
        {:then diagramThumbnailModule}
          {@const DiagramThumbnail = diagramThumbnailModule.default}
          <DiagramThumbnail content={ref.content} />
        {/await}
      </div>
    {/if}
  </ConversationRefCard>
{:else if ref.kind === "document"}
  <ConversationRefCard
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
    {#snippet icon()}
      <FileTextIcon size={18} weight="duotone" class="text-(--solus-accent)" />
    {/snippet}

    {#if workPreviewLines}
      <div class="work-ref-preview" aria-hidden="true">
        <div class="work-ref-preview__rule"></div>
        <div class="work-ref-preview__content prose-cloud">
          <SvelteMarkdown
            source={workPreviewLines}
            renderers={{ link: MarkdownLink }}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>
        <div class="work-ref-preview__fade"></div>
      </div>
    {:else}
      <button
        type="button"
        class="plan-card-placeholder"
        onclick={(e) => {
          e.stopPropagation();
          openWork();
        }}
      >
        <span class="plan-card-placeholder-icon">
          <FileTextIcon size={16} weight="regular" />
        </span>
        <span class="plan-card-placeholder-text">Open to preview</span>
      </button>
    {/if}
  </ConversationRefCard>
{:else}
  {@const StatusIcon = statusMeta.Icon}
  <ConversationRefCard
    title={ref.title ?? statusMeta.label}
    subtitle={planMeta}
    actionLabel={isPending ? "Review" : "Open"}
    ariaLabel={ref.id ? `Open ${statusMeta.label.toLowerCase()}` : statusMeta.label}
    onOpen={openPlan}
    onOpenSecondary={openPlanSecondary}
    secondaryActionLabel="Open plan in side pane"
    data-testid="plan-card"
    {skipMotion}
  >
    {#snippet icon()}
      <StatusIcon size={18} weight="fill" class={isPending ? "text-(--solus-accent)" : "text-(--solus-text-tertiary)"} />
    {/snippet}

    <div
      class="plan-card-body prose-cloud text-(--solus-text-primary)"
      style="max-height:10rem;overflow:hidden;font-size:0.75rem;line-height:1.6"
    >
      <SvelteMarkdown
        source={previewLines}
        renderers={{ link: MarkdownLink }}
        sanitizeUrl={markdownSanitizeUrl}
      />
      {#if hasMore}
        <div class="plan-card-fade"></div>
      {/if}
    </div>
  </ConversationRefCard>
{/if}

<style>
  .plan-card-body {
    position: relative;
    padding: 0.75rem 1rem 0.875rem;
  }

  .plan-card-placeholder {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.375rem 0.875rem 0.75rem;
    width: calc(100% - 1.75rem);
    padding: 0.625rem 0.75rem;
    border: 0.0625rem dashed var(--solus-tool-border);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-surface-primary) 30%, transparent);
    color: var(--solus-text-tertiary);
    text-align: left;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .plan-card-placeholder:hover {
    border-color: var(--solus-accent-border);
    color: var(--solus-text-secondary);
  }

  .plan-card-placeholder-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
  }
  .plan-card-placeholder:hover .plan-card-placeholder-icon {
    color: var(--solus-accent);
  }

  .plan-card-placeholder-text {
    font-size: 0.75rem;
    line-height: 1.4;
    font-weight: 550;
    color: var(--solus-accent);
  }

  .work-ref-preview {
    --work-ref-preview-bg: var(--solus-container-bg);
    position: relative;
    display: grid;
    grid-template-columns: 0.0625rem minmax(0, 1fr);
    column-gap: 0.875rem;
    max-height: 10rem;
    overflow: hidden;
    padding: 0.75rem 1rem 1rem;
    background: var(--work-ref-preview-bg);
  }

  .work-ref-preview__rule {
    align-self: stretch;
    border-radius: 999rem;
    background: var(--solus-tool-border);
  }

  .work-ref-preview__content {
    min-width: 0;
    color: var(--solus-text-primary);
    font-size: 0.8125rem;
    font-weight: 400;
    line-height: 1.6;
  }

  .work-ref-preview__content :global(h1),
  .work-ref-preview__content :global(h2),
  .work-ref-preview__content :global(h3),
  .work-ref-preview__content :global(h4),
  .work-ref-preview__content :global(strong) {
    font-weight: 500;
  }

  .work-ref-preview__fade {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 4rem;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      transparent,
      var(--work-ref-preview-bg)
    );
  }

  .plan-card-fade {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2.5rem;
    pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--solus-container-bg));
  }

  .diagram-ref-preview {
    height: 12rem;
    overflow: hidden;
  }
</style>
