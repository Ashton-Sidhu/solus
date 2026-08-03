<script lang="ts">
  import { untrack } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { PushPinIcon, TrashIcon } from "phosphor-svelte";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import { parseDiagram, summarizeDiagram } from "../../../shared/diagram-types";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { PAGE_ICON_BTN, PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { cn } from "../../lib/tw";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import PageEmpty from "../ui/PageEmpty.svelte";

  /** The peek pane: reads the selected artifact without leaving the list.
   *  Header · title · origin + age · the artifact itself, clipped · footer
   *  actions. It reads; it never edits. */
  interface Props {
    item: WorkspaceItem | null;
    onOpen: () => void;
    onTogglePin: () => void;
    onDelete?: () => void;
    onResume: () => void;
  }

  let { item, onOpen, onTogglePin, onDelete, onResume }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();

  const KIND_LABELS = { plan: "Plan", doc: "Doc", diagram: "Diagram" } as const;

  // Body content loads lazily (debounced) as the selection moves; until it
  // arrives the ledger snippet stands in for the preview.
  let loadedContent = $state<{ id: string; content: string } | null>(null);

  $effect(() => {
    const current = item;
    if (!current) return;
    if (untrack(() => loadedContent?.id) === current.id) return;
    const timer = setTimeout(() => {
      void loadContent(current);
    }, 150);
    return () => clearTimeout(timer);
  });

  async function loadContent(target: WorkspaceItem) {
    if (target.source.kind === "work") {
      const work = await session.worksStore.ensureContent(target.id, "workspace-peek");
      if (work) loadedContent = { id: target.id, content: work.content };
      return;
    }
    // Sibling revisions stay unloaded — a preview needs the plan, not the
    // revision dropdown behind it.
    await session.loadPlanContent(target.source.descriptor);
    loadedContent = { id: target.id, content: planStore.get(target.id)?.content ?? "" };
  }

  const content = $derived(item && loadedContent?.id === item.id ? loadedContent.content : null);
  const diagramSummary = $derived.by(() => {
    if (!item || item.type !== "diagram" || !content) return "";
    try {
      return summarizeDiagram(parseDiagram(content));
    } catch {
      return "";
    }
  });

  /** The ledger's own status words — the peek sits beside it and must read the
   *  same, so "pending" stays "Pending" here rather than the transcript's
   *  "Proposed". */
  const statusChip = $derived(
    item?.status === "accepted"
      ? { label: "Accepted", state: "positive" as const }
      : item?.status === "rejected"
        ? { label: "Rejected", state: "destructive" as const }
        : item?.status === "pending"
          ? { label: "Pending", state: "active" as const }
          : null,
  );

  function projectShort(cwd: string): string {
    const dir = cwd?.replace(/\/$/, "");
    if (!dir || dir === "~") return "~";
    return dir.split("/").at(-1) || "~";
  }

  const resumeLabel = $derived.by(() => {
    if (!item) return null;
    if (item.type === "plan") return "Resume session";
    const work = item.source.kind === "work" ? item.source.work : null;
    return work?.sessionIds?.length || work?.sessionId ? "Open chat" : null;
  });
</script>

<div class="peek" data-testid="workspace-peek">
  {#if item}
    <div class="peek-header">
      <span class="peek-kind">{KIND_LABELS[item.type]}</span>
      {#if statusChip}
        <TranscriptChip state={statusChip.state}>{statusChip.label}</TranscriptChip>
      {/if}
      <span class="peek-fill"></span>
      <button
        type="button"
        class={cn(PAGE_ICON_BTN, item.pinned && "text-(--solus-accent)")}
        onclick={onTogglePin}
        aria-label={item.pinned ? "Unpin" : "Pin"}
        title={item.pinned ? "Unpin" : "Pin (⌥P)"}
      >
        <PushPinIcon size={13} weight={item.pinned ? "fill" : "regular"} />
      </button>
      {#if onDelete}
        <button
          type="button"
          class={cn(
            PAGE_ICON_BTN,
            "[&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] [&:hover:not(:disabled)]:text-(--destructive)",
          )}
          onclick={onDelete}
          aria-label="Delete document"
          title="Delete (⌥⌫)"
        >
          <TrashIcon size={13} />
        </button>
      {/if}
    </div>

    <div class="peek-title">{item.title}</div>
    <div class="peek-meta">
      <span title={item.cwd}>{projectShort(item.cwd)}</span>
      <span class="peek-meta-sep">·</span>
      <span>{formatTimeAgoFromTimestamp(item.timestamp) ?? ""}</span>
    </div>

    <!-- The artifact itself, clipped at the pane and faded out: a peek is a
         reference to a page, not the page. -->
    <div class="peek-body" class:peek-body--canvas={item.type === "diagram"}>
      {#if item.type === "diagram"}
        <!-- A framed window onto the canvas: the thumbnail draws its own
             backdrop and centres the map, so it wants a box to fill, not a
             strip to be cropped by. -->
        <div class="peek-canvas">
          {#if content}
            {#await import("../diagram/DiagramThumbnail.svelte")}
              <div class="peek-canvas-pending" role="status" aria-label="Loading diagram preview"></div>
            {:then thumbModule}
              {@const DiagramThumbnail = thumbModule.default}
              <DiagramThumbnail {content} />
            {/await}
          {:else}
            <div class="peek-canvas-pending" role="status" aria-label="Loading diagram preview"></div>
          {/if}
        </div>
        {#if diagramSummary}
          <div class="peek-caption">{diagramSummary}</div>
        {/if}
      {:else if content}
        <!-- The doc shell's own DOM, so the preview inherits the document
             face rather than a second prose style: root › column › editor ›
             ProseMirror is exactly what every rule in index.css is written
             against. `doc-peek` rescales it for the column. -->
        <div class="doc-shell-root doc-peek">
          <div class="doc-shell-column solus-doc-editor">
            <div class="ProseMirror">
              <SvelteMarkdown
                source={content}
                renderers={{ ...githubMarkdownRenderers, link: MarkdownLink }}
                sanitizeUrl={markdownSanitizeUrl}
              />
            </div>
          </div>
        </div>
        <div class="peek-body-fade" aria-hidden="true"></div>
      {:else if item.snippet}
        <div class="peek-snippet">{item.snippet}</div>
      {/if}
    </div>

    <div class="peek-actions">
      <button type="button" class={cn(PAGE_PRIMARY_BTN, "flex-1 justify-center")} onclick={onOpen}>
        Open
      </button>
      {#if resumeLabel}
        <button type="button" class={PAGE_SECONDARY_BTN} onclick={onResume}>{resumeLabel}</button>
      {/if}
    </div>
  {:else}
    <PageEmpty compact>Select an item to preview it here.</PageEmpty>
  {/if}
</div>

<style>
  .peek {
    flex: 0 0 21.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.6875rem;
    padding: 1.25rem 1.25rem 1.125rem;
    border-left: 0.0625rem solid color-mix(in srgb, var(--solus-container-border) 55%, transparent);
    background: color-mix(in srgb, var(--muted) 28%, var(--solus-container-bg));
    overflow: hidden;
  }

  .peek-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .peek-kind {
    font-size: 0.6563rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--solus-text-tertiary);
  }
  .peek-fill {
    flex: 1 1 auto;
  }

  .peek-title {
    font-size: 1.0625rem;
    font-weight: 640;
    letter-spacing: -0.024em;
    line-height: 1.28;
    color: var(--solus-text-primary);
    overflow-wrap: break-word;
  }
  .peek-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.7188rem;
    color: var(--solus-text-tertiary);
  }
  .peek-meta-sep {
    opacity: 0.4;
  }

  .peek-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  /* The pane's own background, not the transcript card's — the gradient has to
     land on what is actually behind it or it reads as a grey band. */
  .peek-body-fade {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    height: 3rem;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--muted) 28%, var(--solus-container-bg))
    );
  }
  .peek-snippet {
    font-size: 0.7813rem;
    line-height: 1.6;
    color: var(--solus-text-tertiary);
    text-wrap: pretty;
  }

  .peek-body--canvas {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  /* The frame is what makes it read as a rendered canvas rather than loose
     artwork on the pane wash. The thumbnail sizes itself to this box and
     centres the map inside it, so no svg overrides here.

     Landscape, and explicitly not `flex: 1`: an architecture diagram is wide,
     and letting the frame stretch down the column fits that wide drawing into
     a tall box — which shrinks it to a sliver with dead canvas above and
     below. The frame takes the diagram's shape and gives the rest of the
     column back. */
  .peek-canvas {
    flex: 0 0 auto;
    aspect-ratio: 3 / 2;
    border-radius: 0.625rem;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-container-border) 70%, transparent);
    overflow: hidden;
  }
  .peek-canvas-pending {
    width: 100%;
    height: 100%;
    background: color-mix(in srgb, var(--solus-surface-primary) 28%, var(--solus-container-bg));
    animation: peek-canvas-breathe 1.6s ease-in-out infinite;
  }
  @keyframes peek-canvas-breathe {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .peek-canvas-pending {
      animation: none;
      opacity: 0.7;
    }
  }
  .peek-caption {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--solus-text-tertiary);
  }

  .peek-actions {
    flex-shrink: 0;
    display: flex;
    gap: 0.5rem;
  }
</style>
