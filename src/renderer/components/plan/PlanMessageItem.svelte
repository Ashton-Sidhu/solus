<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import {
    ArrowLineRightIcon,
    FileTextIcon,
    GraphIcon,
    ClipboardTextIcon,
    CheckCircleIcon,
    XCircleIcon,
  } from "phosphor-svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
  import PlanActionBar from "./PlanActionBar.svelte";
  import WorkGeneratingSkeleton from "../work/WorkGeneratingSkeleton.svelte";
  import { summarizeDiagram, parseDiagram } from "../../../shared/diagram-types";
  import type { PlanMessageRef } from "../../../shared/types";

  interface Props {
    ref: PlanMessageRef;
    skipMotion?: boolean;
  }
  let { ref, skipMotion = false }: Props = $props();

  const theme = getSettingsContext();
  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const isEditorMode = $derived(windowCtx.viewMode === "editor");
  const content = $derived(ref.content || "");
  const comments = $derived(ref.comments || []);
  const planStatus = $derived(ref.status ?? "pending");
  const isPending = $derived(planStatus === "pending");
  const previewLines = $derived(content.split("\n").slice(0, 8).join("\n"));
  const hasMore = $derived(content.split("\n").length > 8);

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
    ref.content ? ref.content.split("\n").slice(0, 24).join("\n") : null,
  );

  const isDiagram = $derived(ref.workType === "diagram");
  const isStreaming = $derived(ref.streaming ?? false);
  const diagramSummary = $derived(
    isDiagram && ref.content
      ? (() => { try { return summarizeDiagram(parseDiagram(ref.content!)) } catch { return "" } })()
      : "",
  );

  function openWork() {
    void session.openWorkModal(ref.id!, ref.title);
  }

  function popWorkToSide(e: MouseEvent) {
    e.stopPropagation();
    session.artifactViewer.moveToSecondary({ kind: "work", workId: ref.id! });
  }

  function openPlan() {
    if (ref.id) void session.openPlanModal(ref.id);
  }

  // Pop the plan into the secondary pane beside the conversation, mirroring the
  // work/diagram cards' "pop out to side". Routed through openPlanModal so the
  // plan is loaded/hydrated before the pane renders it.
  function popPlanToSide(e: MouseEvent) {
    e.stopPropagation();
    if (ref.id) void session.openPlanModal(ref.id, undefined, { secondary: true });
  }
</script>

{#if ref.kind === "document" && isStreaming}
  <WorkGeneratingSkeleton workType={ref.workType} />
{:else if ref.kind === "document" && isDiagram}
  <ConversationRefCard
    title={ref.title ?? "Untitled diagram"}
    subtitle={diagramSummary || "Diagram"}
    ariaLabel={`Open diagram: ${ref.title ?? "Untitled diagram"}`}
    onOpen={openWork}
    data-testid="diagram-card"
    {skipMotion}
  >
    {#snippet icon()}
      <GraphIcon size={18} />
    {/snippet}

    {#snippet actions()}
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onclick={popWorkToSide}
          class="plan-icon-btn"
          title="Pop out to side"
          aria-label="Pop out to side"
        >
          <ArrowLineRightIcon size={14} />
        </button>
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            openWork();
          }}
          class="shrink-0 cursor-pointer rounded-lg border border-(--solus-tool-border) bg-transparent px-3 py-1.5 text-xs font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
        >
          Open
        </button>
      </div>
    {/snippet}
  </ConversationRefCard>
{:else if ref.kind === "document"}
  <ConversationRefCard
    title={ref.title ?? "Untitled document"}
    subtitle={ref.workType === "slides" ? "Slide deck" : "Document"}
    ariaLabel={`Open document: ${ref.title ?? "Untitled document"}`}
    onOpen={openWork}
    data-testid="document-card"
    {skipMotion}
  >
    {#snippet icon()}
      <FileTextIcon size={18} weight="duotone" class="text-(--solus-accent)" />
    {/snippet}

    {#snippet actions()}
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onclick={popWorkToSide}
          class="plan-icon-btn"
          title="Pop out to side"
          aria-label="Pop out to side"
        >
          <ArrowLineRightIcon size={14} />
        </button>
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            openWork();
          }}
          class="shrink-0 cursor-pointer rounded-lg border border-(--solus-tool-border) bg-transparent px-3 py-1.5 text-xs font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
        >
          Open
        </button>
      </div>
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
    title={statusMeta.label}
    subtitle={comments.length > 0 ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : undefined}
    ariaLabel={ref.id ? `Open ${statusMeta.label.toLowerCase()}` : statusMeta.label}
    onOpen={openPlan}
    data-testid="plan-card"
    {skipMotion}
  >
    {#snippet icon()}
      <StatusIcon size={18} weight="fill" class={isPending ? "text-(--solus-accent)" : "text-(--solus-text-tertiary)"} />
    {/snippet}

    {#snippet actions()}
      {#if ref.id}
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onclick={popPlanToSide}
            class="plan-icon-btn"
            title="Pop out to side"
            aria-label="Pop out to side"
          >
            <ArrowLineRightIcon size={14} />
          </button>
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              openPlan();
            }}
            class="shrink-0 cursor-pointer rounded-lg border border-(--solus-tool-border) bg-transparent px-3 py-1.5 text-xs font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
          >
            Open
          </button>
        </div>
      {/if}
    {/snippet}

    <div
      class="plan-card-body prose-cloud text-(--solus-text-primary)"
      style="max-height:12.5rem;overflow:hidden;font-size:0.75rem;line-height:1.6"
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

    {#if ref.id && isPending}
      <div class="plan-card-actions">
        <PlanActionBar
          planId={ref.id}
          inlineCommentCount={comments.length}
          compact={!isEditorMode}
        />
      </div>
    {/if}
  </ConversationRefCard>
{/if}

<style>
  .plan-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    border-radius: 0.4375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  .plan-icon-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
  }
  .plan-icon-btn:active {
    transform: scale(0.96);
  }
  .plan-icon-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  .plan-card-body {
    position: relative;
    padding: 0.75rem 0.875rem;
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
    grid-template-columns: 0.125rem minmax(0, 1fr);
    column-gap: 0.875rem;
    max-height: 12rem;
    overflow: hidden;
    padding: 0.875rem 1rem 1rem;
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

  .plan-card-actions {
    padding: 0.5rem 0.875rem 0.625rem;
    border-top: 0.0625rem solid var(--solus-accent-border);
  }
</style>
