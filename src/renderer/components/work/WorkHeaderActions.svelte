<script lang="ts">
  import {
    CheckIcon,
    CopyIcon,
    ArrowSquareOutIcon,
    CaretDownIcon,
    ArrowCounterClockwiseIcon,
    DownloadSimpleIcon,
    FolderIcon,
    PencilSimpleIcon,
    SparkleIcon,
    TrashIcon,
    XIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import WorkChatMenu from "./WorkChatMenu.svelte";
  import Diff from "../diff/Diff.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import Kbd from "../ui/Kbd.svelte";
  import { portal } from "../portal";
  import { getWorkspaceContext, connectionsStore } from "../../contexts";
  import type { SessionMeta, WorkStorage } from "../../../shared/types";
  import { serverConnections } from "@client-core/server-connections";

  interface Props {
    onOpenChat?: (mode: "resume" | "new") => void;
    /** Flips the surface's toolbar row into its rename input. */
    onStartRename?: () => void;
    originalSessionMeta?: SessionMeta | null;
    copied: boolean;
    copy: () => void;
    /** When set, surfaces a "View changes" pill diffing the agent's last edit. */
    workId?: string;
    title?: string;
    currentContent?: string;
    getCurrentContent?: () => string;
    /** Work kind — gates the Download .md action (docs/slides only). */
    docType?: "doc" | "slides" | "diagram";
    /** Restore the previous snapshot. When set, the diff modal shows "Restore". */
    onRevert?: () => void;
    /** Delete the work (closes the pane + offers undo). When set, shows a Delete pill. */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    onSaveToProject?: (content: string) => void | Promise<void>;
    /** Upload to Google Docs (provided by the shell when it has the binding). */
    onGoogleUpload?: () => void;
    uploading?: boolean;
    uploaded?: boolean;
  }

  let {
    onOpenChat,
    onStartRename,
    originalSessionMeta,
    copied,
    copy,
    workId,
    title = "Work",
    currentContent = "",
    getCurrentContent,
    docType,
    onRevert,
    onDelete,
    onDuplicate,
    workStorage,
    onSaveToProject,
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
  const canSaveToProject = $derived(!!onSaveToProject);

  function resolvedContent() {
    return getCurrentContent?.() ?? currentContent;
  }

  function safeFileName() {
    return (title || "document").replace(/[^\w.\- ]+/g, "_").trim() || "document";
  }

  function downloadMarkdown() {
    const blob = new Blob([resolvedContent()], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFileName()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportToFile() {
    if (!connectionsStore.desktopHandlersAvailable) return;
    // Export targets the user's client-side file picker, not the work's owner host.
    await serverConnections.localHostApi()?.saveFileDialog(`${safeFileName()}.md`, resolvedContent());
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
    const contentKey = currentContent; // re-run when persisted content advances
    if (!id) return;
    const cwd = workStorage?.kind === "project" ? workStorage.projectRoot : undefined;
    void session.worksStore.loadPrevious(id, cwd, contentKey);
  });

  const hasChanges = $derived(!!previous && previous.content !== currentContent);
  const hasOverflow = $derived(
    !!onStartRename || !!onGoogleUpload || canSaveToProject || !!onDuplicate || canDownload || !!onDelete,
  );
</script>

<!-- The header's own verbs are unfilled type. The only filled surface in the
     cluster is the way to reach Solus, so the eye finds it first. -->
<div class="wha-actions">
<!-- History: the document's previous version, persistent rather than buried in
     the overflow — it is one of the four things the header always keeps. -->
{#if hasChanges}
  <button type="button" class="wha-verb" data-testid="view-changes" onclick={() => (showDiff = true)} title="See what the agent changed">
    History
  </button>
{/if}

<!-- Copy stays inline: the most-used action. -->
<button type="button" class="wha-verb" onclick={copy} title="Copy to clipboard" aria-label="Copy to clipboard">
  {copied ? "Copied!" : "Copy"}
</button>

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
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} class="w-auto min-w-56 whitespace-nowrap">
      <DropdownMenu.Label>Document actions</DropdownMenu.Label>
      {#if onStartRename}
        <DropdownMenu.Item data-testid="rename-work" onSelect={() => onStartRename?.()}>
          <PencilSimpleIcon size={14} /><span class="flex-1 text-left">Rename</span>
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
      {#if canSaveToProject}
        <DropdownMenu.Item data-testid="save-work-to-project" onSelect={() => onSaveToProject?.(resolvedContent())}>
          <FolderIcon size={14} /><span class="flex-1 text-left">Save to project…</span>
        </DropdownMenu.Item>
      {/if}
      {#if (onStartRename || onGoogleUpload || canSaveToProject) && (onDuplicate || canDownload || onDelete)}
        <DropdownMenu.Separator />
      {/if}
      {#if onDuplicate}
        <DropdownMenu.Item data-testid="duplicate-work" onSelect={() => onDuplicate?.()}>
          <CopyIcon size={14} /><span class="flex-1 text-left">Duplicate</span>
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
          <DropdownMenu.Separator />
        {/if}
        <DropdownMenu.Item data-testid="delete-work" variant="destructive" onSelect={() => onDelete?.()}>
          <TrashIcon size={14} /><span class="flex-1 text-left">Delete</span>
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<!-- How to reach Solus — the one filled surface in the header, and a pill so it
     is the only rounded-full thing on the page. -->
{#if onOpenChat}
  <div class="relative wha-solus" bind:this={chatButtonEl}>
    <button
      type="button"
      onclick={() => onOpenChat("resume")}
      class="wha-solus-trigger"
      data-testid="open-chat"
      title="Ask Solus about this document"
      aria-label="Ask Solus"
    >
      <SparkleIcon size={12} weight="fill" />
      <span class="wha-label">Ask Solus</span>
    </button>
    <button
      type="button"
      onclick={() => (chatMenuOpen = !chatMenuOpen)}
      class="wha-solus-caret"
      class:wha-solus-caret--open={chatMenuOpen}
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
          newFile={{ name: title, contents: resolvedContent() }}
        />
      </div>
    </div>
  </div>
{/if}

<style>
  /* A header verb: unfilled type at the same metrics as the shell's own
     (Markdown/Editor) buttons, so the whole cluster reads as one row of words
     with a single filled pill at the end of it. */
  .wha-verb {
    flex-shrink: 0;
    height: 1.75rem;
    padding: 0 0.625rem;
    border-radius: 0.4375rem;
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--solus-text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .wha-verb:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .wha-verb:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }

  /* Reaching Solus is the surface's primary action, so it carries the only
     filled surface in the cluster — and the only pill. */
  .wha-solus {
    display: inline-flex;
    align-items: stretch;
    height: 1.75rem;
    margin-left: 0.3125rem;
    border-radius: 9999px;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    overflow: hidden;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .wha-solus:hover,
  .wha-solus:has(.wha-solus-caret--open) {
    background: color-mix(in srgb, var(--solus-accent) 88%, black);
  }
  .wha-solus-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    padding: 0 0.4375rem 0 0.6875rem;
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: 500;
    background: transparent;
    color: inherit;
    border: none;
    cursor: pointer;
    white-space: nowrap;
  }
  .wha-solus-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    padding: 0;
    background: transparent;
    color: inherit;
    border: none;
    border-left: 0.0625rem solid color-mix(in srgb, var(--solus-text-on-accent) 28%, transparent);
    cursor: pointer;
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  .wha-solus-caret--open {
    transform: rotate(180deg);
  }
  .wha-solus-trigger:focus-visible,
  .wha-solus-caret:focus-visible {
    outline: 0.125rem solid var(--solus-text-on-accent);
    outline-offset: -0.125rem;
  }
  /* Overflow (⋯) trigger — a verb like the rest, so it stays unfilled until hover. */
  .wha-overflow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    border: none;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  .wha-overflow:hover,
  .wha-overflow--open {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .wha-overflow:active {
    transform: scale(0.96);
  }
  .wha-overflow:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .wha-actions {
    display: contents;
  }
  @media (max-width: 767px) {
    .wha-label {
      display: none;
    }
    .wha-solus-trigger {
      padding: 0 0.4375rem 0 0.5rem;
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
    font-size: var(--text-sm);
    font-weight: 500;
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
    font-size: var(--text-xs);
    font-weight: 500;
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
