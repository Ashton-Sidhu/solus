<script lang="ts">
  import {
    Copy as CopyIcon,
    ChevronDown as CaretDownIcon,
    CloudUpload as CloudUploadIcon,
    Download as DownloadSimpleIcon,
    FileOutput as FileOutputIcon,
    Folder as FolderIcon,
    Pen as PencilSimpleIcon,
    MessageCircle as ChatCircleIcon,
    Trash2 as TrashIcon,
    Ellipsis as DotsThreeIcon,
    Users as UsersIcon,
  } from "@lucide/svelte";
  import WorkChatMenu from "./WorkChatMenu.svelte";
  import WorkPublishMenu from "./WorkPublishMenu.svelte";
  import ShareButton from "../sharing/ShareButton.svelte";
  import WorkHistoryDialog from "./WorkHistoryDialog.svelte";
  import WorkReviewControl from "./WorkReviewControl.svelte";
  import WorkPresence from "./WorkPresence.svelte";
  import { getWorkPaneContext } from "./lib/work-pane-context";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { getClientShellContext, getSurfaceContext, serversStore, sharesStore } from "../../contexts";
  import type { SessionMeta } from "@solus/contracts/types";
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
    /** When set, the header offers the work's History. */
    workId?: string;
    title?: string;
    currentContent?: string;
    getCurrentContent?: () => string;
    /** Every file the shell can write this work out as, in menu order. */
    exportFormats?: WorkExportFormat[];
    /** Additional clipboard formats in the overflow menu. */
    copyFormats?: WorkCopyFormat[];
    /**
     * Opens the save picker: on a chosen format for "Save as", or for the host
     * to write the stored work for "Export…". Absent when the work has no host
     * to write to, which hides both.
     */
    onExport?: (request: WorkExportRequest) => void;
    /**
     * True when the picker's filesystem is not this device's — the only case
     * where a browser download is a different outcome from saving.
     */
    hostIsRemote?: boolean;
    /** Delete the work (closes the pane + offers undo). When set, shows a Delete pill. */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    /** Flushes the editor before a publish reads its content. */
    flushSave?: () => Promise<void>;
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
    onDelete,
    onDuplicate,
    flushSave,
  }: Props = $props();

  const session = getSurfaceContext();
  const shell = getClientShellContext();

  let chatMenuOpen = $state(false);
  let chatButtonEl: HTMLDivElement | null = $state(null);

  // Overflow (⋯) menu holding the secondary / destructive actions.
  let overflowOpen = $state(false);

  const canSave = $derived(!!onExport && exportFormats.length > 0);
  // The host writes the work as it is stored, whatever the shell can encode.
  const canExport = $derived(!!onExport);
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

  // History: every checkpoint of the work, opened on the newest change.
  let historyOpen = $state(false);
  // Review needs the pane's draft version; a work shown outside a pane has none.
  const inWorkPane = !!getWorkPaneContext();
  const workType = $derived(workId ? session.worksStore.get(workId)?.type ?? session.worksStore.savedWork(workId)?.type ?? "doc" : "doc");
  const hasOutput = $derived(canSave || canExport || canDownload || copyFormats.length > 0);

  // Sharing (docs/plans/multiplayer-sharing.md §4.1): the work's host owns its share
  // list; the dialog is one per app, opened from here.
  const shareServerId = $derived(workId ? session.worksStore.hostFor(workId) ?? null : null);
  const shareResource = $derived(workId ? ({ kind: "work", id: workId } as const) : null);
  const canShare = $derived(!!shareServerId && !!shareResource && sharesStore.canShareFrom(shareServerId));
  // Publish into the window's organization (docs/plans/organization-scope.md §7):
  // offered on a work that lives on a machine while the window works in one.
  const organizationName = $derived(serversStore.activeOrganizationName ?? "your organization");
  const canPublish = $derived(!!workId && sharesStore.canPublishWork(shareServerId));
  const publishing = $derived(!!shareServerId && !!shareResource && sharesStore.isPublishing(shareServerId, shareResource));

  function openShare() {
    if (!shareServerId || !shareResource) return;
    sharesStore.open({ serverId: shareServerId, resource: shareResource, title });
  }
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

<!-- The header's own actions are all unfilled and all on one geometry — type
     where a word is the clearest name for it, a glyph where one is not. The
     row carries no call to action: these are the work's controls, and the
     surface under them is what the reader came for. -->
