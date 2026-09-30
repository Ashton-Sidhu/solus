<script lang="ts">
  import { liveStatus, type LiveStatusInput } from "../work/lib/live-status";
  import { Check as CheckIcon } from "@lucide/svelte";
  import type { SessionMeta } from "@solus/contracts/types";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import ParentPageCrumb from "../ui/list-page/ParentPageCrumb.svelte";
  import type { WorkCopyFormat, WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import { formatSavedAgo } from "../document-shell/saveStatus";
  import { toasts } from "../../lib/toasts";
  import type { DiagramSaver } from "./lib/diagram-save.svelte";

  interface Props {
    title: string;
    saver: DiagramSaver;
    /** A live diagram shows its live status instead of saves. */
    liveState?: LiveStatusInput | null;
    /** The saved text of the diagram as it is now. */
    currentText: () => string;
    /** The content the work was opened with. */
    content: string;
    workId?: string;
    onRename?: (title: string) => void;
    onOpenWorkspace?: () => void;
    onOpenChat?: (mode: "resume" | "new") => void;
    originalSessionMeta?: SessionMeta | null;
    onDelete?: () => void;
    onDuplicate?: () => void | Promise<void>;
    exportFormats: WorkExportFormat[];
    copyFormats: WorkCopyFormat[];
    onExport?: (request: WorkExportRequest) => void;
    hostIsRemote: boolean;
  }

  let {
    title,
    saver,
    liveState = null,
    currentText,
    content,
    workId,
    onRename,
    onOpenWorkspace,
    onOpenChat,
    originalSessionMeta,
    onDelete,
    onDuplicate,
    exportFormats,
    copyFormats,
    onExport,
    hostIsRemote,
  }: Props = $props();

  // Click-to-rename (mirrors DocumentShell). Only the root title is editable.
  let renaming = $state(false);
  let renameValue = $state("");
  function startRename() {
    renameValue = title;
    renaming = true;
  }
  function commitRename() {
    if (!renaming) return;
    renaming = false;
    const next = renameValue.trim();
    if (next && next !== title) onRename?.(next);
  }
  function renameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.currentTarget instanceof HTMLInputElement) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renaming = false;
    }
  }

  let copied = $state(false);
  function copyDiagram() {
    navigator.clipboard
      .writeText(currentText())
      .then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1800);
      })
      .catch(() => toasts.error("Copy failed"));
  }

  // A slow clock keeps "Saved 2m ago" honest.
  let now = $state(Date.now());
  $effect(() => {
    if (saver.lastSavedAt === null) return;
    now = saver.lastSavedAt;
    const interval = setInterval(() => (now = Date.now()), 10_000);
    return () => clearInterval(interval);
  });
</script>

<!-- De-chromed control strip: no border, no chrome-row height. The crumb
     says which page the diagram lives in and takes the reader back; its leaf
     is the title, which is otherwise the tab label's job. The pane's close /
     split / maximize live in the floating PaneChrome cluster, which this row
     reserves room for on its right. -->
<div class="diagram-shell__toolbar workspace-titlebar">
  {#if onOpenWorkspace}
    <!-- The optical inset pulls a *word* back onto the row's edge. A chevron
         is already centred in its own 44px box, so the rung gives it back. -->
    <span class="-ml-[7px] flex shrink-0 items-center @max-[30rem]/pane:ml-0">
      <ParentPageCrumb page="folio" onOpen={onOpenWorkspace} />
    </span>
  {/if}
  {#if renaming}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="diagram-shell__title-input"
      bind:value={renameValue}
      onblur={commitRename}
      onkeydown={renameKeydown}
      autofocus
      aria-label="Rename diagram"
      data-testid="rename-work-input"
    />
  {:else if onOpenWorkspace}
    <span
      class="min-w-0 truncate text-workspace-chrome font-medium text-(--solus-text-primary)"
      title={title}>{title}</span
    >
  {/if}
  <div class="diagram-shell__toolbar-spacer"></div>
  <div class="diagram-shell__save-status">
    {#if liveState}
      {@const status = liveStatus(liveState)}
      <span class="diagram-shell__save-dot" class:opacity-0={status.tone === "ok"} aria-hidden="true"></span>
      <span data-testid="live-status">{status.label}</span>
    {:else if saver.showSaving}
      <span class="diagram-shell__save-dot" aria-hidden="true"></span>
      <span>Saving…</span>
    {:else if saver.saveFailed}
      <button
        type="button"
        class="diagram-shell__save-retry"
        onclick={() => saver.retry()}
        title={saver.saveError
          ? `${saver.saveError} Click to retry.`
          : "The last save failed — click to retry"}
      >
        Save failed — retry
      </button>
    {:else if saver.lastSavedAt !== null}
      <CheckIcon size={11} />
      <span>{formatSavedAgo(saver.lastSavedAt, now)}</span>
    {/if}
  </div>
  <WorkHeaderActions
    {onOpenChat}
    onStartRename={onRename ? startRename : undefined}
    {originalSessionMeta}
    {copied}
    copy={copyDiagram}
    {workId}
    {title}
    currentContent={content}
    getCurrentContent={currentText}
    {onDelete}
    {onDuplicate}
    {exportFormats}
    {copyFormats}
    {onExport}
    {hostIsRemote}
  />
</div>
