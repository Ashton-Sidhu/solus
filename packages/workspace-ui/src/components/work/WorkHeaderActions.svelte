<script lang="ts">
  import {
    Check as CheckIcon,
    Copy as CopyIcon,
    ExternalLink as ArrowSquareOutIcon,
    ChevronDown as CaretDownIcon,
    RotateCcw as ArrowCounterClockwiseIcon,
    Download as DownloadSimpleIcon,
    Folder as FolderIcon,
    Pen as PencilSimpleIcon,
    Sparkles as SparkleIcon,
    Trash2 as TrashIcon,
    X as XIcon,
    Ellipsis as DotsThreeIcon,
  } from "@lucide/svelte";
  import WorkChatMenu from "./WorkChatMenu.svelte";
  import Diff from "../diff/Diff.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import Kbd from "../ui/Kbd.svelte";
  import { portal } from "../portal";
  import { getWorkspaceContext } from "../../contexts";
  import type { SessionMeta, WorkStorage } from "@solus/contracts/types";
  import { exportFileName } from "../pickers/lib/export-file-name";
  import {
    downloadPayload,
    type WorkCopyFormat,
    type WorkExportFormat,
    type WorkExportRequest,
  } from "./lib/work-export";
  import { toasts } from "../../lib/toasts";

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
    /** Every file the shell can write this work out as, in menu order. */
    exportFormats?: WorkExportFormat[];
    /** Clipboard variants beyond the inline Copy verb. */
    copyFormats?: WorkCopyFormat[];
    /**
     * Opens the save picker on the chosen format. Absent when the work has no
     * host to write to, which also hides the Save group.
     */
    onExport?: (request: WorkExportRequest) => void;
    /**
     * True when the picker's filesystem is not this device's — the only case
     * where a browser download is a different outcome from saving.
     */
    hostIsRemote?: boolean;
    /** Restore the previous snapshot. When set, the diff modal shows "Restore". */
    onRevert?: () => void;
    /** Delete the work (closes the pane + offers undo). When set, shows a Delete pill. */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
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
    exportFormats = [],
    copyFormats = [],
    onExport,
    hostIsRemote = false,
    onRevert,
    onDelete,
    onDuplicate,
    workStorage,
    onGoogleUpload,
    uploading = false,
    uploaded = false,
  }: Props = $props();

  const session = getWorkspaceContext();

  let chatMenuOpen = $state(false);
  let chatButtonEl: HTMLDivElement | null = $state(null);

  // Overflow (⋯) menu holding the secondary / destructive actions.
  let overflowOpen = $state(false);

  const canSave = $derived(!!onExport && exportFormats.length > 0);
  // On desktop-local the picker writes to this very machine, so a download
  // beside it would be two names for one outcome.
  const canDownload = $derived(hostIsRemote && exportFormats.length > 0);

  function resolvedContent() {
    return getCurrentContent?.() ?? currentContent;
  }

  async function encode(format: WorkExportFormat) {
    try {
      const payload = await format.produce();
      // An empty diagram encodes to nothing; silence would be indistinguishable
      // from a save that quietly failed.
      if (!payload) toasts.info("Nothing to export — this work is empty");
      return payload;
    } catch {
      toasts.error(`Couldn't build the ${format.label} file`);
      return null;
    }
  }

  async function save(format: WorkExportFormat) {
    const payload = await encode(format);
    if (!payload) return;
    onExport?.({ fileName: exportFileName(title, format.extension), payload });
  }

  async function download(format: WorkExportFormat) {
    const payload = await encode(format);
    if (!payload) return;
    downloadPayload(exportFileName(title, format.extension), format.mimeType, payload);
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
    !!onStartRename ||
      !!onGoogleUpload ||
      !!onDuplicate ||
      canSave ||
      canDownload ||
      copyFormats.length > 0 ||
      !!onDelete,
  );
  const hasOutput = $derived(canSave || canDownload || copyFormats.length > 0);
</script>

