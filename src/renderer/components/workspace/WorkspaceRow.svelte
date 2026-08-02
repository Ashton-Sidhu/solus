<script lang="ts">
  import { AsteriskIcon, FileTextIcon, GraphIcon, PushPinIcon, TrashIcon } from "phosphor-svelte";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import { formatLedgerTime } from "./lib/workspace-items";

  /** One ledger row — the same 46px rhythm for every artifact, pinned or not.
   *  Type is a coloured glyph, status is a word in a fixed column. */
  interface Props {
    item: WorkspaceItem;
    selected: boolean;
    compact: boolean;
    /** Set while the ledger spans more than one project — the row then names
     *  the project it came from, which is otherwise implied by the scope. */
    showProject: boolean;
    onOpen: () => void;
    onTogglePin: () => void;
    /** Absent on plans — a plan is a session artifact and has no delete. */
    onDelete?: () => void;
    onHover?: () => void;
  }

  let { item, selected, compact, showProject, onOpen, onTogglePin, onDelete, onHover }: Props =
    $props();

  const statusLabel = $derived(
    item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1) : "",
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="ledger-row"
  class:compact
  class:selected
  data-selected={selected ? "true" : null}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onOpen}
  onmouseenter={onHover}
>
  <span class="row-glyph row-glyph--{item.type}" aria-hidden="true">
    {#if item.type === "plan"}
      <AsteriskIcon size={12} weight="bold" />
    {:else if item.type === "diagram"}
      <GraphIcon size={12} />
    {:else}
      <FileTextIcon size={12} />
    {/if}
  </span>
  <span class="row-title">{item.title}</span>
  {#if !compact}
    <span class="row-snippet">{item.snippet}</span>
  {/if}
  <span class="row-fill"></span>
  <span class="row-actions" class:row-actions--pinned={item.pinned}>
    <button
      type="button"
      class="row-action"
      class:row-action--active={item.pinned}
      onclick={(e) => {
        e.stopPropagation();
        onTogglePin();
      }}
      aria-label={item.pinned ? "Unpin" : "Pin"}
      title={item.pinned ? "Unpin" : "Pin (⌥P)"}
    >
      <PushPinIcon size={12} weight={item.pinned ? "fill" : "regular"} />
    </button>
    {#if onDelete}
      <button
        type="button"
        class="row-action row-action--danger"
        onclick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label="Delete document"
        title="Delete (⌥⌫)"
      >
        <TrashIcon size={12} />
      </button>
    {/if}
  </span>
  {#if showProject}
    <span class="row-project" title={item.cwd}>{item.projectLabel}</span>
  {/if}
  <span class="row-status" class:row-status--pending={item.status === "pending"}>
    {statusLabel}
  </span>
  <span class="row-time">{formatLedgerTime(item.timestamp)}</span>
</div>

<style>
  .ledger-row {
    display: flex;
    align-items: center;
    gap: 0.6875rem;
    height: 2.875rem;
    padding: 0 0.625rem;
    margin: 0 -0.625rem;
    border-radius: 0.5625rem;
    cursor: pointer;
    user-select: none;
    transition: background 0.12s ease;
  }
  .ledger-row.compact {
    height: 2.125rem;
  }
  .ledger-row:hover {
    background: color-mix(in srgb, var(--muted) 62%, transparent);
  }
  /* Selection is a wash plus a 2px inset spine, not a border — a border would
     shift the row rhythm. */
  .ledger-row.selected {
    background: color-mix(in srgb, var(--primary) 9%, transparent);
    box-shadow: inset 0.125rem 0 0 var(--primary);
  }
  .ledger-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem color-mix(in srgb, var(--ring) 55%, transparent);
  }

  .row-glyph {
    flex: 0 0 auto;
    width: 1rem;
    height: 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .row-glyph--plan {
    color: var(--primary);
  }
  .row-glyph--doc {
    color: var(--chart-2);
  }
  .row-glyph--diagram {
    color: var(--chart-3);
  }

  .row-title {
    flex: 0 1 auto;
    min-width: 0;
    font-size: 0.8438rem;
    font-weight: 500;
    letter-spacing: -0.008em;
    color: var(--solus-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-snippet {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.7813rem;
    color: color-mix(in srgb, var(--solus-text-tertiary) 88%, transparent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-fill {
    flex: 1 1 0;
  }

  .row-actions {
    flex: 0 0 auto;
    display: flex;
    gap: 0.125rem;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .ledger-row:hover .row-actions,
  .ledger-row.selected .row-actions,
  .ledger-row:focus-within .row-actions,
  .row-actions--pinned {
    opacity: 1;
  }
  .row-action {
    width: 1.375rem;
    height: 1.375rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .row-action:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .row-action--active {
    color: var(--solus-accent);
  }
  .row-action--danger:hover {
    background: color-mix(in srgb, var(--destructive) 14%, transparent);
    color: var(--destructive);
  }

  .row-project {
    flex: 0 0 auto;
    max-width: 5.5rem;
    text-align: right;
    font-size: 0.6875rem;
    color: color-mix(in srgb, var(--solus-text-tertiary) 88%, transparent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Fixed column so dates stay in a straight line even when status is blank. */
  .row-status {
    flex: 0 0 4.5rem;
    text-align: right;
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--solus-text-tertiary) 78%, transparent);
  }
  .row-status--pending {
    font-weight: 600;
    color: var(--solus-accent);
  }
  .row-time {
    flex: 0 0 2.875rem;
    text-align: right;
    font-size: 0.7188rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
  }
</style>
