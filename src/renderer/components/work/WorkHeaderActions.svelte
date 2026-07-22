<script lang="ts">
  import {
    CheckIcon,
    CopyIcon,
    ArrowSquareOutIcon,
    ArrowsOutSimpleIcon,
    ChatCircleIcon,
    CaretDownIcon,
    ClockCounterClockwiseIcon,
    ArrowCounterClockwiseIcon,
    DownloadSimpleIcon,
    FolderIcon,
    TrashIcon,
    XIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import SoftPill from "../ui/SoftPill.svelte";
  import WorkChatMenu from "./WorkChatMenu.svelte";
  import Diff from "../diff/Diff.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import Kbd from "../ui/Kbd.svelte";
  import { portal } from "../portal";
  import type { PaneSlot } from "../../contexts/workspace/pane-view.store.svelte";
  import { getWorkspaceContext, connectionsStore } from "../../contexts";
  import type { SessionMeta, WorkStorage } from "../../../shared/types";

  interface Props {
    /** Inline (in a pane) vs floating modal — only inline shows Open-in-split. */
    inline?: boolean;
    /** Named `paneSlot` (not `slot`) — `slot` is reserved as a component attribute. */
    paneSlot?: PaneSlot;
    /** Hide button labels while preserving titles/aria labels for split-pane density. */
    iconOnly?: boolean;
    onOpenInSplit?: () => void;
    onOpenChat?: (mode: "resume" | "new") => void;
    originalSessionMeta?: SessionMeta | null;
    copied: boolean;
    copy: () => void;
    /** When set, surfaces a "View changes" pill diffing the agent's last edit. */
    workId?: string;
    title?: string;
    currentContent?: string;
    /** Work kind — gates the Download .md action (docs/slides only). */
    docType?: "doc" | "slides" | "diagram";
    /** Restore the previous snapshot. When set, the diff modal shows "Restore". */
    onRevert?: () => void;
    /** Delete the work (closes the pane + offers undo). When set, shows a Delete pill. */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    onPromoteToProject?: () => void | Promise<void>;
    promoting?: boolean;
    /** Upload to Google Docs (provided by the shell when it has the binding). */
    onGoogleUpload?: () => void;
    uploading?: boolean;
    uploaded?: boolean;
  }

  let {
    inline = false,
    paneSlot = "primary",
    iconOnly = false,
    onOpenInSplit,
    onOpenChat,
    originalSessionMeta,
    copied,
    copy,
    workId,
    title = "Work",
    currentContent = "",
    docType,
    onRevert,
    onDelete,
    onDuplicate,
    workStorage,
    onPromoteToProject,
    promoting = false,
    onGoogleUpload,
    uploading = false,
    uploaded = false,
  }: Props = $props();

  const session = getWorkspaceContext();

  let chatMenuOpen = $state(false);
  let chatButtonEl: HTMLDivElement | null = $state(null);

  // Overflow (⋯) menu holding the secondary / destructive actions.
  let overflowOpen = $state(false);

  const canDownload = $derived(docType === "doc" || docType === "slides");
  const canExportToFile = $derived(canDownload && connectionsStore.desktopHandlersAvailable);
  const showOpenInSplit = $derived(inline && !!onOpenInSplit);
  const isProjectWork = $derived(workStorage?.kind === "project");
  const canPromote = $derived(!isProjectWork && !!onPromoteToProject);

  function safeFileName() {
    return (title || "document").replace(/[^\w.\- ]+/g, "_").trim() || "document";
  }

  function downloadMarkdown() {
    const blob = new Blob([currentContent], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFileName()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportToFile() {
    if (!connectionsStore.desktopHandlersAvailable) return;
    await window.solus.saveFileDialog(`${safeFileName()}.md`, currentContent);
  }

  function handleRestore() {
    onRevert?.();
    showDiff = false;
  }

  // "View changes": the single previous version snapshotted on agent saves.
  const previous = $derived(workId ? (session.worksStore.previousSnapshots[workId] ?? null) : null);
  let showDiff = $state(false);

  // Reload the snapshot when the work changes or its content advances (an agent
  // save both writes a new snapshot and bumps the store content we read here).
  $effect(() => {
    const id = workId;
    const contentKey = currentContent; // re-run when content advances
    if (!id) return;
    const cwd = workStorage?.kind === "project" ? workStorage.projectRoot : undefined;
    void session.worksStore.loadPrevious(id, cwd, contentKey);
  });

  const hasChanges = $derived(!!previous && previous.content !== currentContent);
  const hasOverflow = $derived(
    showOpenInSplit || !!onGoogleUpload || canPromote || isProjectWork || !!onDuplicate || hasChanges || canDownload || !!onDelete,
  );
</script>

<div class="wha-actions" class:wha-actions--icon-only={iconOnly}>
{#if onOpenChat}
  <div class="relative wha-chat-split" bind:this={chatButtonEl}>
    <button
      type="button"
      onclick={() => onOpenChat("resume")}
      class="wha-chat-trigger"
      data-testid="open-chat"
      title="Resume chat"
      aria-label="Resume chat"
    >
      <ChatCircleIcon size={13} />
      <span class="wha-label">Chat</span>
    </button>
    <button
      type="button"
      onclick={() => (chatMenuOpen = !chatMenuOpen)}
      class="wha-chat-caret"
      class:wha-chat-caret--open={chatMenuOpen}
      data-testid="open-chat-menu"
      title="Choose chat mode"
      aria-label="Choose chat mode"
      aria-haspopup="menu"
      aria-expanded={chatMenuOpen}
    >
      <CaretDownIcon size={10} weight="bold" />
    </button>
    <WorkChatMenu
      bind:open={chatMenuOpen}
      triggerEl={chatButtonEl}
      onResume={() => onOpenChat("resume")}
      onNew={() => onOpenChat("new")}
      {originalSessionMeta}
    />
  </div>
{/if}

<!-- Copy stays inline: the most-used action. -->
<SoftPill onclick={copy} variant={copied ? "active" : "default"} title="Copy to clipboard" ariaLabel="Copy to clipboard">
  {#if copied}
    <CheckIcon size={13} />
    <span class="wha-label">Copied!</span>
  {:else}
    <CopyIcon size={13} />
    <span class="wha-label">Copy</span>
  {/if}
</SoftPill>

<!-- Layout, integration & destructive actions collapse into a single overflow menu. -->
{#if hasOverflow}
  <DropdownMenu.Root bind:open={overflowOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button {...props} type="button" class="wha-overflow" class:wha-overflow--open={overflowOpen} data-testid="work-actions-menu" title="More actions" aria-label="More actions">
          <DotsThreeIcon size={16} weight="bold" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="end" sideOffset={6} class="w-[200px]">
      {#if showOpenInSplit}
        <DropdownMenu.Item data-testid="open-in-split" onSelect={() => onOpenInSplit?.()}>
          {#if paneSlot === "secondary"}
            <ArrowsOutSimpleIcon size={14} /><span class="flex-1 text-left">Focus</span>
          {:else}
            <ArrowSquareOutIcon size={14} /><span class="flex-1 text-left">Open in split</span>
          {/if}
        </DropdownMenu.Item>
      {/if}
      {#if onGoogleUpload}
        <!-- Keep the menu open so the upload state stays visible. -->
        <DropdownMenu.Item data-testid="google-upload" disabled={uploading} closeOnSelect={false} onSelect={() => onGoogleUpload?.()}>
          {#if uploaded}
            <CheckIcon size={14} /><span class="flex-1 text-left">Opened!</span>
          {:else}
            <ArrowSquareOutIcon size={14} /><span class="flex-1 text-left">{uploading ? "Uploading…" : "Open in Google Docs"}</span>
          {/if}
          <span class="ml-auto"><Kbd variant="inline">⌥G</Kbd></span>
        </DropdownMenu.Item>
      {/if}
      {#if canPromote}
        <DropdownMenu.Item data-testid="promote-work" disabled={promoting} onSelect={() => onPromoteToProject?.()}>
          <FolderIcon size={14} /><span class="flex-1 text-left">{promoting ? "Saving…" : "Save to project"}</span>
        </DropdownMenu.Item>
      {:else if isProjectWork}
        <DropdownMenu.Item data-testid="project-work-location" disabled>
          <FolderIcon size={14} /><span class="flex-1 text-left">Saved in project</span>
        </DropdownMenu.Item>
      {/if}
      {#if (showOpenInSplit || onGoogleUpload || canPromote || isProjectWork) && (onDuplicate || hasChanges || canDownload || onDelete)}
        <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
      {/if}
      {#if onDuplicate}
        <DropdownMenu.Item data-testid="duplicate-work" onSelect={() => onDuplicate?.()}>
          <CopyIcon size={14} /><span class="flex-1 text-left">Duplicate</span>
        </DropdownMenu.Item>
      {/if}
      {#if hasChanges}
        <DropdownMenu.Item data-testid="view-changes" onSelect={() => { showDiff = true; }}>
          <ClockCounterClockwiseIcon size={14} /><span class="flex-1 text-left">View changes</span>
        </DropdownMenu.Item>
      {/if}
      {#if canDownload}
        <DropdownMenu.Item data-testid="download-markdown" onSelect={downloadMarkdown}>
          <DownloadSimpleIcon size={14} /><span class="flex-1 text-left">Download .md</span>
        </DropdownMenu.Item>
        {#if canExportToFile}
          <DropdownMenu.Item data-testid="export-markdown" onSelect={() => { void exportToFile(); }}>
            <DownloadSimpleIcon size={14} /><span class="flex-1 text-left">Export to file…</span>
          </DropdownMenu.Item>
        {/if}
      {/if}
      {#if onDelete}
        {#if onDuplicate || hasChanges || canDownload}
          <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
        {/if}
        <DropdownMenu.Item data-testid="delete-work" variant="destructive" onSelect={() => onDelete?.()}>
          <TrashIcon size={14} /><span class="flex-1 text-left">Delete</span>
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
</div>

{#if showDiff && previous}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal={document.body}
    data-solus-ui
    class="wha-diff-backdrop"
    onclick={(e) => { if (e.target === e.currentTarget) showDiff = false; }}
    role="presentation"
  >
    <div class="wha-diff-panel">
      <div class="wha-diff-header">
        <span class="wha-diff-title">Changes to “{title}”</span>
        <div class="wha-diff-header__actions">
          {#if onRevert}
            <button type="button" class="wha-restore-btn" data-testid="restore-version" onclick={handleRestore} title="Restore the previous version">
              <ArrowCounterClockwiseIcon size={13} weight="bold" />
              Restore this version
            </button>
          {/if}
          <button type="button" class="wha-diff-close" onclick={() => (showDiff = false)} title="Close" aria-label="Close changes">
            <XIcon size={16} />
          </button>
        </div>
      </div>
      <div class="wha-diff-body">
        <Diff
          oldFile={{ name: title, contents: previous.content }}
          newFile={{ name: title, contents: currentContent }}
        />
      </div>
    </div>
  </div>
{/if}

<style>
  .wha-chat-split {
    display: inline-flex;
    align-items: stretch;
    border-radius: 0.4375rem;
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
    overflow: hidden;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .wha-chat-split:hover,
  .wha-chat-split:has(.wha-chat-caret--open) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .wha-chat-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.375rem 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    background: transparent;
    color: inherit;
    border: none;
    cursor: pointer;
  }
  .wha-chat-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    padding: 0;
    background: transparent;
    color: var(--solus-text-tertiary);
    border: none;
    border-left: 0.0625rem solid color-mix(in srgb, var(--solus-text-tertiary) 18%, transparent);
    cursor: pointer;
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  .wha-chat-caret--open {
    transform: rotate(180deg);
  }
  .wha-chat-trigger:focus-visible,
  .wha-chat-caret:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: -0.0625rem;
  }
  /* [ui.sh picker] Overflow (⋯) trigger — same surface language as the soft pills. */
  .wha-overflow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    border-radius: 0.4375rem;
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
    border: none;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  :global(.dark) .wha-overflow {
    background: color-mix(in srgb, var(--solus-surface-hover) 80%, transparent);
  }
  .wha-overflow:hover,
  .wha-overflow--open {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .wha-overflow:active {
    transform: scale(0.95);
  }
  .wha-overflow:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .wha-actions {
    display: contents;
  }
  .wha-actions :global(.soft-pill) {
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
  }
  .wha-actions--icon-only .wha-label {
    display: none;
  }
  .wha-actions--icon-only .wha-chat-trigger {
    padding-inline: 0.25rem;
  }
  .wha-actions--icon-only :global(.soft-pill) {
    padding-inline: 0.25rem;
  }
  @media (max-width: 767px) {
    .wha-label {
      display: none;
    }
  }

  .wha-diff-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--solus-modal-scrim);
    backdrop-filter: blur(0.5rem) saturate(1.05);
    -webkit-backdrop-filter: blur(0.5rem) saturate(1.05);
  }
  .wha-diff-panel {
    display: flex;
    flex-direction: column;
    width: min(64rem, 92vw);
    height: min(80vh, 88vh);
    border-radius: 1rem;
    overflow: hidden;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-tool-border);
    box-shadow: var(--solus-popover-shadow);
  }
  .wha-diff-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    border-bottom: 0.0625rem solid var(--solus-tool-border);
    flex-shrink: 0;
  }
  .wha-diff-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--solus-text-primary);
  }
  .wha-diff-header__actions {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .wha-restore-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.625rem;
    border-radius: 0.4375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--solus-accent);
    background: var(--solus-accent-light);
    border: 0.0625rem solid var(--solus-accent-border);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .wha-restore-btn:hover {
    background: color-mix(in srgb, var(--solus-accent-light) 100%, var(--solus-accent) 12%);
  }
  .wha-restore-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }

  .wha-diff-close {
    width: 1.625rem;
    height: 1.625rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    border: none;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .wha-diff-close:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .wha-diff-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0.75rem 1rem;
  }
</style>