<div class="wha-actions">
<!-- History: every version of the work, persistent rather than buried in
     the overflow — it is one of the four things the header always keeps. -->
{#if workId}
  <button type="button" class="wha-verb" data-testid="view-changes" onclick={() => (historyOpen = true)} title="See every version of this work">
    History
  </button>
{/if}

<!-- Who else has this work open, and who edits it now. -->
{#if workId}
  <WorkPresence serverId={shareServerId} {workId} />
{/if}

<!-- Review: who reviews this work and what they decided. Guests who review
     through a link see it too, so it sits outside the workspace-only group. -->
{#if workId && inWorkPane}
  <WorkReviewControl {workId} {title} type={workType} currentContent={resolvedContent} />
{/if}

<!-- The upstream mirror, inline rather than in the overflow: once a document is
     linked, its sync state is something the reader has to be able to see, not
     something to go looking for. Renders only for docs (2a scope). -->
{#if workId && shell.canOpenResource("workspace")}
  <WorkPublishMenu {workId} {getCurrentContent} {flushSave} />
  <!-- A glyph on the ⋯ trigger's square geometry, so the two quiet header
       controls read as one pair. A scoped class would not reach the child, so
       that geometry is restated as utilities. -->
  <ShareButton serverId={shareServerId} resource={shareResource} {title} class="inline-flex size-[1.625rem] shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) pointer-coarse:size-10" />
{/if}

<!-- How to reach Solus. The chat circle is the app's mark for a session
     everywhere else it appears, so the button says what it opens; the tooltip
     and the aria-label carry the name. It sits with the work's own actions,
     ahead of ⋯ — "more actions" closes the row, it does not interrupt it. -->
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
      <ChatCircleIcon size={14} />
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

<!-- Layout, integration & destructive actions collapse into a single overflow menu. -->
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
      <DropdownMenu.Item data-testid="copy-work" onSelect={copy}>
        <CopyIcon size={14} /><span class="flex-1 text-left">{copied ? "Copied!" : "Copy"}</span>
      </DropdownMenu.Item>
      {#if onStartRename}
        <DropdownMenu.Item data-testid="rename-work" onSelect={() => onStartRename?.()}>
          <PencilSimpleIcon size={14} /><span class="flex-1 text-left">Rename</span>
        </DropdownMenu.Item>
      {/if}
      {#if onDuplicate}
        <DropdownMenu.Item data-testid="duplicate-work" onSelect={() => onDuplicate?.()}>
          <CopyIcon size={14} /><span class="flex-1 text-left">Duplicate</span>
        </DropdownMenu.Item>
      {/if}
      {#if canShare}
        <DropdownMenu.Item data-testid="share-work" onSelect={openShare}>
          <UsersIcon size={14} /><span class="flex-1 text-left">Share…</span>
        </DropdownMenu.Item>
      {/if}
      {#if canPublish}
        <DropdownMenu.Item data-testid="publish-work" disabled={publishing} onSelect={() => { if (shareServerId && workId) void sharesStore.publishWork(shareServerId, workId); }}>
          <CloudUploadIcon size={14} /><span class="flex-1 text-left">{publishing ? "Publishing…" : `Publish to ${organizationName}`}</span>
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
        {#if canExport}
          <DropdownMenu.Item data-testid="export-work" onSelect={() => onExport?.({ source: "host" })}>
            <FileOutputIcon size={14} /><span class="flex-1 text-left">Export…</span>
          </DropdownMenu.Item>
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
</div>

{#if workId && historyOpen}
  <WorkHistoryDialog bind:open={historyOpen} {workId} {title} type={workType} currentContent={resolvedContent} />
{/if}

<style>
  /* A header verb: unfilled type at the same metrics as the shell's own
     (Markdown/Editor) buttons, so the whole cluster reads as one row of words
     with a single filled surface at the end of it.

     Use the shared workspace rung so these actions match the shell title
     and controls on desktop and touch clients. */
  .wha-verb {
    flex-shrink: 0;
    height: 1.625rem;
    padding: 0 0.4375rem;
    border-radius: 0.375rem;
    font-family: inherit;
    font-size: var(--text-workspace-chrome);
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

  /* Reaching Solus is one of the work's actions, not a call to action, so it
     takes the same quiet treatment as Share and ⋯ beside it: transparent at
     rest, a hover wash, the row's shared height and radius. Its caret makes it
     two boxes rather than one, so the wash is painted on the group and both
     halves stay transparent — one control, not two abutting buttons. */
  .wha-solus {
    display: inline-flex;
    flex-shrink: 0;
    align-items: stretch;
    height: 1.625rem;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    overflow: hidden;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  .wha-solus:active {
    transform: scale(0.96);
  }
  .wha-solus:hover,
  .wha-solus:has(.wha-solus-caret--open) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  /* The square half, on the same box Share and ⋯ take, so the three glyphs sit
     on one rhythm across the row. */
  .wha-solus-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    padding: 0;
    background: transparent;
    color: inherit;
    border: none;
    cursor: pointer;
  }
  /* Narrower than the glyph it hangs off: a mode chooser attached to the
     action, not a second action of equal weight. No divider — unfilled, a rule
     between the two halves reads heavier than either of them. */
  .wha-solus-caret {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 0.875rem;
    padding: 0;
    background: transparent;
    color: inherit;
    border: none;
    cursor: pointer;
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  .wha-solus-caret--open {
    transform: rotate(180deg);
  }
  .wha-solus-trigger:focus-visible,
  .wha-solus-caret:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: -0.125rem;
  }
  /* Overflow (⋯) trigger — a verb like the rest, so it stays unfilled until hover. */
  .wha-overflow {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
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
      width: 2.5rem;
    }
    .wha-solus-caret {
      width: 1.25rem;
    }
  }
</style>