<!-- Save and Download offer the same list of formats and differ only in where
     the file lands, so they render from one shape. A lone format stays a flat
     row: a submenu holding one item is a click that answers nothing. -->
{#snippet formatGroup(
  kind: "save" | "download",
  verb: string,
  formats: WorkExportFormat[],
  run: (format: WorkExportFormat) => Promise<void>,
)}
  {#snippet glyph()}
    {#if kind === "save"}<FolderIcon size={14} />{:else}<DownloadSimpleIcon size={14} />{/if}
  {/snippet}
  {#if formats.length === 1}
    <DropdownMenu.Item data-testid={`${kind}-work`} onSelect={() => void run(formats[0])}>
      {@render glyph()}
      <span class="flex-1 text-left">{verb} {formats[0].label}{kind === "save" ? "…" : ""}</span>
    </DropdownMenu.Item>
  {:else}
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger data-testid={`${kind}-work`}>
        {@render glyph()}
        <span class="flex-1 text-left">{verb}</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="w-auto min-w-40">
        {#each formats as format (format.extension)}
          <DropdownMenu.Item
            data-testid={`${kind}-work-${format.extension}`}
            onSelect={() => void run(format)}
          >
            {format.label}{kind === "save" ? "…" : ""}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  {/if}
{/snippet}

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
          <DotsThreeIcon size={14} weight="bold" />
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
      {#if onDuplicate}
        <DropdownMenu.Item data-testid="duplicate-work" onSelect={() => onDuplicate?.()}>
          <CopyIcon size={14} /><span class="flex-1 text-left">Duplicate</span>
        </DropdownMenu.Item>
      {/if}

      <!-- Everything that puts this work somewhere else lives in one block, so
           there is a single place to look for "how do I get this out". -->
      {#if hasOutput}
        <DropdownMenu.Separator />
        <DropdownMenu.Label>Save &amp; export</DropdownMenu.Label>
        {#if canSave}
          {@render formatGroup("save", "Save as", exportFormats, save)}
        {/if}
        {#if copyFormats.length > 0}
          {#if copyFormats.length === 1}
            <DropdownMenu.Item data-testid="copy-work-as" onSelect={() => void copyFormats[0].copy()}>
              <CopyIcon size={14} /><span class="flex-1 text-left">Copy as {copyFormats[0].label}</span>
            </DropdownMenu.Item>
          {:else}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger data-testid="copy-work-as">
                <CopyIcon size={14} /><span class="flex-1 text-left">Copy as</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent class="w-auto min-w-40">
                {#each copyFormats as format (format.id)}
                  <DropdownMenu.Item onSelect={() => void format.copy()}>{format.label}</DropdownMenu.Item>
                {/each}
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          {/if}
        {/if}
        {#if canDownload}
          {@render formatGroup("download", "Download", exportFormats, download)}
        {/if}
      {/if}

      {#if onDelete}
        <DropdownMenu.Separator />
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
      <SparkleIcon size={11} weight="fill" />
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
      <CaretDownIcon size={9} weight="bold" />
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
     with a single filled surface at the end of it.

     The dense chrome rung, not the standard one: this is a row of secondary
     verbs over a reading surface, and at the standard rung's 14px they matched
     the document's own type and read as loud as the prose they sit above. Dense
     is 12px wherever the pointer is precise — laptop and desktop alike — and
     returns to 14px on a touch client, so the row does not need a width query
     of its own to stay right on a laptop. */
  .wha-verb {
    flex-shrink: 0;
    height: 1.5rem;
    padding: 0 0.4375rem;
    border-radius: 0.375rem;
    font-family: inherit;
    font-size: var(--text-chrome-dense);
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
     filled surface in the cluster. Squared off on the input bar's radius: the
     app's controls are rounded rectangles, and a full pill here read as a
     different family of button from every other action the user presses. */
  .wha-solus {
    display: inline-flex;
    align-items: stretch;
    height: 1.5rem;
    /* Set apart from the verbs on its left and from the pane's floating chrome
       cluster on its right, so the row's one filled surface is not shouldered
       by either. */
    margin-left: 0.25rem;
    margin-right: 0.125rem;
    border-radius: 0.4375rem;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    overflow: hidden;
    transition:
      background var(--duration-quick) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }
  /* The same press response the input bar's pills give. */
  .wha-solus:active {
    scale: 0.96;
  }
  .wha-solus:hover,
  .wha-solus:has(.wha-solus-caret--open) {
    background: color-mix(in srgb, var(--solus-accent) 88%, black);
  }
  .wha-solus-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0 0.4375rem 0 0.5625rem;
    font-family: inherit;
    font-size: var(--text-chrome-dense);
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
    /* Wide enough that the caret has the same air on both sides of it as the
       label has against the button's left edge. */
    width: 1.25rem;
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
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
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
  /* Mobile: the header is the formatting strip, whose buttons are 40px touch
     targets — these have to match it or they read as a second, smaller row. */
  @media (max-width: 767px) {
    .wha-label {
      display: none;
    }
    .wha-verb,
    .wha-solus {
      height: 2.5rem;
    }
    .wha-verb {
      padding: 0 0.75rem;
      border-radius: 0.5rem;
    }
    .wha-overflow {
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.5rem;
    }
    .wha-solus {
      border-radius: 0.5rem;
    }
    .wha-solus-trigger {
      padding: 0 0.5rem 0 0.75rem;
    }
    .wha-solus-caret {
      width: 1.75rem;
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
