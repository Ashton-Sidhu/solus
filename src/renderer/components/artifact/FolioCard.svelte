<script lang="ts">
  import {
    CopyIcon,
    FileTextIcon,
    GraphIcon,
    PushPinIcon,
    PushPinSlashIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import type { Work } from "../../../shared/types";
  import { formatTimeAgo } from "../../lib/sessionUtils";
  import * as Card from "../ui/card";

  interface Props {
    work: Work;
    selected: boolean;
    showProject: boolean;
    onOpen: () => void;
    onTogglePin: (event: MouseEvent) => void;
    onDuplicate: (event: MouseEvent) => void;
    onDelete: () => void;
  }

  let {
    work,
    selected,
    showProject,
    onOpen,
    onTogglePin,
    onDuplicate,
    onDelete,
  }: Props = $props();

  const isDiagram = $derived(work.type === "diagram");
  const preview = $derived(isDiagram ? "" : bodyPreview(work));

  function projectShort(cwd: string): string {
    const dir = cwd?.replace(/\/$/, "");
    if (!dir || dir === "~") return "~";
    const parts = dir.split("/");
    return parts[parts.length - 1] || "~";
  }

  function bodyPreview(value: Work): string {
    const text = value.preview ?? "";
    const title = value.title.trim();
    if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
      const rest = text.slice(title.length).replace(/^[\s:–—-]+/, "").trim();
      if (rest) return rest;
    }
    return text;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<Card.Root
  class="folio-card folio-card--{work.type} gap-0 py-0"
  data-selected={selected ? "true" : null}
  onclick={onOpen}
  role="option"
  aria-selected={selected}
  tabindex="-1"
>
  <div class="card-accent"></div>

  <div class="card-body">
    <div class="card-header">
      <div class="card-meta">
        <span
          class="type-badge"
          aria-label={isDiagram ? "Diagram" : "Document"}
          title={isDiagram ? "Diagram" : "Document"}
        >
          {#if isDiagram}
            <GraphIcon size={10} weight="regular" />
          {:else}
            <FileTextIcon size={10} weight="regular" />
          {/if}
        </span>
        <span class="meta-text">{formatTimeAgo(work.updatedAt)}</span>
        {#if showProject}
          <span class="meta-sep">·</span>
          <span class="meta-text" title={work.cwd}>{projectShort(work.cwd)}</span>
        {/if}
      </div>
      <div class="folio-card__actions">
        <button
          type="button"
          class="card-icon-btn"
          class:is-active={work.pinned}
          class:always-show={work.pinned}
          onclick={onTogglePin}
          aria-label={work.pinned ? "Unpin document" : "Pin document"}
          title={work.pinned ? "Unpin" : "Pin"}
        >
          {#if work.pinned}
            <PushPinSlashIcon size={11} />
          {:else}
            <PushPinIcon size={11} />
          {/if}
        </button>
        <button
          type="button"
          class="card-icon-btn"
          onclick={onDuplicate}
          aria-label="Duplicate document"
          title="Duplicate"
        >
          <CopyIcon size={11} />
        </button>
        <button
          type="button"
          class="card-icon-btn card-icon-btn--danger"
          onclick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          aria-label="Delete document"
          title="Delete (⌥⌫)"
        >
          <TrashIcon size={11} />
        </button>
      </div>
    </div>

    <div class="folio-title">{work.title}</div>
    {#if isDiagram}
      <div class="folio-excerpt folio-excerpt--muted">Diagram</div>
    {:else if preview}
      <div class="folio-excerpt">{preview}</div>
    {:else}
      <div class="folio-excerpt folio-excerpt--muted">Empty document</div>
    {/if}
  </div>
</Card.Root>

<style>
  :global(.folio-card) {
    position: relative;
    display: flex;
    width: 100%;
    border-radius: 0.625rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid transparent;
    box-shadow:
      0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04),
      0 0.0625rem 0.125rem rgba(0, 0, 0, 0.02);
    transition:
      border-color 200ms ease,
      box-shadow 200ms ease;
    cursor: pointer;
    user-select: none;
    outline: none;
    overflow: hidden;
  }
  :global(.folio-card):hover {
    border-color: color-mix(
      in srgb,
      var(--solus-accent) 20%,
      var(--solus-container-border)
    );
    box-shadow:
      0 0.125rem 0.5rem rgba(0, 0, 0, 0.06),
      0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04);
  }
  :global(.folio-card):focus-visible {
    border-color: color-mix(
      in srgb,
      var(--solus-accent) 40%,
      var(--solus-container-border)
    );
    box-shadow:
      0 0.125rem 0.5rem rgba(0, 0, 0, 0.06),
      0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04),
      0 0 0 0.1875rem color-mix(in srgb, var(--solus-accent) 8%, transparent);
  }

  .card-accent {
    width: 0.1875rem;
    flex-shrink: 0;
    border-radius: 0.1875rem 0 0 0.1875rem;
    background: var(--card-tone, var(--solus-accent));
    opacity: 0.5;
    transition: opacity 200ms ease;
  }
  :global(.folio-card):hover .card-accent {
    opacity: 0.85;
  }
  .card-body {
    flex: 1;
    min-width: 0;
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 0;
    overflow: hidden;
    color: var(--solus-text-tertiary);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.6563rem;
  }
  .meta-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta-sep {
    flex-shrink: 0;
    opacity: 0.35;
  }
  .folio-card__actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.0625rem;
  }
  .card-icon-btn {
    display: flex;
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.3125rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    opacity: 0;
    transition:
      opacity 0.15s ease,
      background 0.15s ease,
      color 0.15s ease;
  }
  :global(.folio-card):hover .card-icon-btn,
  :global(.folio-card):focus-within .card-icon-btn {
    opacity: 1;
  }
  .card-icon-btn.always-show {
    opacity: 1;
  }
  .card-icon-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .card-icon-btn.is-active {
    color: var(--solus-accent);
  }
  .card-icon-btn--danger:hover {
    background: color-mix(
      in srgb,
      var(--solus-status-error, #e53e3e) 12%,
      transparent
    );
    color: var(--solus-status-error, #e53e3e);
  }
  :global(.folio-card--doc) {
    --card-tone: var(--solus-accent);
  }
  :global(.folio-card--diagram) {
    --card-tone: var(--solus-art-3, #5a9e6f);
  }
  .type-badge {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.3125rem;
    background: color-mix(
      in srgb,
      var(--card-tone, var(--solus-accent)) 12%,
      transparent
    );
    color: var(--card-tone, var(--solus-accent));
    box-shadow: inset 0 0 0 0.0625rem
      color-mix(in srgb, var(--card-tone, var(--solus-accent)) 18%, transparent);
  }
  .folio-title {
    display: -webkit-box;
    overflow: hidden;
    color: var(--solus-text-primary);
    font-size: 0.8125rem;
    font-weight: 550;
    letter-spacing: -0.01em;
    line-height: 1.3;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
  }
  .folio-excerpt {
    display: -webkit-box;
    overflow: hidden;
    color: var(--solus-text-tertiary);
    font-size: 0.7188rem;
    line-height: 1.5;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .folio-excerpt--muted {
    font-style: italic;
    opacity: 0.8;
  }
</style>
